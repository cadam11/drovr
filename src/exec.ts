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
