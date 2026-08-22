import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Program } from './control.ts';

const run = promisify(execFile);

/**
 * Publishing is best-effort: a failed status publish must never take down a tick
 * that is otherwise healthy, but it is logged rather than swallowed.
 */
export const publishStatus = async (program: Program, file: string): Promise<boolean> => {
  if (program.aice === null) return false;
  const args = ['publish', file, '--as', program.aice.statusPage, ...program.aice.publishArgs];
  try {
    await run('aice', args, { cwd: program.cwd });
    return true;
  } catch (error) {
    console.error(`aice publish failed for ${program.name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};
