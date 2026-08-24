import { createHash } from 'node:crypto';
import type { DrovrState } from './state.ts';

/**
 * heartbeatSeconds exists because the panel's own STALE_MS (2 minutes) is shorter
 * than quietSeconds (5 minutes): without a heartbeat, a perfectly healthy, unchanged
 * payload sits unpublished for up to 5 minutes and the page falsely reports the Mac
 * stopped pushing. Raising STALE_MS instead was rejected — that would hide a real
 * outage for up to 6 minutes, which defeats the one banner that must be believed.
 */
export const CADENCE = { activeSeconds: 20, quietSeconds: 300, heartbeatSeconds: 60 };

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

export const shouldPublish = (input: {
  previousHash: string | null;
  nextHash: string;
  cycleRunning: boolean;
  lastPublishedAt: number | null;
  now: number;
}): boolean => {
  if (input.lastPublishedAt === null || input.previousHash === null) return true;
  if (input.previousHash === input.nextHash) {
    // A heartbeat, not news: refreshes generatedAt so the page's staleness clock
    // never falsely trips while nothing has actually changed.
    return input.now - input.lastPublishedAt >= CADENCE.heartbeatSeconds * 1000;
  }
  const floor = input.cycleRunning ? CADENCE.activeSeconds : CADENCE.quietSeconds;
  return input.now - input.lastPublishedAt >= floor * 1000;
};
