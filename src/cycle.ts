import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Program } from './control.ts';
import { ensureDirs, paths } from './paths.ts';
import { wrap } from './publish.ts';
import { agentState, resolveWorkspace, startCycleAgent, teamclaudeEnv } from './herdr.ts';

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
    .replaceAll('{mode}', onboarding ? 'onboard' : 'deliver');

export type CycleOutcome = { finished: boolean; detail: string };

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

/**
 * Opens the cycle as an interactive agent tab in the program's own herdr workspace,
 * so Craig can read it and talk to it mid-cycle like any other session. drovr does
 * not own the process, so completion is detected from the runner's own report or
 * from the agent disappearing — never by killing anything.
 */
const runInHerdr = async (
  program: Program,
  startedAt: string,
  maxHours: number,
): Promise<CycleOutcome> => {
  const workspaceId = await resolveWorkspace(program);
  const prompt = substitute(program.cyclePrompt, program, isOnboarding(program.name));
  const started = await startCycleAgent({
    program,
    workspaceId,
    prompt,
    env: await teamclaudeEnv(),
    remembered: rememberedPane(program.name),
  });

  rememberPane(program.name, started.paneId);
  writeFileSync(
    join(paths().programState(program.name), 'current-cycle.json'),
    `${JSON.stringify({ ...started, workspaceId, prompt, startedAt }, null, 2)}\n`,
    'utf8',
  );

  // Bounded: a wedged runner must not hold its capacity slot indefinitely.
  const deadline = Date.now() + maxHours * 3_600_000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (readReport(program.name) !== null) {
      return { finished: true, detail: `runner reported in as agent ${started.agentName}` };
    }
    const state = await agentState(started.agentName);
    if (state === 'gone') {
      return { finished: true, detail: `agent ${started.agentName} is no longer present` };
    }
  }
  return {
    finished: false,
    detail: `still running after ${maxHours}h — agent ${started.agentName} left in place for inspection`,
  };
};

/** Resolves once the cycle finishes or the watch window expires; cycles run for hours. */
export const runCycle = async (
  program: Program,
  startedAt: string,
  maxHours: number,
): Promise<CycleOutcome> => {
  ensureDirs(program.name);
  clearReport(program.name);
  return program.runner === 'headless'
    ? runHeadless(program, startedAt)
    : runInHerdr(program, startedAt, maxHours);
};
