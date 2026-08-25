import { hoursToWeeklyReset, poolFrom, type AccountHeadroom, type Pool } from './capacity.ts';
import { ceilingsFor, isPaused, type Control } from './control.ts';
import {
  consecutiveFailures,
  consecutiveZeroYield,
  cyclesStartedSince,
  estimateCycleCost,
  inFlight,
  lastFinished,
  snapshot,
  spentSince,
  unansweredAsks,
  type CycleCost,
  type CycleRecord,
} from './ledger.ts';
import type { BucketName } from './allocation.ts';
import type { TeamclaudeStatus } from './teamclaude.ts';

const WEEKLY_WINDOW_HOURS = 168;
const DAY_MS = 86_400_000;

export type Verdict = 'GO' | 'WAIT' | 'STOP';

export type Decision = {
  verdict: Verdict;
  reason: string;
  pool: Pool | null;
  cyclesFundable: number | null;
  /** Which bucket is tightest — the difference between waiting hours and waiting days. */
  binding: BucketName | null;
  earliestRecoveryAt: number | null;
};

export type DecideInput = {
  status: TeamclaudeStatus;
  control: Control;
  /** Every program's cycles: quota is one shared pool, so pace and reservations are global. */
  cycles: CycleRecord[];
  program: string;
  now: number;
  /** Most recent activity on this program’s asks page, if drovr could read it. */
  answeredAt?: number | null;
  /** False when shared notes are off, which is what stops drovr seeing an answer. */
  asksShared?: boolean | null;
};

const ratio = (available: number, cost: number): number =>
  cost <= 0 ? Number.POSITIVE_INFINITY : available / cost;

const BUCKETS: BucketName[] = ['fable', 'general', 'session'];

/** What one account could fund alone, and which of its buckets stopped it there. */
export type AccountFunding = {
  name: string;
  cycles: number;
  binding: BucketName;
  /** False when teamclaude will not route a Fable request here, so it funds nothing. */
  routable: boolean;
};

export type Funding = { cycles: number; binding: BucketName; accounts: AccountFunding[] };

/**
 * The buckets are not a hierarchy: one Fable token decrements all three, so they are
 * simultaneous constraints on the account that served the request and the tightest binds.
 */
const fundingFor = (account: AccountHeadroom, cost: CycleCost): AccountFunding => {
  const tightest = BUCKETS
    .map((bucket) => ({
      name: account.name,
      cycles: ratio(account[bucket], cost[bucket]),
      binding: bucket,
      routable: account.routable,
    }))
    .reduce((best, candidate) => (candidate.cycles < best.cycles ? candidate : best));

  // An account teamclaude will not route Fable to funds nothing, whatever its buckets
  // say. The bucket is still reported: eligibility tracks usage, so the tightest bucket
  // is also what has to reset before the account comes back.
  return account.routable ? tightest : { ...tightest, cycles: 0 };
};

const resetOrder = (pool: Pool, bucket: BucketName): number =>
  pool.resetAt[bucket] ?? Number.POSITIVE_INFINITY;

/**
 * Which bucket to report, since earliestRecoveryAt is read from it. Above zero it is
 * the bucket pinning the account that would serve next — the one with the most to give.
 * At zero no account serves any request, so the useful answer is which bucket frees one
 * up first: a 5h hold is hours away, a weekly one days, and saying the wrong one turns a
 * short wait into an apparent write-off.
 */
const bindingOf = (accounts: AccountFunding[], pool: Pool): BucketName => {
  const best = accounts.reduce((most, account) => (account.cycles > most.cycles ? account : most));
  if (best.cycles > 0) return best.binding;
  return accounts
    .map((account) => account.binding)
    .reduce((soonest, bucket) => (resetOrder(pool, bucket) < resetOrder(pool, soonest) ? bucket : soonest));
};

