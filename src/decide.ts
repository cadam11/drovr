import { hoursToWeeklyReset, poolFrom, type Pool } from './capacity.ts';
import { ceilingsFor, isPaused, type Control } from './control.ts';
import {
  consecutiveZeroYield,
  cyclesStartedSince,
  estimateCycleCost,
  inFlight,
  snapshot,
  spentSince,
  type CycleCost,
  type CycleRecord,
} from './ledger.ts';
import type { TeamclaudeStatus } from './teamclaude.ts';

const WEEKLY_WINDOW_HOURS = 168;
const DAY_MS = 86_400_000;

export type Verdict = 'GO' | 'WAIT' | 'STOP';

export type Decision = {
  verdict: Verdict;
  reason: string;
  pool: Pool | null;
  cyclesFundable: number | null;
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

export const cyclesFundableFrom = (pool: Pool, cost: CycleCost): number =>
  Math.min(
    ratio(pool.fable, cost.fable),
    ratio(pool.general, cost.general),
    ratio(pool.session, cost.session),
  );

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
  earliestRecoveryAt: null,
});

const hold = (reason: string, pool: Pool | null, fundable: number | null): Decision => ({
  verdict: 'WAIT',
  reason,
  pool,
  cyclesFundable: fundable,
  earliestRecoveryAt: pool?.earliestRecoveryAt ?? null,
});

export const decide = (input: DecideInput): Decision => {
  const { control, cycles, program, now } = input;
  const mine = cycles.filter((cycle) => cycle.program === program);

  if (control.mode === 'off') return halt('mode is off');

  const stuck = consecutiveZeroYield(mine);
  if (stuck >= control.stuckCycleThreshold) {
    return halt(`${stuck} consecutive cycles produced no yield — escalating instead of looping`);
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
      `${running.length} cycles in flight, cap is ${control.maxConcurrentCycles}`,
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
  const fundable = cyclesFundableFrom(available, cost);
  const required = 1 + control.reserveCycles;
  if (fundable < required) {
    return hold(
      `pool funds ${fundable.toFixed(2)} more cycles (${running.length} in flight), need ${required.toFixed(2)}`,
      pool,
      fundable,
    );
  }

  return {
    verdict: 'GO',
    reason: `pool funds ${fundable.toFixed(2)} more cycles across ${pool.usableAccounts} accounts (${running.length} in flight)`,
    pool,
    cyclesFundable: fundable,
    earliestRecoveryAt: pool.earliestRecoveryAt,
  };
};

export const poolSnapshot = snapshot;
