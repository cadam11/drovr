import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocationFor, type Allocation } from '../src/allocation.ts';
import { poolFrom } from '../src/capacity.ts';
import { estimateCycleCost } from '../src/ledger.ts';
import { account, NOW, status } from './fixtures.ts';

const ceilings = { weekly: 0.55, session: 0.4 };
const cost = { fable: 0.1, general: 0.08, session: 0.25 };

const build = (overrides: Partial<Parameters<typeof allocationFor>[0]> = {}): Allocation => {
  const state = overrides.status ?? status([account({ name: 'a', general: 0.3, fable: 0.2 })]);
  return allocationFor({
    status: state,
    pool: poolFrom(state, ceilings, NOW),
    bucket: 'general',
    spentByPrograms: 0,
    runningCycles: 0,
    cycleCost: cost,
    now: NOW,
    ...overrides,
  });
};

const sum = (a: Allocation): number =>
  a.yoursSpent + a.programsSpent + a.programsReserved + a.programsAvailable + a.yoursReserved;

test('the segments always stack to the whole pool', () => {
  assert.equal(sum(build()).toFixed(6), '1.000000');
});

test('usage not in the ledger is attributed to Craig, not to programs', () => {
  const a = build({ spentByPrograms: 0 });
  assert.equal(a.yoursSpent.toFixed(2), '0.30');
  assert.equal(a.programsSpent, 0);
});

test('ledger spend is carved out of used, not added on top', () => {
  const a = build({ spentByPrograms: 0.2 });
  assert.equal(a.programsSpent.toFixed(2), '0.20');
  assert.equal(a.yoursSpent.toFixed(2), '0.10');
  assert.equal(sum(a).toFixed(6), '1.000000');
});

test('everything above the ceiling is held for Craig', () => {
  // ceiling 0.55 of one account leaves 0.45 that drovr can never reach.
  assert.equal(build().yoursReserved.toFixed(2), '0.45');
});

test('in-flight cycles move capacity from available to reserved', () => {
  const idle = build();
  const busy = build({ runningCycles: 2 });
  assert.equal(busy.programsReserved.toFixed(2), '0.16');
  assert.equal(busy.programsAvailable.toFixed(2), (idle.programsAvailable - 0.16).toFixed(2));
  assert.equal(sum(busy).toFixed(6), '1.000000');
});

test('Craig overspending his share squeezes the program budget to zero, not below', () => {
  const heavy = status([account({ name: 'a', general: 0.9 })]);
  const a = build({ status: heavy, pool: poolFrom(heavy, ceilings, NOW) });
  assert.equal(a.programsAvailable, 0);
  assert.equal(a.yoursSpent.toFixed(2), '0.90');
  assert.equal(sum(a).toFixed(6), '1.000000');
});

test('the pool scales with the number of usable accounts', () => {
  const three = status([
    account({ name: 'a', general: 0.1 }),
    account({ name: 'b', general: 0.1 }),
    account({ name: 'c', general: 0.1, disabled: true }),
  ]);
  const a = build({ status: three, pool: poolFrom(three, ceilings, NOW) });
  assert.equal(a.total, 2);
  assert.equal(sum(a).toFixed(6), '2.000000');
});

test('a ledger overstating spend cannot invent usage that is not there', () => {
  const a = build({ spentByPrograms: 5 });
  assert.equal(a.programsSpent.toFixed(2), '0.30');
  assert.equal(a.yoursSpent, 0);
});

test('headroom matches the pool, so the bar cannot contradict the verdict', () => {
  // One account over its ceiling must not consume another account's headroom.
  const mixed = status([
    account({ name: 'ok', general: 0.08 }),
    account({ name: 'blown', general: 0.99 }),
  ]);
  const pool = poolFrom(mixed, ceilings, NOW);
  const a = build({ status: mixed, pool });
  assert.equal(a.programsAvailable.toFixed(2), pool.general.toFixed(2));
  assert.equal(sum(a).toFixed(6), '2.000000');
});

test('reservations never exceed the headroom they draw from', () => {
  const a = build({ runningCycles: 99 });
  assert.equal(a.programsAvailable, 0);
  assert.ok(a.programsReserved <= 0.25 + 1e-9);
  assert.equal(sum(a).toFixed(6), '1.000000');
});

test('a 5h window that reset mid-cycle is discarded, not recorded as zero cost', () => {
  // Cycles run for hours, so the 5h bucket resetting mid-flight is the normal case.
  // Counting those as zero would drag the median down until session stopped binding.
  const spanning = [1, 2, 3].map((index) => ({
    v: 1 as const,
    kind: 'delivery' as const,
    program: 'demo',
    startedAt: new Date(NOW - index * 3_600_000).toISOString(),
    endedAt: new Date(NOW).toISOString(),
    exit: 'context' as const,
    poolBefore: { fable: 1, general: 1, session: 0.3 },
    poolAfter: { fable: 0.9, general: 0.92, session: 0.8 },
    startupTokens: null,
    yield: null,
    asksRaised: 0,
  }));
  const seed = { fable: 0.1, general: 0.08, session: 0.25 };
  const cost = estimateCycleCost(spanning, seed);
  assert.equal(cost.fable.toFixed(3), '0.100');
  assert.equal(cost.session, seed.session);
});

test('a bucket with enough clean samples still learns while another falls back', () => {
  const clean = [1, 2, 3].map((index) => ({
    v: 1 as const,
    kind: 'delivery' as const,
    program: 'demo',
    startedAt: new Date(NOW - index * 3_600_000).toISOString(),
    endedAt: new Date(NOW).toISOString(),
    exit: 'context' as const,
    poolBefore: { fable: 1, general: 1, session: 0.9 },
    poolAfter: { fable: 0.8, general: 0.92, session: 0.5 },
    startupTokens: null,
    yield: null,
    asksRaised: 0,
  }));
  const cost = estimateCycleCost(clean, { fable: 0.1, general: 0.08, session: 0.25 });
  assert.equal(cost.session.toFixed(3), '0.400');
  assert.equal(cost.fable.toFixed(3), '0.200');
});
