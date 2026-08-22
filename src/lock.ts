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

export const holder = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) return null;
  return isAlive(pid) ? pid : null;
};

/** Returns false when a live process holds the lock; stale locks are reclaimed. */
export const acquire = (path: string): boolean => {
  if (holder(path) !== null) return false;
  writeFileSync(path, String(process.pid), 'utf8');
  return true;
};

export const release = (path: string): void => {
  if (!existsSync(path)) return;
  const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (pid === process.pid) rmSync(path);
};
