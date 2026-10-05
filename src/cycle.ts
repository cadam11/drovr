import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_REST_DAYS, parseDuration, type Program } from './control.ts';
import { ensureDirs, paths } from './paths.ts';
import { textCraig } from './nudge.ts';
import {
  openLine,
  PaneBusy,
  promptRunner,
  releaseRunner,
  resolveWorktree,
  runnerAddress,
  runnerState,
  startCycleAgent,
  type AgentState,
  type StartedCycle,
} from './orca.ts';

/**
 * Written by the runner before it exits. Its absence after the process ends is
 * how a crash is distinguished from a deliberate wind-down.
 */
const reportShape = z.object({
  exit: z.enum(['context', 'capacity', 'seam', 'blocked']),
  startupTokens: z.number().nullable().default(null),
  yield: z
    .object({ ticketsMoved: z.number(), prsOpened: z.number(), commits: z.number() })
    .nullable()
    .default(null),
  asksRaised: z.number().default(0),
  /** ISO timestamp: everything left is waiting on time, hold the program until then. */
  pauseUntil: z.string().nullable().default(null),
  /** Standing request: this program only needs a cycle every so often ("12h", "7d"). */
  cadence: z.string().regex(/^\d+[mhd]$/).nullable().default(null),
});

export type CycleReport = z.infer<typeof reportShape>;

const validated = (label: string, data: unknown): CycleReport => {
  const parsed = reportShape.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${label} is not a valid cycle report: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const readReport = (program: string): CycleReport | null => {
  const path = paths().lastCycle(program);
  if (!existsSync(path)) return null;
  return validated(path, JSON.parse(readFileSync(path, 'utf8')));
};

/**
 * For the watch loop only. It polls while a direct writer may still be mid-write, so
 * unparseable bytes mean "not yet" — the next poll sees the whole file. `drovr report`
 * stages through a rename and can never be caught like this; the tolerance exists for
 * runners briefed under the old write-the-file contract. Valid JSON with the wrong
 * shape is a *complete* report that breaks the contract, and still throws.
 */
export const pollReport = (program: string): CycleReport | null => {
  const path = paths().lastCycle(program);
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  return validated(path, data);
};

/**
 * The one writer that cannot leave a torn or invalid file: refused before anything
 * touches disk, then staged through a rename so the watch's poll never sees half a
 * report. The rename is also the commit — a report's existence ends the cycle.
 */
export const writeReport = (program: string, report: unknown): CycleReport => {
  const parsed = validated('the given report', report);
  ensureDirs(program);
  const path = paths().lastCycle(program);
  const staged = `${path}.staged`;
  writeFileSync(staged, `${JSON.stringify(parsed)}\n`, 'utf8');
  renameSync(staged, path);
  return parsed;
};

const numberArg = (args: string[], name: string): number | undefined => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  const value = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(value)) throw new Error(`--${name} needs a number, got "${raw ?? ''}"`);
  return value;
};

const REPORT_FLAGS = new Set([
  '--exit',
  '--startup-tokens',
  '--tickets-moved',
  '--prs-opened',
  '--commits',
  '--asks-raised',
  '--pause-until',
  '--cadence',
]);

const stringArg = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * "48h" and "2026-08-30T09:00Z" are both fine: an agent asking to soak thinks in
 * durations, one waiting for a release date thinks in dates. Bounded by MAX_REST_DAYS
 * either way, and a pause that is already over is refused rather than silently inert.
 */
const parsePauseUntil = (raw: string, now: number): string => {
  const asDuration = /^\d+[mhd]$/.test(raw) ? now + parseDuration(raw) : Date.parse(raw);
  if (Number.isNaN(asDuration)) {
    throw new Error(`--pause-until needs a duration (48h, 7d) or an ISO date, got "${raw}"`);
  }
  if (asDuration <= now) throw new Error(`--pause-until "${raw}" is already in the past`);
  if (asDuration > now + MAX_REST_DAYS * 86_400_000) {
    throw new Error(`--pause-until "${raw}" is more than ${MAX_REST_DAYS} days out — the maximum`);
  }
  return new Date(asDuration).toISOString();
};

