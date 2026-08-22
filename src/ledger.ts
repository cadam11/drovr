import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Pool } from './capacity.ts';

const poolSnapshot = z.object({ fable: z.number(), general: z.number(), session: z.number() });

export const cycleShape = z.object({
  v: z.literal(1),
  kind: z.enum(['delivery', 'onboarding']),
  program: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** Why the cycle stopped — the main input for tuning the context ceiling. */
  exit: z.enum(['context', 'capacity', 'seam', 'blocked', 'crash', 'running']),
  poolBefore: poolSnapshot,
  poolAfter: poolSnapshot.nullable(),
  /** Tokens consumed before the first productive action: the re-onboarding tax. */
  startupTokens: z.number().nullable(),
  yield: z
    .object({ ticketsMoved: z.number(), prsOpened: z.number(), commits: z.number() })
    .nullable(),
  asksRaised: z.number().default(0),
});

export const decisionShape = z.object({
  v: z.literal(1),
  at: z.string(),
  program: z.string(),
  verdict: z.enum(['GO', 'WAIT', 'STOP']),
  reason: z.string(),
  pool: poolSnapshot.nullable(),
  cyclesFundable: z.number().nullable(),
});

export type CycleRecord = z.infer<typeof cycleShape>;
export type DecisionRecord = z.infer<typeof decisionShape>;
export type CycleCost = { fable: number; general: number; session: number };

export const snapshot = (pool: Pool): CycleCost => ({
  fable: pool.fable,
  general: pool.general,
  session: pool.session,
});

export const appendRecord = (path: string, record: unknown): void => {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
};

/** Malformed lines are surfaced, not skipped — a silently truncated ledger skews every estimate. */
export const readCycles = (path: string): CycleRecord[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const parsed = cycleShape.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`${path}:${index + 1} is not a valid cycle record: ${parsed.error.message}`);
      }
      return parsed.data;
    });
};

const costOf = (cycle: CycleRecord): CycleCost | null => {
  if (cycle.poolAfter === null) return null;
  return {
    fable: Math.max(0, cycle.poolBefore.fable - cycle.poolAfter.fable),
    general: Math.max(0, cycle.poolBefore.general - cycle.poolAfter.general),
    session: Math.max(0, cycle.poolBefore.session - cycle.poolAfter.session),
  };
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/**
 * Onboarding cycles are read-heavy and Fable-light; averaging them in would skew
 * the estimate every admission decision depends on.
 */
export const estimateCycleCost = (
  cycles: CycleRecord[],
  seed: CycleCost,
  minSamples = 3,
): CycleCost => {
  const costs = cycles
    .filter((cycle) => cycle.kind === 'delivery' && cycle.exit !== 'crash')
    .map(costOf)
    .filter((cost): cost is CycleCost => cost !== null);

  if (costs.length < minSamples) return seed;
  return {
    fable: Math.max(median(costs.map((c) => c.fable)), seed.fable / 4),
    general: Math.max(median(costs.map((c) => c.general)), seed.general / 4),
    session: Math.max(median(costs.map((c) => c.session)), seed.session / 4),
  };
};

/** Drovr's own spend inside the current weekly window — the pace-keeping numerator. */
export const spentSince = (cycles: CycleRecord[], windowStart: number): CycleCost => {
  const inWindow = cycles.filter((cycle) => Date.parse(cycle.startedAt) >= windowStart);
  const costs = inWindow.map(costOf).filter((cost): cost is CycleCost => cost !== null);
  return {
    fable: costs.reduce((total, cost) => total + cost.fable, 0),
    general: costs.reduce((total, cost) => total + cost.general, 0),
    session: costs.reduce((total, cost) => total + cost.session, 0),
  };
};

export const cyclesStartedSince = (cycles: CycleRecord[], since: number): number =>
  cycles.filter((cycle) => Date.parse(cycle.startedAt) >= since).length;

export const consecutiveZeroYield = (cycles: CycleRecord[]): number => {
  const finished = cycles.filter((cycle) => cycle.kind === 'delivery' && cycle.endedAt !== null);
  let streak = 0;
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const produced = finished[index]!.yield;
    if (produced === null) break;
    if (produced.ticketsMoved + produced.prsOpened + produced.commits > 0) break;
    streak += 1;
  }
  return streak;
};
