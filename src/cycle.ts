import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Program } from './control.ts';
import { ensureDirs, paths } from './paths.ts';
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
});

export type CycleReport = z.infer<typeof reportShape>;

export const readReport = (program: string): CycleReport | null => {
  const path = paths().lastCycle(program);
  if (!existsSync(path)) return null;
  const parsed = reportShape.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${path} is not a valid cycle report: ${parsed.error.message}`);
  }
  return parsed.data;
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

export type CycleOutcome = { finished: boolean; detail: string; stalled?: boolean };

/** Everything bounding one cycle's watch, resolved from control.json by the caller. */
export type CycleLimits = { maxHours: number; stallNudgeMs: number; maxStallNudges: number };

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

export type StallAction = 'wait' | 'nudge' | 'give-up';

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
 */
export const stallAction = (input: {
  state: AgentState;
  hasReport: boolean;
  idleForMs: number;
  nudgesSent: number;
  nudgeAfterMs: number;
  maxNudges: number;
}): StallAction => {
  // Once the report exists the cycle has declared itself done, and idling at the
  // prompt is exactly what it should be doing — that is the release path, not a stall.
  if (input.hasReport) return 'wait';
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
const watchCycle = async (
  started: StartedCycle,
  program: string,
  limits: CycleLimits,
): Promise<CycleOutcome> => {
  // Bounded: a wedged runner must not hold its capacity slot indefinitely.
  const deadline = Date.now() + limits.maxHours * 3_600_000;
  let idleSince: number | null = null;
  let nudges = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (readReport(program) !== null) return releaseFinished(started);

    const state = await agentState(started.agentName);
    if (state === 'gone') {
      return { finished: true, detail: `agent ${started.agentName} is no longer present` };
    }

    idleSince = state === 'idle' ? (idleSince ?? Date.now()) : null;
    const action = stallAction({
      state,
      hasReport: false,
      idleForMs: idleSince === null ? 0 : Date.now() - idleSince,
      nudgesSent: nudges,
      nudgeAfterMs: limits.stallNudgeMs,
      maxNudges: limits.maxStallNudges,
    });

    if (action === 'wait') continue;
    if (action === 'give-up') return abandonStalled(started, nudges);

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
  return {
    finished: false,
    detail: `still running after ${limits.maxHours}h — agent ${started.agentName} left in place for inspection`,
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
