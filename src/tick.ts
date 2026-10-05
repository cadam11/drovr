import { spawn } from 'node:child_process';
import { existsSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRecord, inFlight, lastCycleReported, latestEnds, readCycles, snapshot, stampTick, type CycleRecord } from './ledger.ts';
import { decide, fullReason, type Decision } from './decide.ts';
import { isOnboarding, readReport, resumeCycle, runCycle, type CycleReport } from './cycle.ts';
import { PaneBusy, releaseLeftover, runnerIsPresent } from './orca.ts';
import { readAsks } from './asks.ts';
import { nudgeIfNeglected, textCraig } from './nudge.ts';
import { unansweredAsks } from './ledger.ts';

import { poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, readControl, type Control, type Program } from './control.ts';
import { acquire, heldBy, holder, release } from './lock.ts';
import { ensureDirs, paths } from './paths.ts';
import { readStatus, type TeamclaudeStatus } from './teamclaude.ts';
import { appendSample, sampleUsage } from './usage.ts';
import { closingMessage } from './transcript.ts';
import { randomUUID } from 'node:crypto';

const explain = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Both tick-side readers of last-cycle.json must make progress past a malformed file:
 * `readReport` throws on one, and here that throw would land in the middle of a pass.
 * Logged to the tick log and read as absent — never swallowed, never fatal.
 */
const readReportOrWarn = (program: string): CycleReport | null => {
  try {
    return readReport(program);
  } catch (error) {
    console.error(`ignoring unreadable cycle report for ${program}: ${explain(error)}`);
    return null;
  }
};

