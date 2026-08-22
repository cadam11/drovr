import { hoursToWeeklyReset, poolFrom, type Pool } from './capacity.ts';
import { ceilingsFor, isPaused, type Control } from './control.ts';
import {
  consecutiveCrashes,
  consecutiveZeroYield,
  cyclesStartedSince,
  estimateCycleCost,
  inFlight,
  snapshot,
  spentSince,
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
};

const ratio = (available: number, cost: number): number =>
  cost <= 0 ? Number.POSITIVE_INFINITY : available / cost;

export type Funding = { cycles: number; binding: BucketName };

/**
 * The buckets are not a hierarchy: one Fable token decrements all three, so they
 * are simultaneous constraints and the tightest binds. Which one binds matters —
 * a 5h window is hours from recovery, a weekly one is days.
 */
export const cyclesFundableFrom = (pool: Pool, cost: CycleCost): Funding => {
  const buckets: BucketName[] = ['fable', 'general', 'session'];
  return buckets
    .map((bucket) => ({ cycles: ratio(pool[bucket], cost[bucket]), binding: bucket }))
    .reduce((tightest, candidate) => (candidate.cycles < tightest.cycles ? candidate : tightest));
};

/**
 * Cycles already running have not yet shown up as spent quota, so admitting
 * against the raw pool would let N concurrent programs each claim all of it.
 */
const lessReserved = (pool: Pool, cost: CycleCost, running: number): Pool => ({
  ...pool,
  fable: Math.max(0, pool.fable - running * cost.fable),
  general: Math.max(0, pool.general - running * cost.general),
  session: Math.max(0, pool.session - running * cost.session),
});

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

  // Only recent crashes latch, so a fixed cause resumes without anyone clearing it.
  const crashes = consecutiveCrashes(mine, now, control.crashWindowMinutes);
  if (crashes >= control.stuckCycleThreshold) {
    return halt(
      `${crashes} crashes in the last ${control.crashWindowMinutes}m — see ` +
        `~/.drovr/logs/${program}-worker.log. Retries on its own once those age out, ` +
        `or run "drovr run-cycle ${program}" to try immediately.`,
    );
  }

  const ceilings = ceilingsFor(control);
  if (ceilings === null) return halt('mode is off');

  if (isPaused(control, now)) return hold(`paused until ${control.pauseUntil}`, null, null);

  const pool = poolFrom(input.status, ceilings, now);
  if (pool.usableAccounts === 0) return hold('no usable accounts', pool, null);

  const running = inFlight(cycles);
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

  const today = cyclesStartedSince(mine, now - DAY_MS);
  if (today >= control.maxCyclesPerDay) {
    return hold(`daily cap reached (${today}/${control.maxCyclesPerDay})`, pool, null);
  }

  const offPace = paceExceeded(input, ceilings.weekly, pool.usableAccounts);
  if (offPace !== null) return hold(offPace, pool, null);

  const cost = estimateCycleCost(cycles, control.seedCycleCost);
  const available = lessReserved(pool, cost, running.length);
  const funding = cyclesFundableFrom(available, cost);
  const required = 1 + control.reserveCycles;
  if (funding.cycles < required) {
    const recovers = pool.resetAt[funding.binding];
    const when = recovers === null ? 'unknown' : `${Math.round((recovers - now) / 3_600_000)}h`;
    return hold(
      `${funding.binding} tightest — funds ${funding.cycles.toFixed(2)} cycles ` +
        `(${running.length} ahead of it), need ${required.toFixed(2)}, recovers in ${when}`,
      pool,
      funding,
    );
  }

  return {
    verdict: 'GO',
    reason:
      `funds ${funding.cycles.toFixed(2)} more cycles across ${pool.usableAccounts} accounts ` +
      `(${running.length} ahead of it, ${funding.binding} tightest)`,
    pool,
    cyclesFundable: funding.cycles,
    binding: funding.binding,
    earliestRecoveryAt: pool.earliestRecoveryAt,
  };
};

export const poolSnapshot = snapshot;
