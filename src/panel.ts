import { createHash } from 'node:crypto';
import type { DrovrState } from './state.ts';

/**
 * heartbeatSeconds exists because the panel's own STALE_MS (2 minutes) is shorter
 * than the old quietSeconds backoff (5 minutes) ever was: without a heartbeat, a
 * perfectly healthy, unchanged payload could sit unpublished long enough for the
 * page to falsely report the Mac stopped pushing. quietSeconds was deleted
 * entirely (not just superseded) once the heartbeat moved above the hash
 * comparison — a constant nothing can reach is exactly the kind of dead-but-
 * looks-live thing that caused the bug it replaced.
 *
 * 40s, not 60s: worst case is one skipped launchd slot (up to 20s of phase) plus
 * publish latency on top of the heartbeat itself. At 60s that stacks to ~85-90s
 * against a 120s banner threshold, so a single missed slot gets uncomfortably
 * close and two trip it. 40s (two slots) leaves real margin at negligible cost.
 */
export const CADENCE = { activeSeconds: 20, heartbeatSeconds: 40 };

export const payload = (state: DrovrState): string => `${JSON.stringify(state, null, 2)}\n`;

/**
 * generatedAt changes every tick and would defeat the skip, so the hash covers
 * everything except it. A payload that differs only by its clock is not news.
 */
export const payloadHash = (json: string): string => {
  const parsed: Record<string, unknown> = JSON.parse(json);
  delete parsed.generatedAt;
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex').slice(0, 32);
};

/**
 * The heartbeat check MUST come before the unchanged-hash check, not inside it.
 * account fields (lastUsedAt, sessions, current, the session bucket) move on
 * almost every real collectState() call, so previousHash === nextHash is nearly
 * always false in practice — a heartbeat nested inside that branch is a branch
 * that never runs. Hoisting it above the comparison means it fires regardless of
 * whether anything actually changed, which is the whole point of a heartbeat.
 *
 * cycleRunning is gone: the old fast/slow (20s/300s) split by whether a cycle was
 * running no longer has anywhere to live once quietSeconds is deleted, so every
 * genuine change is rate-limited by the same activeSeconds floor.
 */
export const shouldPublish = (input: {
  previousHash: string | null;
  nextHash: string;
  lastPublishedAt: number | null;
  now: number;
}): boolean => {
  if (input.lastPublishedAt === null || input.previousHash === null) return true;
  if (input.now - input.lastPublishedAt >= CADENCE.heartbeatSeconds * 1000) return true;
  if (input.previousHash === input.nextHash) return false;
  return input.now - input.lastPublishedAt >= CADENCE.activeSeconds * 1000;
};
