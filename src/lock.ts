import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

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

const lockShape = z.object({ pid: z.number(), at: z.number() });

export type Held = { pid: number; at: number | null };

/**
 * Locks used to hold a bare pid. Both shapes are read, because a lock written by the
 * previous build can still be on disk when this one starts — and the file drovr most
 * wants to reason about is the one it did not write.
 *
 * A bare pid reads as `at: null`, which is honest: the age is genuinely unknown, and
 * every caller below treats unknown as "not stale" rather than guessing.
 */
const parse = (raw: string): Held | null => {
  const text = raw.trim();
  if (text === '') return null;

  // A bare pid is itself valid JSON, so the legacy case cannot be left to a parse
  // failure: `JSON.parse('76410')` succeeds and yields a number. Branch on the shape of
  // what came back, not on whether parsing threw.
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof decoded === 'number') {
    return Number.isInteger(decoded) && decoded > 0 ? { pid: decoded, at: null } : null;
  }
  const parsed = lockShape.safeParse(decoded);
  return parsed.success ? { pid: parsed.data.pid, at: parsed.data.at } : null;
};

/** The live holder and when it took the lock, or null if nothing holds it. */
export const heldBy = (path: string): Held | null => {
  if (!existsSync(path)) return null;
  const held = parse(readFileSync(path, 'utf8'));
  if (held === null) return null;
  return isAlive(held.pid) ? held : null;
};

export const holder = (path: string): number | null => heldBy(path)?.pid ?? null;

/**
 * How long the live holder has held it, or null when nothing holds it or the lock
 * predates the timestamped format.
 *
 * This exists so a wedge is *visible*. A lock whose holder is alive but stuck is the one
 * state `acquire` cannot resolve — reclaiming it would run two ticks at once, which
 * races the ledger and double-launches cycles, so drovr reports the age instead of
 * stealing the lock. The holder killing itself is what actually clears it (see tick.ts's
 * watchdog); this is how anyone else finds out.
 */
export const heldForMs = (path: string, now = Date.now()): number | null => {
  const held = heldBy(path);
  if (held === null || held.at === null) return null;
  return Math.max(0, now - held.at);
};

/** Returns false when a live process holds the lock; stale locks are reclaimed. */
export const acquire = (path: string): boolean => {
  if (heldBy(path) !== null) return false;
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  return true;
};

export const release = (path: string): void => {
  if (!existsSync(path)) return;
  const held = parse(readFileSync(path, 'utf8'));
  if (held?.pid === process.pid) rmSync(path);
};
