import { spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRecord, inFlight, readCycles, snapshot, type CycleRecord } from './ledger.ts';
import { decide, type Decision } from './decide.ts';
import { isOnboarding, readReport, runCycle } from './cycle.ts';
import { PaneBusy } from './herdr.ts';
import { listNotes, readAsks, replyToNote, resolveNote, type NoteThread } from './asks.ts';
import { nudgeIfNeglected, textCraig } from './nudge.ts';
import { unansweredAsks } from './ledger.ts';

import { poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, readControl, type Program } from './control.ts';
import {
  MAX_INTENTS_PER_TICK,
  isIntent,
  parseIntent,
  type Action as IntentAction,
} from './intents.ts';
import {
  adjustConcurrency,
  nudgePriority,
  nudgeReserve,
  pauseForHours,
  setEnabled,
  setMode,
} from './keys.ts';
import { acquire, holder, release } from './lock.ts';
import { ensureDirs, paths } from './paths.ts';
import { readStatus } from './teamclaude.ts';
import { renderStatus } from './render.ts';
import { publishStatus } from './publish.ts';
import { DROVR_REPO } from './publish-snapshot.ts';

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const logDecision = (program: string, decision: Decision, now: number): void => {
  appendRecord(paths().decisions, {
    v: 1,
    at: new Date(now).toISOString(),
    program,
    verdict: decision.verdict,
    reason: decision.reason,
    pool: decision.pool === null ? null : snapshot(decision.pool),
    cyclesFundable: decision.cyclesFundable,
  });
};

const writeStatusPage = async (
  program: Program,
  decision: Decision,
  cycles: CycleRecord[],
  now: number,
  note?: string,
): Promise<void> => {
  ensureDirs(program.name);
  const html = renderStatus({
    program: program.name,
    decision,
    recent: cycles.slice(-10).reverse(),
    renderedAt: now,
    ...(note === undefined ? {} : { note }),
  });
  const file = paths().statusPage(program.name);
  writeFileSync(file, html, 'utf8');
  await publishStatus(program, file);
};

/**
 * Cycles run for hours, so tick must not await them: it hands each admitted
 * program to a detached `drovr run-cycle`, which owns that program's lock and
 * ledger entries. Tick itself returns in seconds so the next launchd firing can
 * evaluate the other programs.
 */
export const launchDetached = (name: string): void => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const logPath = join(paths().logs, `${name}-worker.log`);
  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, [cli, 'run-cycle', name], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  console.log(`${name}: launched cycle (pid ${child.pid}, log ${logPath})`);
};

const launch = (program: Program): void => launchDetached(program.name);

/**
 * A worker takes its program lock before writing its start record, so an in-flight
 * cycle whose lock no longer has a live holder is definitively over — its worker was
 * killed before it could write an end record. Closing those out here means a crash
 * never leaves a program blocked behind a phantom cycle.
 */
const reconcileAbandoned = (now: number): number => {
  const p = paths();
  const abandoned = inFlight(readCycles(p.cycles), now).filter(
    (cycle) => holder(p.programLock(cycle.program)) === null,
  );

  for (const cycle of abandoned) {
    appendRecord(p.cycles, {
      ...cycle,
      endedAt: new Date(now).toISOString(),
      exit: 'crash',
      poolAfter: cycle.poolBefore,
    });
    console.error(
      `${cycle.program}: cycle started ${cycle.startedAt} had no running worker — closed as crashed`,
    );
  }
  return abandoned.length;
};

/**
 * The panel's companion inbox, and the only page drovr reads intents from. It is a
 * separate page because the panel is custom HTML with no `<aice-page>` shell, so it
 * never loads the notes widget — and the widget is the only place a note can be
 * written or sharing switched on. One page, so a control-file field would be
 * surface nothing reads.
 */
const PANEL_PAGE = 'craig/intents.html';

/**
 * Only this slug's own threads are applied. The page's default visibility is the
 * whole adam11.ca tenant, so without this any reader who can open it could set
 * `mode off` or `pause 72h` on Craig's supervisor.
 */
const PANEL_OWNER = 'craig';

/** Wall-clock ceiling on one drain. The count cap bounds aice calls, not seconds. */
const DRAIN_BUDGET_MS = 60_000;

/** The whole intent -> writer routing. Exported so the six-way dispatch is covered
 *  against a real control file rather than only through the notes I/O around it. */
