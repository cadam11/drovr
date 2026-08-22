import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Program } from './control.ts';
import { ensureDirs, paths } from './paths.ts';
import { aiceEnv } from './publish.ts';

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

/** Resolves with the child's exit code once the cycle finishes; cycles run for hours. */
export const runCycle = async (program: Program, startedAt: string): Promise<number | null> => {
  ensureDirs(program.name);
  clearReport(program.name);

  const logPath = join(paths().logs, `${program.name}-${startedAt.replaceAll(':', '-')}.log`);
  const log = openSync(logPath, 'a');
  const command = substitute(program.cycleCommand, program, isOnboarding(program.name));

  writeFileSync(join(paths().programState(program.name), 'current-command.txt'), command, 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: program.cwd,
      shell: true,
      env: { ...process.env, ...aiceEnv(program), DROVR_PROGRAM: program.name },
      stdio: ['ignore', log, log],
      detached: false,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
};
