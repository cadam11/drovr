import type { Program } from './control.ts';
import { runBounded } from './exec.ts';

/**
 * The one *network* call inside the tick loop, and it runs once per program — so an
 * unbounded publish was a more reachable way to wedge a tick than any of the local reads,
 * and it was not on the list of known-unbounded calls. 60s: this uploads a rendered page
 * over the wire through direnv, so it is legitimately slower than a socket read.
 */
const PUBLISH_TIMEOUT_MS = 60_000;

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
    await runBounded(bin, args, { timeoutMs: PUBLISH_TIMEOUT_MS, cwd: program.cwd });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`aice publish failed for ${program.name}: ${detail}`);
    return false;
  }
};
