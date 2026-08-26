import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * launchd gives a tick a bare environment, so a missing tool surfaces as the
 * opaque `spawn <bin> ENOENT`. Name the binary, where it was looked for, and the
 * fix — a log line nobody can act on is barely better than no log line.
 */
export const explainSpawn = (binary: string, error: unknown): Error => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'ENOENT') {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new Error(
    `${binary} is not on PATH. Looked in: ${process.env.PATH ?? '(unset)'}. ` +
      `If this came from a launchd tick, re-run \`drovr service install\` from a shell where ` +
      `\`${binary}\` works — the agent bakes in that shell's PATH.`,
  );
};

const exec = promisify(execFile);

/**
 * A subprocess that never returns is the one failure that takes drovr off the air
 * silently. Every call below runs on a path a launchd firing reaches, and `execFile`
 * has **no default timeout** — so one hung child holds the tick lock, and every later
 * firing logs `another tick is still evaluating` while admission stops with nothing
 * saying why. `lock.ts` only reclaims a lock whose holder is *dead*; a live process
 * blocked forever on a pipe is not.
 *
 * So the ceiling is not optional and not per-call-site discipline: it is a parameter of
 * the only helper that spawns anything. Every timeout in drovr is a named constant beside
 * the module that uses it, because the right number depends on whether the call is a local
 * socket read or a network upload, and a reviewer has to be able to see which.
 */
export class ExecTimedOut extends Error {}

export const runBounded = async (
  binary: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string; maxBuffer?: number; label?: string },
): Promise<{ stdout: string; stderr: string }> => {
  const shown = options.label ?? `${binary} ${args.join(' ')}`;
  try {
    return await exec(binary, args, {
      timeout: options.timeoutMs,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    });
  } catch (error) {
    // execFile reports its own expiry as a killed child carrying a generic "Command
    // failed", which names neither the command nor the ceiling it hit.
    if ((error as { killed?: boolean }).killed === true) {
      throw new ExecTimedOut(
        `${shown} did not return within ${Math.round(options.timeoutMs / 1000)}s and was killed`,
      );
    }
    // Non-ENOENT errors come back as the original object, so a caller that lifts a
    // reason out of the child's own stdout still can.
    throw explainSpawn(binary, error);
  }
};