/**
 * Fundability is the sum over accounts of each account's own tightest bucket, never the
 * min of the per-bucket sums — those let an account donate headroom it cannot spend
 * because it is exhausted elsewhere (see capacity.ts).
 *
 * `running` is subtracted here rather than from the pool: cycles already in flight have
 * not shown up as spent quota yet, so without it N concurrent programs each claim the
 * whole pool. It is a count of cycles because fundability is now counted in cycles —
 * there is no per-bucket pool left to deduct a per-bucket cost from.
 */
export const cyclesFundableFrom = (pool: Pool, cost: CycleCost, running: number): Funding => {
  const accounts = pool.perAccount.map((account) => fundingFor(account, cost));
  // A pool with no usable accounts funds nothing. It still has to name a bucket, and
  // session is the shortest wait, so it is the least misleading one to claim.
  if (accounts.length === 0) return { cycles: 0, binding: 'session', accounts };

  const gross = accounts.reduce((total, account) => total + account.cycles, 0);
  return { cycles: Math.max(0, gross - running), binding: bindingOf(accounts, pool), accounts };
};

/**
 * The local part, unless two accounts share one, in which case neither is abbreviated.
 * Length is a hard constraint here and not a preference: this note has to survive beside
 * a program row in `drovr watch`, which is the one surface that also draws the free-looking
 * bars it exists to explain. Keeping the domains costs about thirty columns and pushes the
 * verdict itself off the frame.
 */
const shortName = (name: string, all: AccountFunding[]): string => {
  const local = (candidate: string): string => candidate.split('@')[0] ?? candidate;
  const collides = all.filter((account) => local(account.name) === local(name)).length > 1;
  return collides ? name : local(name);
};

const listOf = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** How many accounts actually contribute a fundable cycle, whatever the total says. */
export const contributingAccounts = (funding: Funding): number =>
  funding.accounts.filter((account) => account.cycles > 0).length;

/**
 * "across 3 accounts" is a lie when one of them is carrying all of it. Measured live on
 * 2026-08-25: two of Craig's three accounts were spent and the third — the only one
 * teamclaude would route Fable to — was also serving his own foreground sessions, while
 * the verdict still read "across 3 accounts". The total was right; the picture was not.
 */
const sourcedFrom = (funding: Funding, usable: number): string => {
  const from = contributingAccounts(funding);
  return from === usable ? `across ${usable} accounts` : `from ${from} of ${usable} accounts`;
};

/**
 * A pool resting on a single account has no fallback, and that account is also where
 * Craig's own sessions land — so one busy afternoon of his removes drovr's whole runway.
 * The headline number cannot express that, so it is said out loud.
 *
 * Silent for a single-account pool: there is no concentration to warn about when there
 * was never more than one account to spread across.
 */
const concentrationNote = (funding: Funding, usable: number): string | null => {
  if (usable < 2) return null;
  const carrying = funding.accounts.filter((account) => account.cycles > 0);
  if (carrying.length !== 1) return null;
  const unroutable = funding.accounts.filter((account) => !account.routable).length;
  const why = unroutable === 0 ? '' : `, ${unroutable} not routed for fable`;
  return `all of it on ${shortName(carrying[0]!.name, funding.accounts)} with no fallback${why}`;
};

/**
 * The allocation bars and this verdict answer different questions — the bars show how
 * much of each bucket is spent pool-wide, which reads as free while no single account
 * has room in all three at once. That gap is what got misread as capacity, so when it is
 * what refuses a cycle the reason has to name it and say which bucket pins whom.
 *
 * Appended, never prefixed: every surface clips a long reason from the right, so whichever
 * half goes last is the half that can be lost. The verdict — what it funds, what it needs,
 * when it recovers — is the half that must always survive.
 *
 * Silent for a single-account pool: with one account min-of-sums and sum-of-mins agree,
 * so there is no discrepancy to explain and "session tightest" already says it.
 */
