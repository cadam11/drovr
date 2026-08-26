import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursToWeeklyReset, isUsable, poolFrom } from '../src/capacity.ts';
import { account, healthy, HOUR, NOW, status } from './fixtures.ts';
import { chargeForRunning, percentile } from '../src/ledger.ts';

const ceilings = { weekly: 0.55, session: 0.4 };

test('headroom is the gap to the ceiling, not the gap to full', () => {
  const pool = poolFrom(status([account({ name: 'a', fable: 0.15, general: 0.35 })]), ceilings, NOW);
  assert.equal(pool.fable.toFixed(2), '0.40');
  assert.equal(pool.general.toFixed(2), '0.20');
});

test('an account past the ceiling contributes zero, never a negative', () => {
  const pool = poolFrom(status([account({ name: 'a', fable: 0.99, general: 0.99 })]), ceilings, NOW);
  assert.equal(pool.fable, 0);
  assert.equal(pool.general, 0);
});

test('a null 5h bucket means no window is open, so the session budget is full', () => {
  const pool = poolFrom(status([account({ name: 'a', session: null })]), ceilings, NOW);
  assert.equal(pool.session.toFixed(2), '0.40');
});

test('disabled and rate-limited accounts drop out of the pool', () => {
  const pool = poolFrom(
    status([
      account({ name: 'a', fable: 0.1, general: 0.1 }),
      account({ name: 'b', fable: 0.1, general: 0.1, disabled: true }),
      account({ name: 'c', fable: 0.1, general: 0.1, rateLimitedUntil: NOW + HOUR }),
    ]),
    ceilings,
    NOW,
  );
  assert.equal(pool.usableAccounts, 1);
});

test('a rate limit that has already expired stops excluding the account', () => {
  const expired = account({ name: 'a', rateLimitedUntil: NOW - HOUR });
  assert.equal(isUsable(expired, NOW), true);
});

test('pools sum across accounts because rotation is per-request', () => {
  const pool = poolFrom(healthy(), ceilings, NOW);
  assert.equal(pool.usableAccounts, 3);
  assert.equal(pool.fable.toFixed(2), '1.40');
});

test('earliest recovery is the soonest future reset among usable accounts', () => {
  const pool = poolFrom(
    status([
      account({ name: 'a', weeklyResetInHours: 90 }),
      account({ name: 'b', weeklyResetInHours: 19 }),
    ]),
    ceilings,
    NOW,
  );
  assert.equal(pool.earliestRecoveryAt, NOW + 19 * HOUR);
});

test('hoursToWeeklyReset ignores accounts that are out of the pool', () => {
  const hours = hoursToWeeklyReset(
    status([
      account({ name: 'a', weeklyResetInHours: 90 }),
      account({ name: 'b', weeklyResetInHours: 19, disabled: true }),
    ]),
    NOW,
  );
  assert.equal(hours, 90);
});


test('a cycle is priced at the expensive case, not the typical one', () => {
  // Measured 2026-08-26: 33 samples, median 0.10 session, max 0.58. A median
  // under-prices half of all cycles by construction, and the reserve is denominated
  // in this number — so a reserve sized for the typical cycle is not a reserve.
  assert.equal(percentile([0.01, 0.05, 0.1, 0.4, 0.58], 0.9), 0.58);
  assert.equal(percentile([0.01, 0.05, 0.1, 0.4, 0.58], 0.5), 0.1);
});

test('a percentile is always a cost some real cycle actually had', () => {
  // Nearest-rank, not interpolated: an invented number between two samples is not
  // evidence of anything.
  const samples = [0.1, 0.2, 0.3, 0.4];
  for (const fraction of [0, 0.25, 0.5, 0.75, 0.9, 1]) {
    assert.ok(samples.includes(percentile(samples, fraction)), String(fraction));
  }
});

const runningCycle = (before: { fable: number; general: number; session: number }) => ({
  v: 1 as const,
  kind: 'delivery' as const,
  program: 'demo',
  startedAt: new Date(NOW).toISOString(),
  endedAt: null,
  exit: 'running' as const,
  poolBefore: before,
  poolAfter: null,
  startupTokens: null,
  yield: null,
  asksRaised: 0,
});

const COST = { fable: 0.025, general: 0.02, session: 0.085 };

test('a cycle that has drained more than its price is charged what it took', () => {
  // The failure of 2026-08-25: three cycles each billed 0.085 session at admission
  // while draining 0.23 to 0.58, so drovr kept admitting against room already gone.
  const charged = chargeForRunning(
    [runningCycle({ fable: 1, general: 1, session: 1 })],
    { fable: 1, general: 1, session: 0.66 },
    COST,
  );
  // 0.34 session drained at 0.085 a cycle is four cycles' worth, not one.
  assert.equal(Math.round(charged), 4);
});

test('a cycle that just started still costs a whole cycle', () => {
  // It has drained nothing yet and is about to drain plenty; charging zero would let
  // the next tick admit another one immediately.
  const charged = chargeForRunning(
    [runningCycle({ fable: 1, general: 1, session: 1 })],
    { fable: 1, general: 1, session: 1 },
    COST,
  );
  assert.equal(charged, 1);
});

test('a window that reset mid-cycle leaves the estimate standing, not a credit', () => {
  // poolAfter > poolBefore is normal across a 5h reset. Treating that as negative
  // spend would have a running cycle *increase* what drovr believes it can admit.
  const charged = chargeForRunning(
    [runningCycle({ fable: 1, general: 1, session: 0.2 })],
    { fable: 1, general: 1, session: 0.9 },
    COST,
  );
  assert.equal(charged, 1);
});

test('several running cycles are each charged their own drain', () => {
  const charged = chargeForRunning(
    [
      runningCycle({ fable: 1, general: 1, session: 1 }),
      runningCycle({ fable: 1, general: 1, session: 0.83 }),
    ],
    { fable: 1, general: 1, session: 0.83 },
    COST,
  );
  // First drained 0.17 (two cycles' worth); second has drained nothing (floor of one).
  assert.equal(Math.round(charged), 3);
});