const logDecision = (program: string, decision: Decision, now: number): void => {
  appendRecord(paths().decisions, {
    v: 1,
    at: new Date(now).toISOString(),
    program,
    verdict: decision.verdict,
    // Recombined: each log line is read alone, so it carries the pool context the
    // multi-program renderers deliberately print only once.
    reason: fullReason(decision),
    pool: decision.pool === null ? null : snapshot(decision.pool),
    cyclesFundable: decision.cyclesFundable,
  });
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
 * What to do about an in-flight cycle whose worker is dead. The runner is an interactive
 * session that outlives its watcher, so a dead lock says nothing about the cycle: while the
 * runner is there a new watcher is attached to it; once it is gone the record is closed as
 * `abandoned` — drovr stopped looking, which is not a claim that nothing was delivered —
 * and a report it left behind is reconciled right after. Unknown is left alone: a watcher
 * re-attached while orca is unreachable could not see the runner either.
 */
export const orphanAction = (runnerPresent: boolean | undefined): 'reattach' | 'close' | 'skip' => {
  if (runnerPresent === undefined) return 'skip';
  return runnerPresent ? 'reattach' : 'close';
};

/**
 * A worker takes its program lock before writing its start record, so an in-flight cycle
 * whose lock has no live holder has lost its worker. Measured 2026-09-12: a `run-cycle`
 * killed 37 minutes into a healthy cycle left its runner working for hours with nothing
 * watching, and closing that as `crash` would have latched the program and thrown away the
 * report. The worker it launches here resumes the open record rather than opening another.
 *
 * `maxCycleHours` is passed rather than left to inFlight's own 24h default: with the
 * default at 24 and the setting at 12 this closes out more cycles than decide() still
 * counts, which is harmless — but it inverts the moment maxCycleHours goes above 24,
 * and then an orphaned cycle is never closed and blocks its program permanently.
 */
const reconcileAbandoned = async (now: number, control: Control, status: TeamclaudeStatus): Promise<void> => {
  const p = paths();
  const orphaned = inFlight(readCycles(p.cycles), now, control.maxCycleHours).filter(
    (cycle) => holder(p.programLock(cycle.program)) === null,
  );
  const ceilings = ceilingsFor(control);
  const poolNow = ceilings === null ? null : snapshot(poolFrom(status, ceilings, now));

  for (const cycle of orphaned) {
    const action = orphanAction(await runnerStillThere(cycle.program));
    const opened = `${cycle.program}: cycle started ${cycle.startedAt} has no watcher`;
    if (action === 'skip') {
      console.error(`${opened} and orca cannot say whether its runner is alive — left open until it can`);
      continue;
    }
    if (action === 'reattach') {
      console.log(`${opened} but its runner is still there — attaching a new one`);
      launchDetached(cycle.program);
      continue;
    }
    appendRecord(p.cycles, {
      ...cycle,
      endedAt: new Date(now).toISOString(),
      exit: 'abandoned',
      poolAfter: poolNow ?? cycle.poolBefore,
    });
    console.error(`${opened} and no runner — closed as abandoned; a report it left is reconciled next`);
  }
};

/**
 * Supersede an abandoned cycle's record with the report the runner wrote after drovr
 * stopped watching it.
 *
 * This is the other half of `abandoned`. Recording that drovr stopped looking is honest
 * but it is not the outcome, and the outcome usually arrives minutes later: a runner given
 * up on at 12h that finishes at 12h20m writes its report to a file nothing was reading.
 * Without this the ledger keeps a permanent "delivery unknown" for a cycle that plainly
 * delivered, its yield is lost, and its real cost never reaches the estimate.
 *
 * Appended, never rewritten. History stays append-only, so `latestEnds` is what makes the
 * later record the operative one — and that is why every measurement in ledger.ts reads
 * through it rather than over the raw file.
 *
 * Narrow on purpose, and safe because of `clearReport`: it fires only for a program whose
 * most recent record is `abandoned`, and `runCycle` deletes the report file before every
 * attempt, so a report sitting there now can only have been written by that cycle. It runs
 * before admission for the same reason — the next cycle's `clearReport` would delete the
 * evidence.
 */
const reconcileLateReports = (now: number): number => {
  const p = paths();
  const cycles = readCycles(p.cycles);
  const control = readControl(p.control);
  let superseded = 0;

  for (const program of control.programs) {
    const mine = latestEnds(cycles).filter((cycle) => cycle.program === program.name);
    const last = mine.at(-1);
    if (last?.exit !== 'abandoned') continue;

    // A malformed leftover file must cost this program's reconciliation, never the tick:
    // everything after this point — admission included — would otherwise stop until
    // someone deleted the file by hand.
    const report = readReportOrWarn(program.name);
    if (report === null) continue;

    appendRecord(p.cycles, {
      ...last,
      endedAt: new Date(now).toISOString(),
      exit: report.exit,
      startupTokens: report.startupTokens,
      yield: report.yield,
      asksRaised: report.asksRaised,
      pauseUntil: report.pauseUntil,
      closing: last.sessionId === null ? null : closingMessage(last.sessionId),
    });
    superseded += 1;
    console.log(
      `${program.name}: cycle started ${last.startedAt} reported "${report.exit}" after drovr ` +
        'stopped watching — record superseded, its yield and cost now count',
    );
  }
  return superseded;
};

/**
 * Presence for decide(), after releasing whatever `leftoverAction` says is safe: a runner
 * of a cycle in flight is that cycle's, and anything else is left for Craig. Holding a
 * program on a leftover that reported made `drovr release` a daily chore — 100 to 250
 * held ticks a day from 2026-09-23.
 */
const runnerAfterLeftover = async (
  program: string,
  mine: CycleRecord[],
  cycleInFlight: boolean,
): Promise<boolean | undefined> => {
  const present = await runnerStillThere(program);
  if (present !== true || cycleInFlight) return present;
  try {
    if (!(await releaseLeftover(program, lastCycleReported(mine)))) return true;
  } catch (error) {
    console.error(`${program}: could not release its leftover runner (${explain(error)})`);
    return true;
  }
  console.log(`${program}: released the runner its last cycle left behind`);
  return false;
};

/**
 * Whether an orca runner for this program is still present, for decide()'s leftover-pane
 * gate. Undefined rather than false when orca cannot be reached: "no agent" and "no
 * answer" are different facts, and only the first may refuse a cycle.
 */
const runnerStillThere = async (program: string): Promise<boolean | undefined> => {
  try {
    return await runnerIsPresent(program);
  } catch (error) {
    console.error(
      `${program}: could not read its runner's state (${explain(error)}) — ` +
        'admission proceeds as if there were none.',
    );
    return undefined;
  }
};

/**
 * A hard wall-clock ceiling on one pass, and the thing that makes the tick lock
 * impossible to hold forever.
 *
 * Bounding every subprocess (see exec.ts) removes the causes of a wedge that were known
 * about. This removes the *consequence* of one that was not: a pass that overruns
 * releases its own lock, says so, and exits non-zero, so the next launchd firing finds a
 * free lock rather than a live process holding one and logging
 * `another tick is still evaluating` forever while admission silently stops.
 *
 * The holder self-terminating is deliberately the only way this clears. `lock.ts` will
 * not reclaim a lock from a live holder, because two concurrent ticks would race the
 * ledger and double-launch cycles — a supervisor that quietly does a thing twice is
 * worse than one that has stopped and said so.
 *
 * `process.exit` from a timer, rather than a flag some later `await` checks: an overrun is
 * by definition a pass that is not reaching its next check. The timer still fires because
 * a pass blocked on a subprocess is blocked on I/O, not on the event loop. `finally` does
 * not run on exit, so the release is explicit here and must stay that way.
 *
 * The default is 8 minutes against a 600s schedule: comfortably longer than any healthy
 * pass (a real one measures around 8s; the per-program aice calls and the status publish
 * are bounded at 20-60s each), and short enough that at most one firing is skipped. `control.tickBudgetMinutes` moves it, because the cost of getting it
 * wrong is asymmetric — too loose only delays recovery, too tight aborts healthy passes.
 */
const tickBudgetMs = (control: Control): number => control.tickBudgetMinutes * 60_000;

/**
 * Minutes, until a minute is the wrong unit — the same rule decide.ts's untilText follows.
 * "held 0m" for a ten-second hold and "overran 1m" for a thirty-second budget are both
 * the report contradicting the number it was given.
 */
const durationText = (ms: number): string =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

/**
 * An unattended supervisor that has stopped needs to say so somewhere Craig will see at
 * 4am, and stdout under launchd is not that place. Best-effort on every path — reading the
 * control file can throw, and this runs *after* the lock is already free.
 */
const notifyOverrun = async (controlPath: string, message: string): Promise<void> => {
  try {
    const control = readControl(controlPath);
    await textCraig(control, message);
  } catch (error) {
    console.error(`could not text the overrun: ${explain(error)}`);
  }
};

/**
 * Everything the watchdog does except exit, split out so the part that matters is
 * testable: `process.exit` cannot be exercised in-process, and the release is the whole
 * point. Returns the message it reported.
 *
 * The order is the guarantee. Freeing the lock is the job and nothing after it may
 * prevent it, so the release comes first and each later step is separately guarded. An
 * earlier draft read `control.json` for the phone number *before* releasing — a malformed
 * control file would then have thrown inside the timer and left the lock held, which is
 * precisely the state this exists to end.
 */
export const releaseOverrunningTick = async (
  lockPath: string,
  controlPath: string,
  budgetMs: number,
): Promise<string> => {
  const message =
    `drovr: a tick overran ${durationText(budgetMs)} and was aborted ` +
    `(pid ${process.pid}). Its lock is released, so the next firing runs. ` +
    'Check ~/.drovr/logs/tick.err.';
  console.error(message);

  try {
    release(lockPath);
  } catch (error) {
    console.error(`could not release the tick lock: ${explain(error)}`);
  }

  await notifyOverrun(controlPath, message);
  return message;
};

/**
 * What a failed pass says on a lock screen. One line, because that is all a lock screen
 * gives: what stopped, what it costs, and the literal command that shows the rest. A
 * status-shape failure's own message is multi-line JSON, so only its first line survives.
 */
export const failedTickText = (error: unknown): string => {
  const [first = ''] = explain(error).split('\n');
  return (
    `drovr: a tick failed, so no program can start until one completes — ${first.slice(0, 140)} ` +
    'See it: tail -40 ~/.drovr/logs/tick.err'
  );
};

/**
 * Writes the episode marker, and answers whether this failure *began* the episode.
 *
 * Once per episode, never once per tick: launchd fires every ten minutes, so an outage
 * lasting an afternoon would otherwise be an afternoon of texts. The marker is removed by
 * the next pass that completes — the same event that stamps last-tick.json — so the next
 * outage alerts again.
 */
export const recordTickFailure = (markerPath: string, at: number, error: unknown): boolean => {
  if (existsSync(markerPath)) return false;
  const noted = { at: new Date(at).toISOString(), reason: explain(error) };
  writeFileSync(markerPath, `${JSON.stringify(noted)}\n`, 'utf8');
  return true;
};

export const clearTickFailure = (markerPath: string): void => rmSync(markerPath, { force: true });

/**
 * `tick()` plus the alert a failed pass owes Craig. Measured 2026-09-14: five consecutive
 * passes died on a teamclaude payload and drovr decided nothing for an hour, the only
 * trace a line in tick.err that nobody reads until they already suspect a problem. The
 * watchdog covers a pass that runs too *long*; nothing covered one that does not run.
 *
 * Wrapped around `tick()` rather than caught inside it so the tick lock is already
 * released before the send: textCraig is bounded at 30s, and holding the lock across it
 * would make every alert delay the next firing. Rethrown, so the exit code still fails
 * and tick.err still gets the stack — this reports the failure, it does not absorb it.
 */
export const runTick = async (): Promise<void> => {
  const p = paths();
  try {
    await tick();
  } catch (error) {
    if (recordTickFailure(p.tickFailure, Date.now(), error)) {
      try {
        const control = readControl(p.control);
        const sent = await textCraig(control, failedTickText(error));
        // "accepted", never "delivered": SNS returns a MessageId for texts that fail a
        // minute later. The point of the line is that tick.err records drovr having tried
        // to speak — the failure this exists for is the one nothing said anything about.
        console.error(
          sent.sent
            ? `alerted the failed tick: accepted via ${sent.via}.`
            : 'could not alert the failed tick: neither slack nor SMS took it (see above).',
        );
      } catch (alertError) {
        console.error(`could not alert the failed tick: ${explain(alertError)}`);
      }
    }
    throw error;
  }
};

export const tick = async (): Promise<void> => {
  const p = paths();
  ensureDirs();
  if (!acquire(p.tickLock)) {
    // Naming the age is the difference between "busy" and "wedged". Held longer than a
    // pass can legitimately take means the holder is stuck and its own watchdog has not
    // fired — the one state nothing here can resolve, so it is reported loudly.
    //
    // One read, not three: the holder can change between them, and a message naming a pid
    // that no longer holds the lock is worse than one naming none.
    const held = heldBy(p.tickLock);
    const heldMs = held === null || held.at === null ? null : Math.max(0, Date.now() - held.at);
    const age = heldMs === null ? 'unknown age' : durationText(heldMs);
    const line = `another tick is still evaluating (pid ${held?.pid ?? 'unknown'}, held ${age})`;
    const budget = tickBudgetMs(readControl(p.control));
    if (heldMs !== null && heldMs > budget) {
      console.error(
        `${line} — longer than the ${durationText(budget)} budget, so it is wedged ` +
          `rather than busy. Clear it with "kill ${held?.pid}"; the next firing then runs.`,
      );
    } else {
      console.log(line);
    }
    return;
  }

  // Armed before any I/O, so there is no window where a pass holds the lock unwatched.
  // The budget is read here rather than inside the timer: a control file that becomes
  // unreadable mid-pass must not disarm the watchdog.
  const budgetMs = tickBudgetMs(readControl(p.control));

  // unref()'d: a healthy pass must not be kept alive by its own watchdog.
  const watchdog = setTimeout(() => {
    void releaseOverrunningTick(p.tickLock, p.control, budgetMs).then(() => process.exit(1));
  }, budgetMs);
  watchdog.unref();

  try {
    const now = Date.now();
    const control = readControl(p.control);
    const status = await readStatus();
    await reconcileAbandoned(now, control, status);
    // Before admission: the next cycle's clearReport() would delete the very report this
    // reads, so a late outcome has exactly one tick in which to be recovered.
    reconcileLateReports(now);

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
          to: control,
          asksUrl: null,
        });
      }

      // Bounded orca calls per enabled program, releasing a safe leftover on the way. Only for the orca runner: a headless
      // cycle has no agent, so reporting one absent would be true but meaningless. Left
      // undefined when orca cannot answer — unknown must not refuse a cycle.
      const cycleInFlight = inFlight(mine, now, control.maxCycleHours).length > 0;
      const runnerPresent =
        program.runner === 'orca' ? await runnerAfterLeftover(program.name, mine, cycleInFlight) : undefined;

      const decision = decide({
        status,
        control,
        cycles,
        program: program.name,
        now,
        answeredAt: asks?.latestAt ?? null,
        asksShared: asks?.shared ?? null,
        ...(runnerPresent === undefined ? {} : { runnerPresent }),
      });
      logDecision(program.name, decision, now);
      console.log(`${program.name}: ${decision.verdict} — ${fullReason(decision)}`);

      if (decision.verdict !== 'GO' || decision.pool === null) continue;
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
        pauseUntil: null,
        sessionId: null,
        closing: null,
      });
    }
    // Craig's own consumption is the pool's largest draw and nothing reconstructs it
    // after the fact — both terms are fractions of a window that resets. Sampled here,
    // read by `drovr usage`, and deliberately feeding no gate.
    //
    // Logged and swallowed on purpose: a full disk must cost the measurement, never the
    // tick. This is the last thing a pass does and admission has already happened.
    try {
      appendSample(p.usage, sampleUsage(status, now));
    } catch (error) {
      console.error(`usage sample not recorded: ${explain(error)}. Admission is unaffected.`);
    }

    // A completed pass, whether or not any program was enabled to decide about. Clearing
    // the failure marker here and nowhere else is what makes "once per episode" mean an
    // episode: a tick that returns early because the lock is busy has completed nothing.
    stampTick(p.lastTick, Date.now());
    clearTickFailure(p.tickFailure);
  } finally {
    clearTimeout(watchdog);
    release(p.tickLock);
  }
};