const couplingNote = (funding: Funding): string | null => {
  if (funding.accounts.length < 2) return null;
  const pinned = funding.accounts.filter((account) => account.cycles <= 0);
  if (pinned.length === 0) return null;

  const pins = BUCKETS
    .map((bucket) => pinned.filter((account) => account.binding === bucket))
    .filter((group) => group.length > 0)
    .map((group) => `${group[0]!.binding} pins ${listOf(group.map((account) => shortName(account.name, funding.accounts)))}`)
    .join(', ');

  if (pinned.length === funding.accounts.length) {
    return `no account has room in all three buckets: ${pins}`;
  }
  const spare = funding.accounts.length - pinned.length;
  return `only ${spare}/${funding.accounts.length} accounts have room in all three: ${pins}`;
};

/**
 * Linear entitlement across the weekly window, measured against drovr's own
 * ledger rather than account usage: Craig's foreground work constrains the pool
 * through the ceiling without also counting against the loop's pace.
 */
const paceExceeded = (
  input: DecideInput,
  weeklyCeiling: number,
  usableAccounts: number,
): string | null => {
  const hoursLeft = hoursToWeeklyReset(input.status, input.now);
  if (hoursLeft === null) return null;

  const elapsed = Math.min(1, Math.max(0, (WEEKLY_WINDOW_HOURS - hoursLeft) / WEEKLY_WINDOW_HOURS));
  const entitlement = weeklyCeiling * usableAccounts * elapsed;
  const windowStart = input.now - (WEEKLY_WINDOW_HOURS - hoursLeft) * 3_600_000;
  const spent = spentSince(input.cycles, windowStart);

  const over = (['fable', 'general'] as const).find((bucket) => spent[bucket] > entitlement);
  if (over === undefined) return null;
  return `ahead of pace on ${over} (${spent[over].toFixed(2)} spent vs ${entitlement.toFixed(2)} entitled, all programs)`;
};

/**
 * Hours, until an hour is the wrong unit. `Math.round` turned a 26-minute session hold into
 * "recovers in 0h", which reads as "any moment now" for a wait that is not — the same class
 * of misreport as naming the wrong bucket, and on the same line.
 */
const untilText = (at: number | null, now: number): string => {
  if (at === null) return 'unknown';
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
};

const halt = (reason: string): Decision => ({
  verdict: 'STOP',
  reason,
  pool: null,
  cyclesFundable: null,
  binding: null,
  earliestRecoveryAt: null,
});

/** Recovery is read from the binding bucket's own reset, not the soonest of all three. */
const hold = (
  reason: string,
  pool: Pool | null,
  funding: Funding | null,
): Decision => ({
  verdict: 'WAIT',
  reason,
  pool,
  cyclesFundable: funding?.cycles ?? null,
  binding: funding?.binding ?? null,
  earliestRecoveryAt:
    funding === null || pool === null ? (pool?.earliestRecoveryAt ?? null) : pool.resetAt[funding.binding],
});