export const applyIntent = (controlPath: string, action: IntentAction): string => {
  if (action.kind === 'mode') return setMode(controlPath, action.value).message;
  if (action.kind === 'pause') return pauseForHours(controlPath, action.hours).message;
  if (action.kind === 'reserve') return nudgeReserve(controlPath, action.delta).message;
  if (action.kind === 'concurrency') return adjustConcurrency(controlPath, action.delta).message;
  if (action.kind === 'enable') {
    return setEnabled(controlPath, action.program, action.enabled).message;
  }
  return nudgePriority(controlPath, action.program, action.delta).message;
};

type Answer = { outcome: 'applied' | 'rejected'; message: string };

/**
 * The one place an intent reaches control.json. Named for the write it performs
 * rather than for the string it returns, and called as a statement of its own so
 * the side effect is visible at the call site instead of buried in an expression.
 *
 * A refusal — a stranger's thread, or a setter saying no — is Craig's answer, not
 * a tick failure, so it comes back as the text to reply with.
 */
const applyAndAnswer = (controlPath: string, author: string, action: IntentAction): Answer => {
  if (author !== PANEL_OWNER) {
    return {
      outcome: 'rejected',
      message:
        `not applied: only ${PANEL_OWNER} can send intents from this page, ` +
        `and this thread is ${author}'s`,
    };
  }
  try {
    return { outcome: 'applied', message: `applied: ${applyIntent(controlPath, action)}` };
  } catch (error) {
    return { outcome: 'rejected', message: `not applied: ${explain(error)}` };
  }
};

/**
 * The reply is the last step and the only one allowed to fail quietly: by the time
 * it runs the thread is resolved and the change is made, so a failure costs Craig
 * the explanation on the page, not the outcome. It still has to reach the log.
 */
const answerThread = async (threadId: string, message: string): Promise<void> => {
  await replyToNote(DROVR_REPO, PANEL_PAGE, threadId, message).catch((error: unknown) => {
    console.error(
      `panel intent ${threadId}: ${message} — but the thread got no reply ` +
        `(${explain(error)}). It is resolved, so it will not be retried and Craig will not ` +
        'see this on the page.',
    );
  });
};

/**
 * Resolve, then apply, then reply — in that order, and the order is the whole
 * point. Resolving first is what makes an intent at-most-once: the process can die
 * anywhere after it, or the reply can fail, and the worst outcome is an
 * instruction lost with a line in the log. Applying first would leave the thread
 * open on any later failure, and the next tick would rewrite `pause 3h` to another
 * three hours from then — a supervisor paused indefinitely, silently.
 */
const drainThread = async (
  controlPath: string,
  thread: NoteThread,
  now: number,
): Promise<'applied' | 'rejected'> => {
  const parsed = parseIntent(thread.text, thread.id, now);

  await resolveNote(DROVR_REPO, PANEL_PAGE, thread.id);

  if ('rejected' in parsed) {
    await answerThread(thread.id, `not applied: ${parsed.rejected}`);
    return 'rejected';
  }

  const answer = applyAndAnswer(controlPath, thread.author, parsed.action);
  await answerThread(thread.id, answer.message);
  return answer.outcome;
};

/**
 * The at-most-once guarantee rests on a resolve that did not throw having actually
 * persisted, and this repo's own asks.ts trap says an aice write's exit code is not
 * proof of that. So check rather than assume: one extra list, only when something
 * was drained, turning a silent assumption into a line in the log.
 */
const confirmResolved = async (drained: string[]): Promise<void> => {
  const listing = await listNotes(DROVR_REPO, PANEL_PAGE);
  const stillOpen = listing.threads.filter(
    (thread) => !thread.resolved && drained.includes(thread.id),
  );
  if (stillOpen.length === 0) return;
  console.error(
    `panel intents: ${stillOpen.length} thread(s) reported themselves resolved but are still ` +
      `open (${stillOpen.map((thread) => thread.id).join(', ')}). The next tick will drain them ` +
      'again, so an intent already applied may repeat until its expires= stamp lapses.',
  );
};

/** `capped` is "more was queued than this tick got through", whatever the reason —
 *  the count cap, the clock, or a thread that could not be claimed. */
export type Drained = { applied: number; rejected: number; capped: boolean };

const capReason = (queued: number, batched: number, timedOut: boolean): string => {
  if (batched < queued) return `capped at ${MAX_INTENTS_PER_TICK} a tick`;
  if (timedOut) return `stopped after ${DRAIN_BUDGET_MS / 1000}s`;
  return 'could not claim every thread';
};

