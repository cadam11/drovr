import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyclesFundableFrom, decide } from '../src/decide.ts';
import { poolFrom } from '../src/capacity.ts';
import type { CycleRecord } from '../src/ledger.ts';
import { account, control, healthy, HOUR, NOW, status } from './fixtures.ts';

const cycle = (overrides: Partial<CycleRecord> = {}): CycleRecord => ({
  v: 1,
  kind: 'delivery',
  program: 'demo',
  startedAt: new Date(NOW - 2 * HOUR).toISOString(),
  endedAt: new Date(NOW - HOUR).toISOString(),
  exit: 'context',
  poolBefore: { fable: 1.4, general: 1.4, session: 1.2 },
  poolAfter: { fable: 1.3, general: 1.32, session: 0.95 },
  startupTokens: 12_000,
  yield: { ticketsMoved: 2, prsOpened: 1, commits: 6 },
  asksRaised: 0,
  ...overrides,
});

const run = (overrides: {
  program?: string;
  status?: ReturnType<typeof healthy>;
  control?: ReturnType<typeof control>;
  cycles?: CycleRecord[];
} = {}) =>
  decide({
    status: overrides.status ?? healthy(),
    control: overrides.control ?? control(),
    cycles: overrides.cycles ?? [],
    program: overrides.program ?? 'demo',
    now: NOW,
  });

test('a healthy pool admits a cycle', () => {
  const decision = run();
  assert.equal(decision.verdict, 'GO');
  assert.ok(decision.cyclesFundable !== null && decision.cyclesFundable > 1.5);
});

test('mode off stops rather than waits', () => {
  assert.equal(run({ control: control({ mode: 'off' }) }).verdict, 'STOP');
});

test('an active pause holds the loop whatever the capacity', () => {
  const paused = control({ pauseUntil: new Date(NOW + HOUR).toISOString() });
  const decision = decide({ status: healthy(), control: paused, cycles: [], program: 'demo', now: NOW });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /paused until/);
});

test('an expired pause no longer holds the loop', () => {
  const stale = control({ pauseUntil: new Date(NOW - HOUR).toISOString() });
  assert.equal(
    decide({ status: healthy(), control: stale, cycles: [], program: 'demo', now: NOW }).verdict,
    'GO',
  );
});

test('fable headroom without general headroom funds nothing', () => {
  // The karen case: 21% fable left, general already at the wall. The runner
  // would start and its Opus subagents would immediately fail.
  const trap = status([account({ name: 'karen', fable: 0.79, general: 0.99, session: null })]);
  const decision = run({ status: trap });
  assert.equal(decision.verdict, 'WAIT');
  assert.equal(decision.pool?.general, 0);
  assert.equal(decision.cyclesFundable, 0);
});

test('a pool that cannot fund a whole cycle plus reserve waits', () => {
  const thin = status([account({ name: 'a', fable: 0.5, general: 0.5, session: 0.35 })]);
  const decision = run({ status: thin });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /pool funds/);
});

test('the reserve is what separates admitting from refusing a marginal pool', () => {
  const marginal = status([account({ name: 'a', fable: 0.44, general: 0.45, session: 0.13 })]);
  const strict = run({ status: marginal, control: control({ reserveCycles: 0.5 }) });
  const lax = run({ status: marginal, control: control({ reserveCycles: 0 }) });
  assert.equal(strict.verdict, 'WAIT');
  assert.equal(lax.verdict, 'GO');
});

test('the daily cap holds the loop even with capacity to spare', () => {
  const today = Array.from({ length: 8 }, (_unused, index) =>
    cycle({ startedAt: new Date(NOW - (index + 1) * 60_000).toISOString() }),
  );
  const decision = run({ cycles: today, control: control({ maxCyclesPerDay: 8 }) });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /daily cap/);
});

test('cycles older than a day do not count against the daily cap', () => {
  const yesterday = Array.from({ length: 8 }, () =>
    cycle({ startedAt: new Date(NOW - 30 * HOUR).toISOString() }),
  );
  assert.equal(run({ cycles: yesterday, control: control({ maxCyclesPerDay: 8 }) }).verdict, 'GO');
});

test('consecutive zero-yield cycles stop the loop instead of burning the week', () => {
  const barren = Array.from({ length: 3 }, () =>
    cycle({ yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 } }),
  );
  const decision = run({ cycles: barren });
  assert.equal(decision.verdict, 'STOP');
  assert.match(decision.reason, /no yield/);
});