/**
 * What a cycle that never wrote a report is recorded as. Order matters only in that each
 * of these is a different fact: it never started, it sat idle through every nudge, drovr
 * stopped watching a live runner, or it really did die without a word.
 */
const unreportedExit = (
  deferred: boolean,
  stalled: boolean,
  abandoned: boolean,
): CycleRecord['exit'] => {
  if (deferred) return 'deferred';
  if (stalled) return 'stalled';
  if (abandoned) return 'abandoned';
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

    // An open record with nobody holding the lock is a cycle that lost its watcher, not its
    // runner: pick its record back up rather than opening a second one on top of it.
    const resumed = inFlight(readCycles(p.cycles), Date.now(), control.maxCycleHours).find(
      (cycle) => cycle.program === name,
    );
    const startedAt = resumed?.startedAt ?? new Date().toISOString();
    const sessionId = resumed?.sessionId ?? randomUUID();
    const kind = resumed?.kind ?? (isOnboarding(name) ? 'onboarding' : 'delivery');
    const before = resumed?.poolBefore ?? snapshot(poolFrom(await readStatus(), ceilings, Date.now()));

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
        pauseUntil: null,
        sessionId,
        closing: null,
        ...extra,
      });
    };

    if (resumed === undefined) record({});
    else console.log(`${name}: re-attaching to the cycle started ${startedAt} — its watcher died with the runner still there`);

    // Anything between the start record and the end record can throw — a missing
    // binary, an orca error, a lost worktree. Without an end record the cycle stays
    // "in flight" forever, blocking its own program and holding a concurrency slot.
    const limits = {
      maxHours: control.maxCycleHours,
      stallNudgeMs: control.stallNudgeMinutes * 60_000,
      maxStallNudges: control.maxStallNudges,
      blockedAlertMs: control.blockedAlertMinutes * 60_000,
      slackChannel: control.slackChannel,
      phoneNumber: control.phoneNumber,
      originationNumber: control.originationNumber,
    };
    const watch = resumed === undefined ? runCycle(program, startedAt, sessionId, limits) : resumeCycle(program, limits);
    const outcome = await watch.catch(
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
    const abandoned = 'abandoned' in outcome && outcome.abandoned === true;

    // Unreadable falls back to the unreported exit rather than throwing: a throw here
    // would skip record() and leave the cycle open in the ledger, charged as running
    // against the pool forever.
    const report = readReportOrWarn(name);
    const after = snapshot(poolFrom(await readStatus(), ceilings, Date.now()));

    record({
      endedAt: new Date().toISOString(),
      exit: report?.exit ?? unreportedExit(deferred, stalled, abandoned),
      poolAfter: after,
      startupTokens: report?.startupTokens ?? null,
      yield: report?.yield ?? null,
      asksRaised: report?.asksRaised ?? 0,
      pauseUntil: report?.pauseUntil ?? null,
      // Only a cycle drovr saw end has a closing; an abandoned runner is still talking.
      closing: outcome.finished ? closingMessage(sessionId) : null,
    });

    // A stalled runner was nudged and stayed silent, so Craig is the only one left
    // who can tell whether the program is wedged or simply had nothing to say.
    if (stalled) {
      console.error(`cycle for ${name} stalled — recorded as stalled. ${outcome.detail}`);
      await textCraig(
        control,
        `drovr: ${name} stalled — its runner idled through ${control.maxStallNudges} nudges ` +
          `without writing a report. Its pane is free and the next tick starts a fresh cycle.`,
      );
    }

    // Logged and recorded, not published: the status page has one publisher (the tick)
    // and one page for every program, so a worker republishing it would both race that
    // and cost a second publish. The crash is in cycles.jsonl and shows up on the page
    // at the next tick, inside ten minutes.
    if (report === null && !deferred && !stalled && !abandoned) {
      console.error(
        `cycle for ${name} produced no report — recorded as crash. ${outcome.detail}`,
      );
    }
  } finally {
    release(lock);
  }
};

/**
 * The same window decide() and buildState use, not inFlight's 24h default: `tidy` skips
 * any program with a cycle in flight, and a wider window there would leave a program's
 * workspace untidied forever on the strength of a cycle admission has already forgotten.
 */
export const inFlightCycles = (): CycleRecord[] => {
  const p = paths();
  return inFlight(readCycles(p.cycles), Date.now(), readControl(p.control).maxCycleHours);
};
