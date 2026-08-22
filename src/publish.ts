import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { Program } from './control.ts';

const run = promisify(execFile);

const expand = (path: string): string =>
  path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path;

/**
 * Each program targets its own aice install. AICE_BASE_URL selects it and
 * AICE_CONFIG_DIR keeps the token caches apart — sharing one would make a login
 * to any install clobber the others.
 */
export const aiceEnv = (program: Program): NodeJS.ProcessEnv => {
  if (program.aice === null) return {};
  return {
    AICE_BASE_URL: program.aice.baseUrl,
    ...(program.aice.configDir === null ? {} : { AICE_CONFIG_DIR: expand(program.aice.configDir) }),
  };
};

/** Best-effort: a failed status publish must not fail an otherwise healthy tick, but it is logged. */
export const publishStatus = async (program: Program, file: string): Promise<boolean> => {
  if (program.aice === null) return false;
  const args = ['publish', file, '--as', program.aice.statusPage, ...program.aice.publishArgs];
  try {
    await run('aice', args, { cwd: program.cwd, env: { ...process.env, ...aiceEnv(program) } });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`aice publish failed for ${program.name}: ${detail}`);
    return false;
  }
};