/**
 * Applies the intents a human left on the panel. Bounded by both a count and a
 * clock, and a page whose owner has not enabled shared notes reads as an empty,
 * healthy page — so that case is reported as unreadable, not as nothing to do.
 */
export const drainIntents = async (now = Date.now()): Promise<Drained> => {
  const controlPath = paths().control;
  const listing = await listNotes(DROVR_REPO, PANEL_PAGE);
  if (!listing.shared) {
    console.error(
      `panel intents unreadable: shared notes are off for ${PANEL_PAGE}, so no intent can be ` +
        'seen, applied or refused. Turn sharing on from the notes widget on that page.',
    );
    return { applied: 0, rejected: 0, capped: false };
  }

  // Only intent-shaped threads compete for the batch. Ordinary comments are never
  // resolved and aice lists oldest first, so counting them would let a page's first
  // twenty conversations fill the batch forever and starve every intent behind them.
  const queue = listing.threads.filter((thread) => !thread.resolved && isIntent(thread.text));
  const batch = queue.slice(0, MAX_INTENTS_PER_TICK);
  const startedAt = Date.now();
  const drained: string[] = [];
  let applied = 0;
  let rejected = 0;
  let timedOut = false;

  for (const thread of batch) {
    if (Date.now() - startedAt >= DRAIN_BUDGET_MS) {
      timedOut = true;
      break;
    }
    // A throw here is the resolve failing, which is the one path that applies
    // nothing: the thread stays open and the next tick sees it again.
    const outcome = await drainThread(controlPath, thread, now).catch((error: unknown) => {
      console.error(
        `panel intent ${thread.id} was not claimed, so nothing was applied — it stays open ` +
          `for the next tick: ${explain(error)}`,
      );
      return null;
    });
    if (outcome === null) continue;
    drained.push(thread.id);
    if (outcome === 'applied') applied += 1;
    else rejected += 1;
  }

  if (drained.length > 0) {
    await confirmResolved(drained).catch((error: unknown) => {
      console.error(`panel intents: could not confirm the resolves landed (${explain(error)})`);
    });
  }

  const left = queue.length - drained.length;
  if (left > 0) {
    const why = capReason(queue.length, batch.length, timedOut);
    console.error(`panel intents ${why}; ${left} left for the next tick`);
  }
  return { applied, rejected, capped: left > 0 };
};

export const tick = async (): Promise<void> => {
  const p = paths();
  ensureDirs();
  if (!acquire(p.tickLock)) {
    console.log('another tick is still evaluating');
    return;
  }

  try {
    const now = Date.now();
    // Before admission, not after: an intent changes the very inputs decide() reads.
    // A notes outage must never stop a cycle starting, so it is reported and passed.
    const drained = await drainIntents(now).catch((error: unknown) => {
      console.error(
        `panel intents not drained: ${explain(error)}. Admission continues as configured.`,
      );
      return null;
    });
    if (drained !== null && drained.applied + drained.rejected > 0) {
      console.log(`panel intents: ${drained.applied} applied, ${drained.rejected} refused`);
    }

    const control = readControl(p.control);
    const status = await readStatus();
    reconcileAbandoned(now);

    // Workers write their own start record, so within one tick the earlier launches
    // are not yet visible in the ledger. Without tracking them here the concurrency
    // cap and capacity reservations would not apply until the next tick, and every
    // program would be admitted at once.
    const launched: CycleRecord[] = [];

    for (const program of byPriority(control.programs, now, control.deadlineHorizonDays).filter(
      (entry) => entry.enabled,
    )) {
      const cycles = [...readCycles(p.cycles), ...launched];
      const mine = cycles.filter((cycle) => cycle.program === program.name);
      const owed = unansweredAsks(mine);

      // Only poll the asks page for a program that is actually waiting on one.
      const asks = owed === null ? null : await readAsks(program);
      if (owed !== null) {
        await nudgeIfNeglected({
          program: program.name,
          asks: owed.asks,
          askedAt: owed.at,
          now,
          afterMinutes: control.nudgeAfterMinutes,
          phoneNumber: control.phoneNumber,
          asksUrl: null,
        });
      }

      const decision = decide({
        status,
        control,
        cycles,
        program: program.name,
        now,
        answeredAt: asks?.latestAt ?? null,
        asksShared: asks?.shared ?? null,
      });
      logDecision(program.name, decision, now);
      console.log(`${program.name}: ${decision.verdict} — ${decision.reason}`);

      if (decision.verdict !== 'GO' || decision.pool === null) {
        const mine = cycles.filter((cycle) => cycle.program === program.name);
        await writeStatusPage(program, decision, mine, now);
        continue;
      }
      launch(program);
      launched.push({
        v: 1,
        kind: 'delivery',
        program: program.name,
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        exit: 'running',
        poolBefore: snapshot(decision.pool),
        poolAfter: null,
        startupTokens: null,
        yield: null,
        asksRaised: 0,
      });
    }
  } finally {
    release(p.tickLock);
  }
};

