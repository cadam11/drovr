import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { account, control, healthy, HOUR, NOW, status } from './fixtures.ts';

const input = () => ({
  status: healthy(),
  control: control({ programs: [{ name: 'demo', cwd: '/tmp/demo' }] }),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 60_000 },
  previews: new Map(),
  locks: new Map(),
  asksUrls: new Map(),
  queuedIntents: [],
});

test('buildState stamps a versioned, ISO-timestamped envelope', () => {
  const state = buildState(input());
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.generatedAt, new Date(NOW).toISOString());
});

test('buildState reports the binding bucket, not the soonest reset', () => {
  const state = buildState(input());
  assert.ok(['fable', 'general', 'session'].includes(state.bindingBucket));
});

test('buildState rounds floats so the JSON carries no float noise', () => {
  const state = buildState(input());
  const digits = (value: number) => (String(value).split('.')[1] ?? '').length;
  assert.ok(digits(state.pool.fable) <= 4);
  assert.ok(digits(state.cyclesFundable) <= 2);
});

test('buildState allocation segments sum to the bucket total', () => {
  const state = buildState(input());
  for (const bucket of ['fable', 'general', 'session'] as const) {
    const a = state.allocation[bucket];
    const sum = a.yoursSpent + a.programsSpent + a.programsReserved
      + a.programsAvailable + a.yoursReserved;
    assert.ok(Math.abs(sum - a.total) < 0.01, `${bucket} segments ${sum} != total ${a.total}`);
  }
});

test('buildState carries one entry per configured program, with a verdict', () => {
  const state = buildState(input());
  assert.equal(state.programs.length, 1);
  assert.equal(state.programs[0]!.name, 'demo');
  assert.ok(['GO', 'WAIT', 'STOP', 'RUN'].includes(state.programs[0]!.verdict));
});

test('buildState marks the service overdue past three intervals', () => {
  const stale = { ...input(), service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 4 * 600_000 } };
  assert.equal(buildState(stale).service.overdue, true);
  assert.equal(buildState(input()).service.overdue, false);
});

/**
 * decide() treats a cycle as in flight only within control.maxCycleHours (12 by
 * default), not inFlight()'s own 24h default. A call site that reached that default
 * instead of passing control.maxCycleHours explicitly (as decide() does) would still
 * count a 13h-old, never-ended cycle as running — showing 'RUN' for a program
 * decide() itself considers free to admit.
 *
 * This deliberately uses a live `Date.now()` rather than the frozen fixture `NOW`.
 * The bug this guards is a call site omitting `now` entirely and letting `inFlight`
 * fall back to its own `Date.now()` default — a frozen historical `now` would let
 * that fallback drift arbitrarily far from the fixture's clock and get silently
 * filtered out anyway, masking exactly the defect under test. `now` captured here
 * lands within the same instant the buggy default would have used, so a
 * reintroduced omission is caught regardless of which day this test runs.
 */
test('buildState stops counting a cycle as running once it is older than control.maxCycleHours, matching decide()', () => {
  const now = Date.now();
  const staleCycle = {
    v: 1 as const,
    kind: 'delivery' as const,
    program: 'demo',
    startedAt: new Date(now - 13 * HOUR).toISOString(),
    endedAt: null,
    exit: 'running' as const,
    poolBefore: { fable: 0, general: 0, session: 0 },
    poolAfter: null,
    startupTokens: null,
    yield: null,
    asksRaised: 0,
  };

  const state = buildState({
    status: healthy(),
    control: control({ programs: [{ name: 'demo', cwd: '/tmp/demo' }] }), // maxCycleHours defaults to 12
    cycles: [staleCycle],
    now,
    service: { loaded: true, intervalSeconds: 600, lastTickAt: now - 60_000 },
    previews: new Map(),
    locks: new Map(),
    asksUrls: new Map(),
    queuedIntents: [],
  });

  const demo = state.programs.find((program) => program.name === 'demo');
  assert.notEqual(demo?.verdict, 'RUN');
});

/**
 * The 13h test above catches a call site that drops control.maxCycleHours but
 * still passes a real now — it cannot catch a call site that drops only `now`,
 * because a dropped `now` falls back to inFlight's own live Date.now() default,
 * which lands within milliseconds of a live-clock test's own `now` and produces
 * the same answer either way. This test isolates that other half: a frozen,
 * historical `now` (2026-08-22) far from the real wall clock, with a cycle just
 * 2h before it — comfortably inside control.maxCycleHours (12h default either
 * way). If the passed `now` is honoured, the cycle is 2h old and counts as
 * running. If a call site silently substitutes real Date.now(), that same
 * `startedAt` is however many days in the past this test happens to run,
 * which is certainly outside any maxHours cutoff, and the assertion flips.
 */
