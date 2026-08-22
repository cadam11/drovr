import type { TeamclaudeAccount, TeamclaudeStatus } from './teamclaude.ts';

/**
 * Capacity is measured in quota-fractions, not tokens: teamclaude reports
 * used-fractions and never exposes an absolute quota size, so a cycle's cost is
 * only ever knowable as the pool delta it produced.
 */
export type Pool = {
  fable: number;
  general: number;
  session: number;
  usableAccounts: number;
  /**
   * Soonest future reset per bucket. The buckets are not interchangeable: a 5h
   * window recovers in hours, a weekly one in days, so which bucket binds decides
   * whether waiting is cheap or the loop is done for the week.
   */
  resetAt: { fable: number | null; general: number | null; session: number | null };
  earliestRecoveryAt: number | null;
};

export type Ceilings = { weekly: number; session: number };

const usedOr = (value: number | null): number => value ?? 0;

const headroom = (used: number | null, ceiling: number): number =>
  Math.max(0, ceiling - usedOr(used));

export const isUsable = (account: TeamclaudeAccount, now: number): boolean => {
  if (account.disabled) return false;
  if (account.rateLimitedUntil !== null && account.rateLimitedUntil > now) return false;
  if (account.pausedUntil !== null && account.pausedUntil > now) return false;
  return true;
};

/**
 * The Fable runner spawns Opus/Sonnet/Haiku subagents, so a cycle draws on the
 * general weekly bucket as well as the Fable one. An account with Fable headroom
 * but no general headroom contributes capacity that cannot actually be spent —
 * summing both pools independently and taking the min at the decision point is
 * what encodes that coupling.
 */
export const poolFrom = (
  status: TeamclaudeStatus,
  ceilings: Ceilings,
  now: number,
): Pool => {
  const usable = status.accounts.filter((account) => isUsable(account, now));
  const soonest = (times: (number | null)[]): number | null => {
    const future = times.filter((at): at is number => at !== null && at > now);
    return future.length === 0 ? null : Math.min(...future);
  };
  const resetAt = {
    fable: soonest(usable.map((a) => a.quota.unified7dFableReset)),
    general: soonest(usable.map((a) => a.quota.unified7dReset)),
    session: soonest(usable.map((a) => a.quota.unified5hReset)),
  };

  return {
    fable: sum(usable.map((a) => headroom(a.quota.unified7dFable, ceilings.weekly))),
    general: sum(usable.map((a) => headroom(a.quota.unified7d, ceilings.weekly))),
    session: sum(usable.map((a) => headroom(a.quota.unified5h, ceilings.session))),
    usableAccounts: usable.length,
    resetAt,
    earliestRecoveryAt: soonest([resetAt.fable, resetAt.general, resetAt.session]),
  };
};

/** Hours until the soonest weekly reset among usable accounts, for pace-keeping. */
export const hoursToWeeklyReset = (status: TeamclaudeStatus, now: number): number | null => {
  const resets = status.accounts
    .filter((account) => isUsable(account, now))
    .map((account) => account.quota.unified7dReset)
    .filter((at): at is number => at !== null && at > now);
  if (resets.length === 0) return null;
  return (Math.min(...resets) - now) / 3_600_000;
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