/** What a cycle that never wrote a report is recorded as. */
const unreportedExit = (deferred: boolean, stalled: boolean): CycleRecord['exit'] => {
  if (deferred) return 'deferred';
  if (stalled) return 'stalled';
  return 'crash';
};

/** The detached per-program worker. Holds the program lock for the cycle's whole life. */
export const runProgramCycle = async (name: string): Promise<void> => {
  const p = paths();
  ensureDirs(name);
  const lock = p.programLock(name);
  if (!acquire(lock)) {
    console.error(`a cycle for ${name} is already running (pid ${holder(lock)})`);
    process.exitCode = 1;
    return;
  }

  try {
    const control = readControl(p.control);
    const program = control.programs.find((entry) => entry.name === name);
    if (program === undefined) throw new Error(`no program named "${name}" in ${p.control}`);

    const ceilings = ceilingsFor(control);
    if (ceilings === null) throw new Error('mode is off');

    const startedAt = new Date().toISOString();
    const kind = isOnboarding(name) ? 'onboarding' : 'delivery';
    const before = snapshot(poolFrom(await readStatus(), ceilings, Date.now()));

    const record = (extra: Partial<CycleRecord>): void => {
      appendRecord(p.cycles, {
        v: 1,
        kind,
        program: name,
        startedAt,
        endedAt: null,
        exit: 'running',
        poolBefore: before,
        poolAfter: null,
        startupTokens: null,
        yield: null,
        asksRaised: 0,
        ...extra,
      });
    };

    record({});

    // Anything between the start record and the end record can throw — a missing
    // binary, a herdr error, a lost workspace. Without an end record the cycle stays
    // "in flight" forever, blocking its own program and holding a concurrency slot.
    const limits = {
      maxHours: control.maxCycleHours,
      stallNudgeMs: control.stallNudgeMinutes * 60_000,
      maxStallNudges: control.maxStallNudges,
    };
    const outcome = await runCycle(program, startedAt, limits).catch(
      (error: unknown) => {
        const detail = explain(error);
        // A busy pane is not a failure: the cycle never started and nothing is wrong.
        if (error instanceof PaneBusy) {
          console.log(`${name}: ${detail}`);
          return { finished: false, detail, deferred: true as const };
        }
        console.error(`cycle for ${name} failed to run: ${detail}`);
        return { finished: true, detail };
      },
    );

    const deferred = 'deferred' in outcome && outcome.deferred === true;
    const stalled = 'stalled' in outcome && outcome.stalled === true;

    const report = readReport(name);
    const after = snapshot(poolFrom(await readStatus(), ceilings, Date.now()));

    record({
      endedAt: new Date().toISOString(),
      exit: report?.exit ?? unreportedExit(deferred, stalled),
      poolAfter: after,
      startupTokens: report?.startupTokens ?? null,
      yield: report?.yield ?? null,
      asksRaised: report?.asksRaised ?? 0,
    });

    // A stalled runner was nudged and stayed silent, so Craig is the only one left
    // who can tell whether the program is wedged or simply had nothing to say.
    if (stalled) {
      console.error(`cycle for ${name} stalled — recorded as stalled. ${outcome.detail}`);
      await textCraig(
        control.phoneNumber,
        `drovr: ${name} stalled — its runner idled through ${control.maxStallNudges} nudges ` +
          `without writing a report. Its pane is free and the next tick starts a fresh cycle.`,
      );
    }

    if (report === null && !deferred && !stalled) {
      console.error(
        `cycle for ${name} produced no report — recorded as crash. ${outcome.detail}`,
      );
      const cycles = readCycles(p.cycles).filter((cycle) => cycle.program === name);
      const decision = decide({
        status: await readStatus(),
        control,
        cycles: readCycles(p.cycles),
        program: name,
        now: Date.now(),
      });
      await writeStatusPage(
        program,
        decision,
        cycles,
        Date.now(),
        'Last cycle ended without a report — treated as a crash.',
      );
    }
  } finally {
    release(lock);
  }
};

export const inFlightCycles = (): CycleRecord[] => inFlight(readCycles(paths().cycles));