export const decide = (input: DecideInput): Decision => {
  const { control, cycles, program, now } = input;
  const mine = cycles.filter((cycle) => cycle.program === program);

  if (control.mode === 'off') return halt('mode is off');

  // Tick skips disabled programs, so reporting anything but STOP here would promise
  // a cycle that is never going to start.
  const entry = control.programs.find((candidate) => candidate.name === program);
  if (entry !== undefined && !entry.enabled) {
    return halt('disabled — enable it to let cycles start');
  }

  const stuck = consecutiveZeroYield(mine);
  if (stuck >= control.stuckCycleThreshold) {
    return halt(`${stuck} consecutive cycles produced no yield — escalating instead of looping`);
  }

  // Only recent failures latch, so a fixed cause resumes without anyone clearing it.
  const failures = consecutiveFailures(mine, now, control.crashWindowMinutes);
  if (failures >= control.stuckCycleThreshold) {
    return halt(
      `${failures} cycles crashed or stalled in the last ${control.crashWindowMinutes}m — see ` +
        `~/.drovr/logs/${program}-worker.log. Retries on its own once those age out, ` +
        `or run "drovr run-cycle ${program}" to try immediately.`,
    );
  }

  const ceilings = ceilingsFor(control);
  if (ceilings === null) return halt('mode is off');

  if (isPaused(control, now)) return hold(`paused until ${control.pauseUntil}`, null, null);

  // A blocked cycle means every remaining item is waiting on a human answer, so
  // starting another straight away only pays to rediscover that. Back off instead of
  // burning a cycle every tick, and say plainly that it is waiting on Craig.
  const last = lastFinished(mine);
  if (last?.exit === 'blocked' && last.endedAt !== null) {
    // An answer on the asks page ends the wait immediately: that is the event the
    // backoff was standing in for.
    const answered = (input.answeredAt ?? 0) > Date.parse(last.endedAt);
    const retryAt = Date.parse(last.endedAt) + control.blockedBackoffMinutes * 60_000;
    if (!answered && retryAt > now) {
      const mins = Math.ceil((retryAt - now) / 60_000);
      // Shared notes being off is the reason an answer goes unnoticed, so name it.
      const unnoticed =
        input.asksShared === false
          ? '. Shared notes are off on that page, so drovr cannot see your reply'
          : '';
      return hold(
        `waiting on you — the last cycle was blocked on unanswered asks. Retries in ${mins}m, ` +
          `or answer them and run "drovr start ${program}"${unnoticed}`,
        null,
        null,
      );
    }
  }

  const pool = poolFrom(input.status, ceilings, now);
  if (pool.usableAccounts === 0) return hold('no usable accounts', pool, null);

  const running = inFlight(cycles, now, control.maxCycleHours);
  if (running.some((cycle) => cycle.program === program)) {
    return hold('a cycle for this program is already in flight', pool, null);
  }
  if (running.length >= control.maxConcurrentCycles) {
    return hold(
      `${running.length} cycles ahead of it, cap is ${control.maxConcurrentCycles}`,
      pool,
      null,
    );
  }

  const cap = entry?.maxCyclesPerDay ?? control.maxCyclesPerDay;
  const today = cyclesStartedSince(mine, now - DAY_MS);
  if (today >= cap) {
    return hold(
      `daily cap reached (${today}/${cap} cycles that did work). Raise it with ` +
        `\"drovr cap ${program} <n>\"`,
      pool,
      null,
    );
  }

  // Last, because everything above is a harder constraint. A program otherwise ready
  // to run and sitting on unanswered asks is waiting on Craig, and saying so is more
  // use than naming whichever check happened to fire.
  const owed = unansweredAsks(mine);
  if (owed !== null && (input.answeredAt ?? 0) <= owed.at) {
    return hold(
      `waiting on you — ${owed.asks} ask(s) raised ${Math.round((now - owed.at) / 60_000)}m ago ` +
        'and every cycle since has come back blocked' +
        (input.asksShared === false
          ? '. Shared notes are off on that page, so answer and run \"drovr start ' + program + '\"'
          : ''),
      pool,
      null,
    );
  }

  const offPace = paceExceeded(input, ceilings.weekly, pool.usableAccounts);
  if (offPace !== null) return hold(offPace, pool, null);

  const cost = estimateCycleCost(cycles, control.seedCycleCost);
  const funding = cyclesFundableFrom(pool, cost, running.length);
  const required = 1 + control.reserveCycles;
  if (funding.cycles < required) {
    const note = couplingNote(funding);
    return hold(
      `${funding.binding} tightest — funds ${funding.cycles.toFixed(2)} cycles ` +
        `(${running.length} ahead of it), need ${required.toFixed(2)}, ` +
        `recovers in ${untilText(pool.resetAt[funding.binding], now)}` +
        `${note === null ? '' : ` — ${note}`}`,
      pool,
      funding,
    );
  }

  const concentration = concentrationNote(funding, pool.usableAccounts);
  return {
    verdict: 'GO',
    reason:
      `funds ${funding.cycles.toFixed(2)} more cycles ` +
      `${sourcedFrom(funding, pool.usableAccounts)} ` +
      `(${running.length} ahead of it, ${funding.binding} tightest)` +
      `${concentration === null ? '' : ` — ${concentration}`}`,
    pool,
    cyclesFundable: funding.cycles,
    binding: funding.binding,
    earliestRecoveryAt: pool.earliestRecoveryAt,
  };
};

export const poolSnapshot = snapshot;
