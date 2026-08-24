import { createHash } from 'node:crypto';
import type { DrovrState } from './state.ts';

export const CADENCE = { activeSeconds: 20, quietSeconds: 300 };

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
  if (input.previousHash === input.nextHash) return false;
  const floor = input.cycleRunning ? CADENCE.activeSeconds : CADENCE.quietSeconds;
  return input.now - input.lastPublishedAt >= floor * 1000;
};
