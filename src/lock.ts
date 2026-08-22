import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};

/** Returns false when another tick holds the lock; stale locks are reclaimed. */
export const acquire = (path: string): boolean => {
  if (existsSync(path)) {
    const held = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (Number.isFinite(held) && isAlive(held)) return false;
  }
  writeFileSync(path, String(process.pid), 'utf8');
  return true;
};

export const release = (path: string): void => {
  if (!existsSync(path)) return;
  const held = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (held === process.pid) rmSync(path);
};
