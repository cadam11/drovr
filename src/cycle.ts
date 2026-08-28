import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_REST_DAYS, parseDuration, type Program } from './control.ts';
import { ensureDirs, paths } from './paths.ts';
import { textCraig } from './nudge.ts';
import { wrap } from './publish.ts';
import {
  agentState,
  promptAgent,
  resolveWorkspace,
  releaseAgent,
  startCycleAgent,
  teamclaudeEnv,
  tidyCycleTabs,
  type AgentState,
  type StartedCycle,
} from './herdr.ts';

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

const paneShape = z.object({ paneId: z.string() });

/** The cycle tab persists across cycles, so its pane is remembered between them. */
const rememberedPane = (program: string): string | null => {
  const path = join(paths().programState(program), 'cycle-pane.json');
  if (!existsSync(path)) return null;
  const parsed = paneShape.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success ? parsed.data.paneId : null;
};

const rememberPane = (program: string, paneId: string): void => {
  writeFileSync(
    join(paths().programState(program), 'cycle-pane.json'),
    `${JSON.stringify({ paneId }, null, 2)}\n`,
    'utf8',
  );
};

const POLL_MS = 30_000;

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

/** The report exists, so the cycle has declared itself done and the pane is cleanup. */
const releaseFinished = async (started: StartedCycle): Promise<CycleOutcome> => {
  const released = await releaseAgent(started.agentName, started.paneId).catch(() => false);
  return {
    finished: true,
    detail: released
      ? 'runner reported in and its pane was released for the next cycle'
      : `runner reported in but agent ${started.agentName} is still holding pane ` +
        `${started.paneId} — the next cycle will refuse until it is closed`,
  };
};

/** Out of nudges. Free the pane so the next tick starts clean rather than deferring. */
const abandonStalled = async (started: StartedCycle, nudges: number): Promise<CycleOutcome> => {
  const released = await releaseAgent(started.agentName, started.paneId).catch(() => false);
  return {
    finished: true,
    stalled: true,
    detail:
      `runner sat idle through ${nudges} nudges without writing a report` +
      (released
        ? ' — its pane was released for a fresh cycle'
        : ` — agent ${started.agentName} still holds pane ${started.paneId}`),
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
  agentName: string,
  blockedForMs: number,
  limits: Pick<CycleLimits, 'phoneNumber' | 'originationNumber'>,
): Promise<void> => {
  const minutes = Math.round(blockedForMs / 60_000);
  const message =
    `drovr: ${program} has been waiting ${minutes}m on a dialog in its pane — a permission ` +
    `prompt or a trust question. Only you can clear it. Open the ${agentName} tab in herdr ` +
    'and answer it; the cycle carries on from there. It holds its pane until you do.';
  console.error(`${program}: blocked ${minutes}m on a dialog — asked Craig to clear it`);
  await textCraig(limits.phoneNumber, message, limits.originationNumber).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`could not text about ${program} being blocked: ${detail}`);
  });
};

const watchCycle = async (
  started: StartedCycle,
  program: string,
  limits: CycleLimits,
): Promise<CycleOutcome> => {
  // Bounded: a wedged runner must not hold its capacity slot indefinitely.
  const deadline = Date.now() + limits.maxHours * 3_600_000;
  let idleSince: number | null = null;
  let blockedSince: number | null = null;
  let nudges = 0;
  let alerted = false;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (pollReport(program) !== null) return releaseFinished(started);

    const state = await agentState(started.agentName);
    if (state === 'gone') {
      return { finished: true, detail: `agent ${started.agentName} is no longer present` };
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
    if (action === 'give-up') return abandonStalled(started, nudges);
    if (action === 'alert') {
      // Marked before sending, not after: a send that throws must not turn a one-off
      // request for help into a text every poll for the rest of the cycle.
      alerted = true;
      await askForHuman(program, started.agentName, Date.now() - (blockedSince ?? Date.now()), limits);
      continue;
    }

    // Counted and the clock reset even when the send fails, so a herdr that is
    // refusing prompts cannot turn the nudge budget into a 30-second retry loop.
    nudges += 1;
    idleSince = null;
    await promptAgent(started.agentName, STALL_PROMPT).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`could not nudge ${started.agentName}: ${detail}`);
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
      `still watching after ${limits.maxHours}h and the runner is still alive — agent ` +
      `${started.agentName} left in place. Recorded as abandoned, not crashed; if it ` +
      'writes a report the next tick supersedes this record with the real outcome',
  };
};

/**
 * Opens the cycle as an interactive agent tab in the program's own herdr workspace,
 * so Craig can read it and talk to it mid-cycle like any other session. drovr does
 * not own the process, so completion is detected from the runner's own report or
 * from the agent disappearing — never by killing anything.
 */
const runInHerdr = async (
  program: Program,
  startedAt: string,
  limits: CycleLimits,
): Promise<CycleOutcome> => {
  const workspaceId = await resolveWorkspace(program);
  const prompt = substitute(program.cyclePrompt, program, isOnboarding(program.name));
  const started = await startCycleAgent({
    program,
    workspaceId,
    prompt,
    sessionName: substitute(program.sessionName, program, isOnboarding(program.name)),
    env: await teamclaudeEnv(),
    remembered: rememberedPane(program.name),
  });

  rememberPane(program.name, started.paneId);

  // Earlier cycles can leave empty tabs behind when a pane was lost and a new one
  // had to be made. Tidy them once the replacement is up, never before.
  const closed = await tidyCycleTabs({
    program: program.name,
    workspaceId,
    keepTabId: started.tabId,
  }).catch(() => []);
  if (closed.length > 0) console.log(`closed ${closed.length} empty cycle tab(s): ${closed.join(', ')}`);

  writeFileSync(
    join(paths().programState(program.name), 'current-cycle.json'),
    `${JSON.stringify({ ...started, workspaceId, prompt, startedAt }, null, 2)}\n`,
    'utf8',
  );

  return watchCycle(started, program.name, limits);
};

/** Resolves once the cycle finishes or the watch window expires; cycles run for hours. */
export const runCycle = async (
  program: Program,
  startedAt: string,
  limits: CycleLimits,
): Promise<CycleOutcome> => {
  ensureDirs(program.name);
  clearReport(program.name);
  return program.runner === 'headless'
    ? runHeadless(program, startedAt)
    : runInHerdr(program, startedAt, limits);
};