const parseCadence = (raw: string): string => {
  if (!/^\d+[mhd]$/.test(raw)) {
    throw new Error(`--cadence must look like 30m, 12h, or 7d — got "${raw}"`);
  }
  if (parseDuration(raw) > MAX_REST_DAYS * 86_400_000) {
    throw new Error(`--cadence "${raw}" is longer than ${MAX_REST_DAYS} days — the maximum`);
  }
  return raw;
};

/**
 * `drovr report`'s argument half, kept pure so the refusals an agent will actually see
 * are testable. Unknown flags are refused rather than skipped: a typo that silently
 * dropped a field would defeat the reason the command exists.
 */
export const parseReportArgs = (args: string[], now: number): { program: string; report: unknown } => {
  const [program] = args;
  if (program === undefined || program.startsWith('--')) {
    throw new Error('usage: drovr report <program> --exit <context|capacity|seam|blocked> [flags]');
  }
  const unknown = args.slice(1).filter((arg) => arg.startsWith('--') && !REPORT_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown flag ${unknown[0]} — \`drovr help report\` lists them`);
  }
  const exitIndex = args.indexOf('--exit');
  if (exitIndex === -1) {
    throw new Error('--exit is required: context | capacity | seam | blocked');
  }
  const ticketsMoved = numberArg(args, 'tickets-moved');
  const prsOpened = numberArg(args, 'prs-opened');
  const commits = numberArg(args, 'commits');
  const anyYield = [ticketsMoved, prsOpened, commits].some((value) => value !== undefined);
  const pauseUntil = stringArg(args, 'pause-until');
  const cadence = stringArg(args, 'cadence');
  return {
    program,
    report: {
      exit: args[exitIndex + 1],
      startupTokens: numberArg(args, 'startup-tokens') ?? null,
      yield: anyYield
        ? { ticketsMoved: ticketsMoved ?? 0, prsOpened: prsOpened ?? 0, commits: commits ?? 0 }
        : null,
      asksRaised: numberArg(args, 'asks-raised') ?? 0,
      pauseUntil: pauseUntil === undefined ? null : parsePauseUntil(pauseUntil, now),
      cadence: cadence === undefined ? null : parseCadence(cadence),
    },
  };
};

export const clearReport = (program: string): void => {
  const path = paths().lastCycle(program);
  if (existsSync(path)) rmSync(path);
};

export const isOnboarding = (program: string): boolean =>
  !existsSync(paths().stateFile(program));

const substitute = (command: string, program: Program, onboarding: boolean): string =>
  command
    .replaceAll('{program}', program.name)
    .replaceAll('{model}', program.model)
    .replaceAll('{mode}', onboarding ? 'onboard' : 'deliver');

export type CycleOutcome = {
  finished: boolean;
  detail: string;
  stalled?: boolean;
  /**
   * The watch hit maxCycleHours with the runner still alive. Distinct from every other
   * outcome because it is not a statement about the cycle at all — it is a statement about
   * drovr having stopped looking.
   */
  abandoned?: boolean;
};

/** Everything bounding one cycle's watch, resolved from control.json by the caller. */
export type CycleLimits = {
  maxHours: number;
  stallNudgeMs: number;
  maxStallNudges: number;
  /** How long a runner may sit on a dialog before Craig is asked to come and clear it. */
  blockedAlertMs: number;
  /** Null disables the text; the log line is written either way. */
  phoneNumber: string | null;
  /** drovr's own long code — without it SNS picks one of sunnyt's numbers (nudge.ts). */
  originationNumber: string | null;
};

const POLL_MS = 30_000;

/**
 * Ten minutes of consecutive failed polls. One slow orca answer used to end the watch as a
 * `crash` with the runner still working — six times from 2026-10-01 to 10-05, three of them
 * in the same second — orphaning a live runner whose report nothing would ever read.
 */
const MAX_POLL_FAILURES = 20;

export type StallAction = 'wait' | 'nudge' | 'give-up' | 'alert';