test('buildState honours the passed now rather than the real wall clock for a recent cycle', () => {
  const recentCycle = {
    v: 1 as const,
    kind: 'delivery' as const,
    program: 'demo',
    startedAt: new Date(NOW - 2 * HOUR).toISOString(),
    endedAt: null,
    exit: 'running' as const,
    poolBefore: { fable: 0, general: 0, session: 0 },
    poolAfter: null,
    startupTokens: null,
    yield: null,
    asksRaised: 0,
  };

  const state = buildState({
    ...input(),
    cycles: [recentCycle],
  });

  const demo = state.programs.find((program) => program.name === 'demo');
  assert.equal(demo?.verdict, 'RUN');
});

/**
 * One account, deliberately thin on session headroom, funds one cycle's worth
 * of the tightest bucket but not two once the first is projected as running.
 * This is the sequential-admission projection restored per plan ruling 1
 * (mirroring src/watch.ts's programLines) — without it, both programs would
 * see the raw pool independently and both report GO.
 */
const scarcePool = () =>
  status([account({ name: 'a', fable: 0.2, general: 0.1, session: 0.0 })]);

const scarceInput = (programs: { name: string; cwd: string; priority: number }[]) => ({
  status: scarcePool(),
  control: control({ programs }),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 60_000 },
  previews: new Map(),
  locks: new Map(),
  asksUrls: new Map(),
  queuedIntents: [],
});

test('buildState admits only as many programs as the pool can fund, in priority order', () => {
  const state = buildState(scarceInput([
    { name: 'alpha', cwd: '/tmp/alpha', priority: 0 },
    { name: 'beta', cwd: '/tmp/beta', priority: 1 },
  ]));

  const alpha = state.programs.find((program) => program.name === 'alpha');
  const beta = state.programs.find((program) => program.name === 'beta');
  assert.equal(alpha?.verdict, 'GO');
  assert.notEqual(beta?.verdict, 'GO');
});

test('buildState changes which program wins scarce capacity when priority is reordered', () => {
  const promoted = buildState(scarceInput([
    { name: 'alpha', cwd: '/tmp/alpha', priority: 1 },
    { name: 'beta', cwd: '/tmp/beta', priority: 0 },
  ]));

  const alpha = promoted.programs.find((program) => program.name === 'alpha');
  const beta = promoted.programs.find((program) => program.name === 'beta');
  assert.equal(beta?.verdict, 'GO');
  assert.notEqual(alpha?.verdict, 'GO');
});

/**
 * CLAUDE.md's decide.ts trap: which bucket binds decides whether waiting is cheap or
 * the loop is done for the week, so the recovery time a renderer shows has to be that
 * bucket's own. Only hoursToWeeklyReset existed, and a panel showing "tightest bucket:
 * session" beside "resets in 3d" turns a two-hour hold into an apparent write-off.
 * The fixture's 5h resets are 2h out and its weekly ones 84h, so a field taking the
 * wrong one cannot pass by coincidence.
 */
test('buildState reports when the binding bucket recovers, not the weekly reset', () => {
  const state = buildState({
    ...input(),
    status: status([
      account({ name: 'a', fable: 0.1, general: 0.1, session: 0.99 }),
      account({ name: 'b', fable: 0.1, general: 0.1, session: 0.99 }),
    ]),
  });
  assert.equal(state.bindingBucket, 'session');
  assert.equal(state.bindingRecoveryAt, new Date(NOW + 2 * HOUR).toISOString());
  assert.equal(state.hoursToWeeklyReset, 84);
});

/** A weekly bind must not silently borrow the 5h clock either. */
test('buildState reports the weekly reset when a weekly bucket is what binds', () => {
  const state = buildState({
    ...input(),
    status: status([
      account({ name: 'a', fable: 0.99, general: 0.1, session: 0.0 }),
      account({ name: 'b', fable: 0.99, general: 0.1, session: 0.0 }),
    ]),
  });
  assert.equal(state.bindingBucket, 'fable');
  assert.equal(state.bindingRecoveryAt, new Date(NOW + 84 * HOUR).toISOString());
});
