import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Program } from './control.ts';

const run = promisify(execFile);

/**
 * Each program's repo already declares its own environment (aice install, config
 * dir, API tokens) in .envrc. Running through direnv keeps that the single source
 * of truth instead of duplicating it into control.json, where it would drift.
 */
export const wrap = (program: Program, argv: string[]): { file: string; args: string[] } =>
  program.useDirenv
    ? { file: 'direnv', args: ['exec', program.cwd, ...argv] }
    : { file: argv[0]!, args: argv.slice(1) };

/** Best-effort: a failed status publish must not fail an otherwise healthy tick, but it is logged. */
export const publishStatus = async (program: Program, file: string): Promise<boolean> => {
  if (program.aice === null) return false;
  const { file: bin, args } = wrap(program, [
    'aice',
    'publish',
    file,
    '--as',
    program.aice.statusPage,
    ...program.aice.publishArgs,
  ]);
  try {
    await run(bin, args, { cwd: program.cwd });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`aice publish failed for ${program.name}: ${detail}`);
    return false;
  }
};