/**
 * An idle runner that has written no report will never move again on its own: an
 * interactive session finishes its turn and sits at the prompt forever, whether the
 * turn ended because Craig interrupted it or because it died on a transient API
 * error. Nudging that session is far cheaper than a fresh cycle, which pays full
 * onboarding for context this one already has — but it has to be bounded, or a
 * genuinely wedged runner is nudged every ten minutes until the maxHours deadline.
 *
 * `blocked` is deliberately not nudged: it means the pane is waiting on a dialog
 * only Craig can answer, and a prompt queues up behind it rather than clearing it.
 *
 * It is not, however, left silent — which is what "not nudged" used to mean in practice,
 * because every non-idle state fell through to `wait`. Measured 2026-08-27: sunnyt sat at
 * a bash-permission prompt for most of a 12.8h run. drovr saw `blocked`, logged it to a
 * file nobody reads, held the pane and a concurrency slot for the full `maxCycleHours`,
 * then recorded a finished cycle as a crash. The one state that *requires* a human was the
 * one state that never reached one — while an unanswered ask, a softer and asynchronous
 * question, texts him after 240 minutes.
 *
 * Alert rather than give up. A blocked runner still holds all of its context and its work
 * is intact, merely paused; abandoning it would throw away a cycle that only needs an
 * answer. Once per cycle, because a dialog does not become more urgent by being repeated.
 */
export const stallAction = (input: {
  state: AgentState;
  hasReport: boolean;
  idleForMs: number;
  nudgesSent: number;
  nudgeAfterMs: number;
  maxNudges: number;
  blockedForMs: number;
  blockedAlertAfterMs: number;
  /** Whether this cycle has already asked for a human, so it asks exactly once. */
  alerted: boolean;
}): StallAction => {
  // Once the report exists the cycle has declared itself done, and idling at the
  // prompt is exactly what it should be doing — that is the release path, not a stall.
  if (input.hasReport) return 'wait';
  if (input.state === 'blocked') {
    return !input.alerted && input.blockedForMs >= input.blockedAlertAfterMs ? 'alert' : 'wait';
  }
  if (input.state !== 'idle') return 'wait';
  if (input.idleForMs < input.nudgeAfterMs) return 'wait';
  return input.nudgesSent < input.maxNudges ? 'nudge' : 'give-up';
};

const STALL_PROMPT =
  '[drovr] You have been idle for ten minutes without writing this cycle\'s report. ' +
  'If the cycle is still viable, continue it. If it is finished or cannot proceed, ' +
  'write your cycle report and stand down.';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Each program's repo already declares its own environment (aice install, config dir, API
 * tokens) in .envrc. Running through direnv keeps that the single source of truth instead
 * of duplicating it into control.json, where it would drift.
 *
 * The last of its two callers: drovr no longer publishes anything, so the only thing it
 * still wraps is the cycle command itself.
 */
const wrap = (program: Program, argv: string[]): { file: string; args: string[] } =>
  program.useDirenv
    ? { file: 'direnv', args: ['exec', program.cwd, ...argv] }
    : { file: argv[0]!, args: argv.slice(1) };

/** Headless fallback: claude -p to a log file. Nothing to talk to; used only when asked for. */
const runHeadless = async (program: Program, startedAt: string): Promise<CycleOutcome> => {
  const logPath = join(paths().logs, `${program.name}-${startedAt.replaceAll(':', '-')}.log`);
  const log = openSync(logPath, 'a');
  const command = substitute(program.cycleCommand, program, isOnboarding(program.name));
  const { file, args } = wrap(program, ['sh', '-c', command]);

  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: program.cwd,
      env: { ...process.env, DROVR_PROGRAM: program.name },
      stdio: ['ignore', log, log],
      detached: false,
    });
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { finished: true, detail: `headless runner exited ${code}, log at ${logPath}` };
};

