import type { Pool } from './capacity.ts';
import type { CycleCost } from './ledger.ts';
import type { TeamclaudeStatus } from './teamclaude.ts';
import { isUsable } from './capacity.ts';

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
