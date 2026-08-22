import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoursToWeeklyReset, isUsable, poolFrom } from '../src/capacity.ts';
import { account, healthy, HOUR, NOW, status } from './fixtures.ts';

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