/** The report exists, so the cycle has declared itself done and the terminal is cleanup. */
const releaseFinished = async (program: string): Promise<CycleOutcome> => {
  const released = await releaseRunner(program).catch(() => false);
  if (released) return { finished: true, detail: 'runner reported in and its terminal was released for the next cycle' };
  const address = await runnerAddress(program);
  return {
    finished: true,
    detail:
      `runner reported in but its session still holds ${address.where} — the next cycle will ` +
      `refuse until it is freed with \`drovr release ${program}\`.${openLine(address)}`,
  };
};

/** Out of nudges. Free the terminal so the next tick starts clean rather than deferring. */
const abandonStalled = async (program: string, nudges: number): Promise<CycleOutcome> => {
  const released = await releaseRunner(program).catch(() => false);
  return {
    finished: true,
    stalled: true,
    detail:
      `runner sat idle through ${nudges} nudges without writing a report` +
      (released
        ? ' — its terminal was released for a fresh cycle'
        : await (async (): Promise<string> => {
            const address = await runnerAddress(program);
            return ` — its session still holds ${address.where}${openLine(address)}`;
          })()),
  };
};

/**
 * Watches a started cycle until it reports, vanishes, stalls out, or runs out of
 * clock. drovr does not own the process, so every one of those is observed rather
 * than waited on: there is no exit code to read.
 */
/**
 * The only escalation drovr has for a state it cannot resolve itself. A dialog in the
 * pane stops the cycle dead and no amount of waiting or prompting clears it, so the
 * message says where to go rather than what happened.
 *
 * Best-effort like every other send, and the log line is written first — an alert that
 * fails to reach a handset must still be recoverable from the worker log.
 */
const askForHuman = async (
  program: string,
  blockedForMs: number,
  limits: Pick<CycleLimits, 'phoneNumber' | 'originationNumber'>,
): Promise<void> => {
  const minutes = Math.round(blockedForMs / 60_000);
  const address = await runnerAddress(program);
  const message =
    `drovr: ${program} has been waiting ${minutes}m on a dialog in its terminal — a permission ` +
    `prompt or a trust question. Only you can clear it. Open ${address.where} in orca ` +
    `and answer it; the cycle carries on from there. It holds its terminal until you do.${openLine(address)}`;
  console.error(`${program}: blocked ${minutes}m on a dialog — asked Craig to clear it`);
  await textCraig(limits.phoneNumber, message, limits.originationNumber).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`could not text about ${program} being blocked: ${detail}`);
  });
};

/**
 * Orca stopped answering for long enough that drovr cannot say what the runner is doing.
 * `abandoned`, like the deadline: a statement about the watch, not the cycle, so a report
 * the runner writes later is reconciled by the next tick rather than lost under a crash.
 */
const lostSight = (program: string, failures: number): CycleOutcome => ({
  finished: false,
  abandoned: true,
  detail:
    `lost sight of ${program}'s runner after ${failures} failed polls in a row — orca is not ` +
    'answering. Recorded as abandoned, not crashed; if it writes a report the next tick ' +
    'supersedes this record with the real outcome',
});

