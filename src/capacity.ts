import { record } from './record.ts';
import { fableEligible, type TeamclaudeAccount, type TeamclaudeStatus } from './teamclaude.ts';

/**
 * Capacity is measured in quota-fractions, not tokens: teamclaude reports
 * used-fractions and never exposes an absolute quota size, so a cycle's cost is
 * only ever knowable as the pool delta it produced.
 */
export type AccountHeadroom = {
  name: string;
  fable: number;
  general: number;
  session: number;
  /**
   * Whether teamclaude will route a Fable request here at all. Headroom is still
   * reported honestly when false — the allocation bars answer how much of each bucket
   * is spent pool-wide — but decide.ts must not fund a cycle from it.
   */
  routable: boolean;
};

export type Pool = {
  fable: number;
  general: number;
  session: number;
  usableAccounts: number;
  /**
   * Headroom kept unsummed, because fundability cannot be recovered from the sums:
   * min-of-sums is not sum-of-mins. Only this can answer what an account may spend.
   */
  perAccount: AccountHeadroom[];
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
 * The Fable runner spawns Opus/Sonnet/Haiku subagents, and one Fable token decrements
 * all three buckets on whichever account served the request. An account is therefore
 * spendable only where it has room in all three at once.
 *
 * The per-bucket sums below do **not** encode that, and an earlier version of this
 * comment claimed they did. Summing a bucket across accounts lets an account donate
 * headroom it can never spend because it is exhausted in another bucket, and taking a
 * min afterwards does not put it back: min-of-sums is not sum-of-mins. The sums are the
 * display figure — how much of each bucket is spent pool-wide. Fundability is computed
 * per account from `perAccount`, in decide.ts.
 */
const poolFromUnrecorded = (
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

  // Kept in perAccount rather than filtered out: an ineligible account still owns the
  // resets that say when the pool recovers, and dropping it would hide both that and
  // the reason its headroom is being ignored.
  const routable = fableEligible(status);
  const perAccount = usable.map((a) => ({
    name: a.name,
    fable: headroom(a.quota.unified7dFable, ceilings.weekly),
    general: headroom(a.quota.unified7d, ceilings.weekly),
    session: headroom(a.quota.unified5h, ceilings.session),
    routable: routable === null || routable.has(a.name),
  }));

  return {
    fable: sum(perAccount.map((a) => a.fable)),
    general: sum(perAccount.map((a) => a.general)),
    session: sum(perAccount.map((a) => a.session)),
    usableAccounts: usable.length,
    perAccount,
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

export const poolFrom = (status: TeamclaudeStatus, ceilings: Ceilings, now: number): Pool =>
  record('poolFrom', { status, ceilings, now }, poolFromUnrecorded(status, ceilings, now));
