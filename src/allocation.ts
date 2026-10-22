import { record } from './record.ts';
import type { Pool } from './capacity.ts';
import { spentSince, type CycleCost, type CycleRecord } from './ledger.ts';
import type { TeamclaudeStatus } from './teamclaude.ts';
import { hoursToWeeklyReset, isUsable } from './capacity.ts';

export type BucketName = 'fable' | 'general' | 'session';

/**
 * How one quota bucket is divided, in account-units (N usable accounts = N.0).
 * The five segments always sum to `total`, so they stack into one bar.
 */
export type Allocation = {
  bucket: BucketName;
  total: number;
  /** Spent outside drovr — Craig's own foreground work. */
  yoursSpent: number;
  /** Spent by completed drovr cycles inside the current window. */
  programsSpent: number;
  /** Claimed by cycles currently in flight but not yet visible as usage. */
  programsReserved: number;
  /** Still spendable by programs before the ceiling. */
  programsAvailable: number;
  /** Held above the ceiling and never touched by drovr. */
  yoursReserved: number;
};

const field = {
  fable: (quota: TeamclaudeStatus['accounts'][number]['quota']) => quota.unified7dFable,
  general: (quota: TeamclaudeStatus['accounts'][number]['quota']) => quota.unified7d,
  session: (quota: TeamclaudeStatus['accounts'][number]['quota']) => quota.unified5h,
} as const;

const usedTotal = (status: TeamclaudeStatus, bucket: BucketName, now: number): number =>
  status.accounts
    .filter((account) => isUsable(account, now))
    .reduce((total, account) => total + (field[bucket](account.quota) ?? 0), 0);

export const allocationFor = (input: {
  status: TeamclaudeStatus;
  pool: Pool;
  bucket: BucketName;
  spentByPrograms: number;
  runningCycles: number;
  cycleCost: CycleCost;
  now: number;
}): Allocation => {
  const { pool, bucket, runningCycles, cycleCost, now } = input;
  const total = pool.usableAccounts;
  const used = Math.min(usedTotal(input.status, bucket, now), total);

  // The ledger can over-report against a shrunken pool (an account dropped out
  // mid-window), so programs never claim more of `used` than actually exists.
  const programsSpent = Math.max(0, Math.min(input.spentByPrograms, used));
  const yoursSpent = used - programsSpent;

  // Headroom comes from the pool, which clamps each account at its own ceiling.
  // Deriving it from `ceiling × accounts - used` would let one account's overspend
  // eat another's headroom, and would disagree with what decide() admits.
  const headroom = Math.min(pool[bucket], Math.max(0, total - used));
  const programsReserved = Math.min(runningCycles * cycleCost[bucket], headroom);

  return {
    bucket,
    total,
    yoursSpent,
    programsSpent,
    programsReserved,
    programsAvailable: headroom - programsReserved,
    yoursReserved: Math.max(0, total - used - headroom),
  };
};

export const BUCKETS: BucketName[] = ['fable', 'general', 'session'];

/** allocationFor's division/multiplication over quota fractions is the biggest source of float noise in a payload. */
const roundAllocation = (allocation: Allocation): Allocation => ({
  bucket: allocation.bucket,
  total: Number(allocation.total.toFixed(4)),
  yoursSpent: Number(allocation.yoursSpent.toFixed(4)),
  programsSpent: Number(allocation.programsSpent.toFixed(4)),
  programsReserved: Number(allocation.programsReserved.toFixed(4)),
  programsAvailable: Number(allocation.programsAvailable.toFixed(4)),
  yoursReserved: Number(allocation.yoursReserved.toFixed(4)),
});

/**
 * The three stacked bars `drovr watch` draws, rounded, over the current weekly window.
 * One function for every payload (state.ts, status-payload.ts) so a remote bar cannot
 * disagree with the TUI's.
 */
const allocationSegmentsUnrecorded = (input: {
  status: TeamclaudeStatus;
  pool: Pool;
  cycles: CycleRecord[];
  runningCycles: number;
  cycleCost: CycleCost;
  now: number;
}): Record<BucketName, Allocation> => {
  const hoursLeft = hoursToWeeklyReset(input.status, input.now);
  const windowStart = hoursLeft === null ? input.now : input.now - (168 - hoursLeft) * 3_600_000;
  const spent = spentSince(input.cycles, windowStart);
  return Object.fromEntries(
    BUCKETS.map((bucket) => [
      bucket,
      roundAllocation(allocationFor({
        status: input.status, pool: input.pool, bucket,
        spentByPrograms: spent[bucket], runningCycles: input.runningCycles, cycleCost: input.cycleCost, now: input.now,
      })),
    ]),
  ) as Record<BucketName, Allocation>;
};

export const allocationSegments = (
  input: Parameters<typeof allocationSegmentsUnrecorded>[0],
): Record<BucketName, Allocation> => record('allocationSegments', { input }, allocationSegmentsUnrecorded(input));