const watchCycle = async (program: string, limits: CycleLimits): Promise<CycleOutcome> => {
  // Bounded: a wedged runner must not hold its capacity slot indefinitely.
  const deadline = Date.now() + limits.maxHours * 3_600_000;
  let idleSince: number | null = null;
  let blockedSince: number | null = null;
  let nudges = 0;
  let alerted = false;
  let pollFailures = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (pollReport(program) !== null) return releaseFinished(program);

    const state: AgentState | null = await runnerState(program).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${program}: could not read its runner's state (${detail}) — still watching`);
      return null;
    });
    if (state === null) {
      pollFailures += 1;
      if (pollFailures >= MAX_POLL_FAILURES) return lostSight(program, pollFailures);
      continue;
    }
    pollFailures = 0;
    if (state === 'gone') {
      return { finished: true, detail: `the runner is no longer present in ${(await runnerAddress(program)).where}` };
    }

    idleSince = state === 'idle' ? (idleSince ?? Date.now()) : null;
    // Cleared when it moves, so answering the dialog re-arms the alert for the next one.
    // A twelve-hour cycle can hit several, and only the first was ever going to be free.
    blockedSince = state === 'blocked' ? (blockedSince ?? Date.now()) : null;
    if (state !== 'blocked') alerted = false;

    const action = stallAction({
      state,
      hasReport: false,
      idleForMs: idleSince === null ? 0 : Date.now() - idleSince,
      nudgesSent: nudges,
      nudgeAfterMs: limits.stallNudgeMs,
      maxNudges: limits.maxStallNudges,
      blockedForMs: blockedSince === null ? 0 : Date.now() - blockedSince,
      blockedAlertAfterMs: limits.blockedAlertMs,
      alerted,
    });

    if (action === 'wait') continue;
    if (action === 'give-up') return abandonStalled(program, nudges);
    if (action === 'alert') {
      // Marked before sending, not after: a send that throws must not turn a one-off
      // request for help into a text every poll for the rest of the cycle.
      alerted = true;
      await askForHuman(program, Date.now() - (blockedSince ?? Date.now()), limits);
      continue;
    }

    // Counted and the clock reset even when the send fails, so an orca that is
    // refusing prompts cannot turn the nudge budget into a 30-second retry loop.
    nudges += 1;
    idleSince = null;
    await promptRunner(program, STALL_PROMPT).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`could not nudge ${program}: ${detail}`);
    });
    console.log(`${program}: idle with no report — nudged it (${nudges}/${limits.maxStallNudges})`);
  }
  // Not `crash`. The runner is alive and may still be minutes from writing its report;
  // drovr has simply run out of watch. Saying "crash" here asserted that a cycle which
  // often *had* delivered produced nothing, and discarded the quota sample of the longest
  // and most expensive cycles there are. tick.ts reconciles a report that lands later.
  return {
    finished: false,
    abandoned: true,
    detail:
      `still watching after ${limits.maxHours}h and the runner is still alive — ` +
      `${program}'s terminal left in place. Recorded as abandoned, not crashed; if it ` +
      'writes a report the next tick supersedes this record with the real outcome',
  };
};

/**
 * Opens the cycle as an interactive claude in a terminal of the program's own Orca
 * worktree, so Craig can read it and talk to it mid-cycle like any other session. drovr
 * does not own the process, so completion is detected from the runner's own report or
 * from the agent disappearing — never by killing anything.
 */
const runInOrca = async (
  program: Program,
  startedAt: string,
  sessionId: string,
  limits: CycleLimits,
): Promise<CycleOutcome> => {
  const worktreeId = await resolveWorktree(program);
  const prompt = substitute(program.cyclePrompt, program, isOnboarding(program.name));
  const sessionName = substitute(program.sessionName, program, isOnboarding(program.name));
  // --model per session, so the runner is always Fable without touching Craig's default;
  // --name makes it obvious in the prompt box and /resume which program a session belongs to;
  // --session-id is what lets the ledger find this cycle's transcript afterwards.
  const { file, args } = wrap(program, [
    'teamclaude', 'run', '--', '--model', program.model, '--name', sessionName, '--session-id', sessionId,
  ]);
  const started: StartedCycle = await startCycleAgent({ program, worktreeId, command: [file, ...args], prompt });

  writeFileSync(
    join(paths().programState(program.name), 'current-cycle.json'),
    `${JSON.stringify({ ...started, worktreeId, prompt, startedAt }, null, 2)}\n`,
    'utf8',
  );

  return watchCycle(program.name, limits);
};

/**
 * Picks the watch back up for a cycle whose worker died with its runner still there. No
 * clearReport: a report the runner has written since is this cycle's outcome, not a leftover.
 */
export const resumeCycle = (program: Program, limits: CycleLimits): Promise<CycleOutcome> =>
  watchCycle(program.name, limits);

/** Resolves once the cycle finishes or the watch window expires; cycles run for hours. */
export const runCycle = async (
  program: Program,
  startedAt: string,
  sessionId: string,
  limits: CycleLimits,
): Promise<CycleOutcome> => {
  ensureDirs(program.name);
  clearReport(program.name);
  return program.runner === 'headless'
    ? runHeadless(program, startedAt)
    : runInOrca(program, startedAt, sessionId, limits);
};