test('a productive cycle clears the zero-yield streak', () => {
  const mixed = [
    cycle({ yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 } }),
    cycle({ yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 } }),
    cycle(),
  ];
  assert.equal(run({ cycles: mixed }).verdict, 'GO');
});

test('spending ahead of the linear weekly entitlement waits', () => {
  // 84h left of a 168h window means half elapsed: entitlement is half the ceiling.
  const heavy = Array.from({ length: 6 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * HOUR).toISOString(),
      poolBefore: { fable: 1.4, general: 1.4, session: 1.2 },
      poolAfter: { fable: 1.2, general: 1.2, session: 1.0 },
    }),
  );
  const decision = run({ cycles: heavy });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /ahead of pace/);
});

test('away mode raises the entitlement enough to keep running', () => {
  const heavy = Array.from({ length: 6 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * HOUR).toISOString(),
      poolBefore: { fable: 1.4, general: 1.4, session: 1.2 },
      poolAfter: { fable: 1.2, general: 1.2, session: 1.0 },
    }),
  );
  assert.equal(run({ cycles: heavy, control: control({ mode: 'away' }) }).verdict, 'GO');
});

test('cyclesFundable is bound by the scarcest of the three buckets', () => {
  const pool = poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW);
  const fundable = cyclesFundableFrom(pool, { fable: 0.1, general: 0.1, session: 0.6 });
  assert.equal(fundable.toFixed(2), '2.00');
});

test('a zero-cost bucket does not constrain funding', () => {
  const pool = poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW);
  assert.equal(Number.isFinite(cyclesFundableFrom(pool, { fable: 0, general: 0, session: 0 })), false);
});

test('a program with a cycle already in flight does not start a second one', () => {
  const running = cycle({ endedAt: null, exit: 'running', poolAfter: null, yield: null });
  const decision = run({ cycles: [running] });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /already in flight/);
});

test('another program in flight reserves capacity from the shared pool', () => {
  // Without the reservation each program would see the whole pool and all would start.
  const elsewhere = cycle({ program: 'other', endedAt: null, exit: 'running', poolAfter: null, yield: null });
  const thin = status([account({ name: 'a', fable: 0.3, general: 0.3, session: 0.0 })]);
  const alone = run({ status: thin });
  const shared = run({ status: thin, cycles: [elsewhere] });
  assert.equal(alone.verdict, 'GO');
  assert.equal(shared.verdict, 'WAIT');
  assert.match(shared.reason, /1 in flight/);
});

test('the concurrency cap holds even when capacity is plentiful', () => {
  const running = ['x', 'y'].map((name) =>
    cycle({ program: name, endedAt: null, exit: 'running', poolAfter: null, yield: null }),
  );
  const decision = run({ cycles: running, control: control({ maxConcurrentCycles: 2 }) });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /cap is 2/);
});

test('a finished cycle stops counting as in flight', () => {
  const startThenEnd = [
    cycle({ endedAt: null, exit: 'running', poolAfter: null, yield: null }),
    cycle({ exit: 'seam' }),
  ];
  assert.equal(run({ cycles: startThenEnd }).verdict, 'GO');
});

test('pace counts every program, since they share one quota pool', () => {
  const heavy = Array.from({ length: 6 }, (_unused, index) =>
    cycle({
      program: index % 2 === 0 ? 'demo' : 'other',
      startedAt: new Date(NOW - (index + 1) * HOUR).toISOString(),
      poolBefore: { fable: 1.4, general: 1.4, session: 1.2 },
      poolAfter: { fable: 1.2, general: 1.2, session: 1.0 },
    }),
  );
  const decision = run({ cycles: heavy });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /all programs/);
});

test('the daily cap counts only this program', () => {
  const others = Array.from({ length: 8 }, () =>
    cycle({ program: 'other', startedAt: new Date(NOW - HOUR).toISOString() }),
  );
  assert.equal(run({ cycles: others, control: control({ maxCyclesPerDay: 8 }) }).verdict, 'GO');
});

test('the stuck streak counts only this program', () => {
  const barren = Array.from({ length: 3 }, () =>
    cycle({ program: 'other', yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 } }),
  );
  assert.equal(run({ cycles: barren }).verdict, 'GO');
});
