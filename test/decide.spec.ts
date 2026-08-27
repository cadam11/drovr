import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contributingAccounts, cyclesFundableFrom, decide, programReadiness, requiredCycles } from '../src/decide.ts';
import { poolFrom } from '../src/capacity.ts';
import { inFlight, type CycleRecord } from '../src/ledger.ts';
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
  runnerPresent?: boolean;
} = {}) =>
  decide({
    status: overrides.status ?? healthy(),
    control: overrides.control ?? control(),
    cycles: overrides.cycles ?? [],
    program: overrides.program ?? 'demo',
    now: NOW,
    ...(overrides.runnerPresent === undefined ? {} : { runnerPresent: overrides.runnerPresent }),
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
  assert.match(decision.reason, /a start needs/);
  assert.match(decision.note ?? '', /is tightest/);
});

test('the reserve is what separates admitting from refusing a marginal pool', () => {
  // Bound on fable, deliberately: reserveCycles now only applies to the weekly buckets,
  // so a session-bound pool would answer the same either way and prove nothing.
  const marginal = status([account({ name: 'a', fable: 0.44, general: 0.45, session: 0 })]);
  const strict = run({ status: marginal, control: control({ reserveCycles: 0.5 }) });
  const lax = run({ status: marginal, control: control({ reserveCycles: 0 }) });
  assert.equal(strict.verdict, 'WAIT', strict.reason);
  assert.match(strict.note ?? '', /fable is tightest/);
  assert.equal(lax.verdict, 'GO', lax.reason);
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

/**
 * Six cycles spending 0.2 each, with the accounts showing that spend. The consistency
 * matters: an earlier version of these two tests left the accounts nearly untouched while
 * the ledger claimed 1.2 units spent, which is not a state the pool can be in — real usage
 * is never below drovr's own. The old gate read the ceiling and never noticed; the re-based
 * one reads the pool, so the fixture has to be physically reachable to mean anything.
 */
const heavyWeek = () => ({
  // 1.2 units spent across three accounts is 0.4 apiece.
  status: status([
    account({ name: 'a', fable: 0.4, general: 0.4, session: 0 }),
    account({ name: 'b', fable: 0.4, general: 0.4, session: 0 }),
    account({ name: 'c', fable: 0.4, general: 0.4, session: 0 }),
  ]),
  cycles: Array.from({ length: 6 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * HOUR).toISOString(),
      poolBefore: { fable: 1.4, general: 1.4, session: 1.2 },
      poolAfter: { fable: 1.2, general: 1.2, session: 1.0 },
    }),
  ),
});

test('spending ahead of the linear weekly entitlement waits', () => {
  // 84h left of a 168h window means half elapsed: 1.2 spent of a 1.65 allowance.
  const decision = run(heavyWeek());
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /ahead of pace/);
});

test('away mode raises the entitlement enough to keep running', () => {
  assert.equal(run({ ...heavyWeek(), control: control({ mode: 'away' }) }).verdict, 'GO');
});

/**
 * The re-basing is a generalisation, not a different policy: when Craig has spent nothing,
 * `pool + spent` *is* `weeklyCeiling × usableAccounts`, and the new gate reduces exactly to
 * the old one. It only diverges to the extent he is actually consuming the pool — which is
 * the whole reason it was changed.
 */
test('pace reduces to the old ceiling-based entitlement when Craig has spent nothing', () => {
  const CEILING = 0.55;
  const ACCOUNTS = 3;
  const drovrSpent = 1.2;
  // Accounts show drovr's spend and nothing else, so the pool holds the rest of the ceiling.
  const poolRemaining = ACCOUNTS * CEILING - drovrSpent;
  assert.equal(Number((poolRemaining + drovrSpent).toFixed(2)), Number((CEILING * ACCOUNTS).toFixed(2)));
});

test('cyclesFundable is bound by the scarcest of the three buckets', () => {
  const pool = poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW);
  const fundable = cyclesFundableFrom(pool, { fable: 0.1, general: 0.1, session: 0.6 }, 0);
  assert.equal(fundable.binding, 'session');
  assert.equal(fundable.cycles.toFixed(2), "2.00");
});

test('a zero-cost bucket does not constrain funding', () => {
  const pool = poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW);
  assert.equal(
    Number.isFinite(cyclesFundableFrom(pool, { fable: 0, general: 0, session: 0 }, 0).cycles),
    false,
  );
});

/**
 * Observed live 2026-08-24, and the reason this file exists in its current shape:
 * `drovr status` reported 6.3 cycles fundable while every account was pinned in at
 * least one bucket. Summing each bucket across accounts and taking the min afterwards
 * counts headroom that cannot be spent — min-of-sums is not sum-of-mins.
 */
const coupled = () =>
  status([
    account({ name: 'first@example.com', fable: 0.22, general: 0.2, session: 0.98 }),
    account({ name: 'second@example.com', fable: 0.07, general: 0.08, session: 0.66 }),
    account({ name: 'fourth@example.com', fable: 0.98, general: 0.9, session: 0.0 }),
  ]);

const COUPLED_COST = { fable: 0.025, general: 0.02, session: 0.063 };

test('an account only contributes what its own tightest bucket allows', () => {
  const pool = poolFrom(coupled(), { weekly: 0.55, session: 0.4 }, NOW);
  // What the pooled sums say on their own, and what drovr used to answer.
  assert.equal(pool.fable.toFixed(2), '0.81');
  assert.equal(pool.general.toFixed(2), '0.82');
  assert.equal(pool.session.toFixed(2), '0.40');
  assert.equal(Math.min(0.81 / 0.025, 0.82 / 0.02, 0.4 / 0.063).toFixed(1), '6.3');

  const funding = cyclesFundableFrom(pool, COUPLED_COST, 0);
  assert.equal(funding.cycles, 0);
});

test('with every account at zero the binding bucket is the one that recovers first', () => {
  // session pins the two propra accounts and recovers in hours; fable pins
  // memberjunction and is days away. Reporting fable would read as a write-off.
  const pool = poolFrom(coupled(), { weekly: 0.55, session: 0.4 }, NOW);
  const funding = cyclesFundableFrom(pool, COUPLED_COST, 0);
  assert.equal(funding.binding, 'session');
  assert.equal(pool.resetAt.session, NOW + 2 * HOUR);
});

test('the coupled pool holds the loop and the note names who is pinned by what', () => {
  const decision = run({
    status: coupled(),
    control: control({ seedCycleCost: COUPLED_COST }),
  });
  assert.equal(decision.verdict, 'WAIT');
  assert.equal(decision.cyclesFundable, 0);
  assert.equal(decision.binding, 'session');
  assert.equal(decision.earliestRecoveryAt, NOW + 2 * HOUR);
  // The coupling lives on the shared note, not the per-program reason: every program
  // shares one pool, and repeating the same sentence on every row is what the
  // reason/note split exists to stop.
  assert.match(decision.note ?? '', /no account has room in all three buckets/);
  assert.match(decision.note ?? '', /session on craig\.adam and karen\.adam/);
  assert.match(decision.note ?? '', /fable is full on craig/);
  assert.match(decision.reason, /a start needs 1\.00/);
  // watch.ts's REASON_BUDGET: what its wrapped detail lines preserve, whatever the
  // window. The reason and the note are drawn on separate lines, so each gets the budget.
  assert.ok(decision.reason.length <= 200, `reason is ${decision.reason.length} chars`);
  assert.ok((decision.note ?? '').length <= 200, `note is ${decision.note?.length} chars`);
});

test('at zero the reported bucket is the soonest reset, not whichever account is listed first', () => {
  // Every account funds zero, so "the account with the most to give" degenerates to the
  // first one — and here that is memberjunction, pinned on fable with a weekly reset 60h
  // out. The propra account is pinned on the 5h window and recovers in two. Reporting fable
  // would read as the week written off; CLAUDE.md calls getting this wrong actively
  // misleading, and it is what earliestRecoveryAt is read from.
  const fablePinnedFirst = status([
    account({
      name: 'fourth@example.com',
      fable: 0.98, general: 0.9, session: 0.0, weeklyResetInHours: 60,
    }),
    account({ name: 'first@example.com', fable: 0.22, general: 0.2, session: 0.98 }),
  ]);
  const pool = poolFrom(fablePinnedFirst, { weekly: 0.55, session: 0.4 }, NOW);
  const funding = cyclesFundableFrom(pool, COUPLED_COST, 0);

  assert.equal(funding.cycles, 0);
  assert.equal(funding.accounts[0]!.binding, 'fable');
  assert.equal(pool.resetAt.fable, NOW + 60 * HOUR);
  assert.equal(pool.resetAt.session, NOW + 2 * HOUR);
  assert.equal(funding.binding, 'session');
});

test('a wait shorter than an hour is reported in minutes, not rounded to 0h', () => {
  // Math.round on 26 minutes gave "recovers in 0h", which reads as any moment now for a
  // wait that is not — the same class of misreport as naming the wrong bucket.
  const soon = status([
    account({ name: 'a', fable: 0.05, general: 0.05, session: 0.39 }),
  ]);
  soon.accounts[0]!.quota.unified5hReset = NOW + 26 * 60_000;
  const decision = run({ status: soon });
  assert.equal(decision.binding, 'session');
  assert.match(decision.note ?? '', /more room in 26m/);
});

test('one account with room in all three funds its own minimum, not the pooled sum', () => {
  // b and c are pinned on session; only a can serve, and only up to its own tightest
  // bucket. The pooled sums would have offered b and c's weekly headroom as well.
  const lopsided = status([
    account({ name: 'a', fable: 0.35, general: 0.35, session: 0.1 }),
    account({ name: 'b', fable: 0.05, general: 0.05, session: 0.95 }),
    account({ name: 'c', fable: 0.05, general: 0.05, session: 0.95 }),
  ]);
  const pool = poolFrom(lopsided, { weekly: 0.55, session: 0.4 }, NOW);
  const funding = cyclesFundableFrom(pool, { fable: 0.1, general: 0.1, session: 0.1 }, 0);
  // a: min(0.20/0.1, 0.20/0.1, 0.30/0.1) = 2.0. b and c contribute nothing.
  assert.equal(funding.cycles.toFixed(2), '2.00');
  assert.equal(funding.binding, 'fable');
});

test('a healthy multi-account pool still funds normally', () => {
  const funding = cyclesFundableFrom(
    poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW),
    { fable: 0.1, general: 0.08, session: 0.25 },
    0,
  );
  // Three accounts, each held to 0.4/0.25 = 1.6 cycles by its 5h window.
  assert.equal(funding.cycles.toFixed(2), '4.80');
  assert.equal(funding.binding, 'session');
});

test('in-flight cycles are reserved from the cycle count, not from any one bucket', () => {
  const pool = poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW);
  const cost = { fable: 0.1, general: 0.08, session: 0.25 };
  assert.equal(cyclesFundableFrom(pool, cost, 2).cycles.toFixed(2), '2.80');
  // Never negative: more cycles in flight than the pool can fund is a floor, not a debt.
  assert.equal(cyclesFundableFrom(pool, cost, 99).cycles, 0);
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
  assert.match(shared.reason, /1 running/);
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
  // Same consistent accounts as heavyWeek: the point is only that 'other' counts too.
  const decision = run({ ...heavyWeek(), cycles: heavy });
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

test('the binding bucket is named, so a 5h hold reads differently from a weekly one', () => {
  // Session is the tightest here: fable and general have room, the 5h window does not.
  const squeezed = status([account({ name: 'a', fable: 0.05, general: 0.05, session: 0.39 })]);
  const decision = run({ status: squeezed });
  assert.equal(decision.verdict, 'WAIT');
  assert.equal(decision.binding, 'session');
  assert.match(decision.note ?? '', /session is tightest/);
});

test('recovery time comes from the binding bucket, not the soonest reset overall', () => {
  // The 5h reset is 2h out and the weekly 90h out; a weekly-bound wait must not
  // claim it recovers in 2 hours.
  const weeklyBound = status([
    account({ name: 'a', fable: 0.05, general: 0.54, session: 0.0, weeklyResetInHours: 90 }),
  ]);
  const decision = run({ status: weeklyBound });
  assert.equal(decision.verdict, 'WAIT');
  assert.equal(decision.binding, 'general');
  assert.equal(decision.earliestRecoveryAt, NOW + 90 * HOUR);
  assert.match(decision.note ?? '', /more room in 90h/);
});

test('an in-flight cycle older than the watch window stops blocking its program', () => {
  // A SIGKILLed worker never writes an end record; without an age cutoff the
  // program would be blocked behind a phantom cycle forever.
  const abandoned = cycle({
    startedAt: new Date(NOW - 30 * HOUR).toISOString(),
    endedAt: null,
    exit: 'running',
    poolAfter: null,
    yield: null,
  });
  assert.equal(inFlight([abandoned], NOW, 24).length, 0);
  assert.equal(run({ cycles: [abandoned] }).verdict, 'GO');
});

test('a recent in-flight cycle is still counted', () => {
  const live = cycle({
    startedAt: new Date(NOW - 2 * HOUR).toISOString(),
    endedAt: null,
    exit: 'running',
    poolAfter: null,
    yield: null,
  });
  assert.equal(inFlight([live], NOW, 24).length, 1);
});

test('a disabled program reports STOP, since tick will never launch it', () => {
  const off = control({ programs: [{ name: 'demo', cwd: '/tmp/demo', enabled: false }] });
  const decision = decide({ status: healthy(), control: off, cycles: [], program: 'demo', now: NOW });
  assert.equal(decision.verdict, 'STOP');
  assert.match(decision.reason, /disabled/);
});

test('crashed cycles do not burn the daily cap', () => {
  // A burst of cycles that died on a broken PATH should not cost a program its day.
  const crashes = Array.from({ length: 8 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
      exit: 'crash',
      yield: null,
    }),
  );
  assert.equal(run({ cycles: crashes, control: control({ maxCyclesPerDay: 8 }) }).verdict, 'STOP');
  assert.equal(
    run({ cycles: crashes.slice(0, 2), control: control({ maxCyclesPerDay: 8 }) }).verdict,
    'GO',
  );
});

test('repeated crashes stop the loop, since nothing else catches a crash loop', () => {
  const crashes = Array.from({ length: 3 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
      exit: 'crash',
      yield: null,
    }),
  );
  const decision = run({ cycles: crashes });
  assert.equal(decision.verdict, 'STOP');
  assert.match(decision.reason, /crashed or stalled in the last/);
});

test('repeated stalls latch too, so a program that never delivers stops re-onboarding', () => {
  // Nudging a stalled runner is cheap once. A program that stalls every cycle would
  // otherwise loop start -> nudge x3 -> stalled -> start forever, paying full
  // onboarding each round for nothing.
  const stalls = Array.from({ length: 3 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
      exit: 'stalled',
      yield: null,
    }),
  );
  const decision = run({ cycles: stalls });
  assert.equal(decision.verdict, 'STOP');
  assert.match(decision.reason, /crashed or stalled in the last/);
});

test('a stalled cycle costs the program nothing against its daily cap', () => {
  // It sat at its prompt and delivered nothing; the failure latch bounds it instead.
  const stalls = Array.from({ length: 9 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * HOUR).toISOString(),
      exit: 'stalled',
      yield: null,
    }),
  );
  assert.notEqual(run({ cycles: stalls }).reason, undefined);
  assert.doesNotMatch(run({ cycles: stalls }).reason, /daily cap/);
});

test('crashes that have aged out stop latching, so a fixed cause resumes on its own', () => {
  // The whole point: an environment broken for twenty minutes and since fixed must
  // not keep a program stopped until someone clears it by hand.
  const old = Array.from({ length: 5 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 3) * HOUR).toISOString(),
      endedAt: new Date(NOW - (index + 3) * HOUR + 60_000).toISOString(),
      exit: 'crash',
      yield: null,
    }),
  );
  assert.equal(run({ cycles: old }).verdict, 'GO');
});

test('a crash loop still latches while it is actually looping', () => {
  const recent = Array.from({ length: 3 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
      endedAt: new Date(NOW - (index + 1) * 60_000 + 1_000).toISOString(),
      exit: 'crash',
      yield: null,
    }),
  );
  assert.equal(run({ cycles: recent }).verdict, 'STOP');
});

test('a deferred cycle costs the program nothing', () => {
  // A pane busy with a live session means the cycle never started: it must not
  // burn the daily cap, and it must not look like a crash.
  const deferrals = Array.from({ length: 8 }, (_unused, index) =>
    cycle({
      startedAt: new Date(NOW - (index + 1) * 60_000).toISOString(),
      endedAt: new Date(NOW - (index + 1) * 60_000 + 1_000).toISOString(),
      exit: 'deferred',
      yield: null,
    }),
  );
  assert.equal(run({ cycles: deferrals, control: control({ maxCyclesPerDay: 8 }) }).verdict, 'GO');
});

test('deferrals between crashes neither extend nor break the crash streak', () => {
  const mixed = [
    cycle({ startedAt: new Date(NOW - 3 * 60_000).toISOString(), endedAt: new Date(NOW - 3 * 60_000).toISOString(), exit: 'crash', yield: null }),
    cycle({ startedAt: new Date(NOW - 2 * 60_000).toISOString(), endedAt: new Date(NOW - 2 * 60_000).toISOString(), exit: 'deferred', yield: null }),
    cycle({ startedAt: new Date(NOW - 60_000).toISOString(), endedAt: new Date(NOW - 60_000).toISOString(), exit: 'crash', yield: null }),
  ];
  // Two real crashes, one deferral ignored: below the threshold of three.
  assert.equal(run({ cycles: mixed }).verdict, 'GO');
});

test('unanswered asks are named rather than whichever check happened to fire', () => {
  // A seam that raised asks, then nothing but blocked cycles: the program is owed a
  // reply, and saying "daily cap" would hide that.
  const history = [
    cycle({
      startedAt: new Date(NOW - 5 * HOUR).toISOString(),
      endedAt: new Date(NOW - 5 * HOUR).toISOString(),
      exit: 'seam',
      asksRaised: 2,
    }),
    cycle({
      startedAt: new Date(NOW - 4 * HOUR).toISOString(),
      endedAt: new Date(NOW - 4 * HOUR).toISOString(),
      exit: 'blocked',
      yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 },
    }),
    cycle({
      startedAt: new Date(NOW - 3 * HOUR).toISOString(),
      endedAt: new Date(NOW - 3 * HOUR).toISOString(),
      exit: 'blocked',
      yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 },
    }),
  ];
  const decision = run({ cycles: history });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /waiting on you — 2 ask\(s\)/);
});

test('a program that is simply idle is not reported as waiting on anyone', () => {
  assert.equal(run({ cycles: [cycle({ exit: 'seam', asksRaised: 0 })] }).verdict, 'GO');
});

test('an answer on the asks page ends the blocked wait immediately', () => {
  // The backoff is a stand-in for "Craig replied"; when the real event is visible
  // there is no reason to keep waiting for a timer.
  const blocked = cycle({
    startedAt: new Date(NOW - 10 * 60_000).toISOString(),
    endedAt: new Date(NOW - 9 * 60_000).toISOString(),
    exit: 'blocked',
    yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 },
  });
  const waiting = decide({
    status: healthy(),
    control: control(),
    cycles: [blocked],
    program: 'demo',
    now: NOW,
  });
  const answered = decide({
    status: healthy(),
    control: control(),
    cycles: [blocked],
    program: 'demo',
    now: NOW,
    answeredAt: NOW - 60_000,
  });
  assert.equal(waiting.verdict, 'WAIT');
  assert.equal(answered.verdict, 'GO');
});

test('an answer older than the blocked cycle does not count as a reply', () => {
  const blocked = cycle({
    startedAt: new Date(NOW - 10 * 60_000).toISOString(),
    endedAt: new Date(NOW - 9 * 60_000).toISOString(),
    exit: 'blocked',
    yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 },
  });
  const stale = decide({
    status: healthy(),
    control: control(),
    cycles: [blocked],
    program: 'demo',
    now: NOW,
    answeredAt: NOW - 30 * 60_000,
  });
  assert.equal(stale.verdict, 'WAIT');
});

test('when shared notes are off the message says so, since that is the blocker', () => {
  const blocked = cycle({
    startedAt: new Date(NOW - 10 * 60_000).toISOString(),
    endedAt: new Date(NOW - 9 * 60_000).toISOString(),
    exit: 'blocked',
    yield: { ticketsMoved: 0, prsOpened: 0, commits: 0 },
  });
  const decision = decide({
    status: healthy(),
    control: control(),
    cycles: [blocked],
    program: 'demo',
    now: NOW,
    asksShared: false,
  });
  assert.match(decision.reason, /shared notes/i);
});

test('an account the fable route refuses funds nothing, however healthy its buckets', () => {
  // teamclaude will never send a Fable request there, so its headroom is not drovr's
  // to spend. Live on 2026-08-25 two of three accounts were in exactly this state.
  const wide = status(
    [
      account({ name: 'a', fable: 0.0, general: 0.0, session: 0.0 }),
      account({ name: 'b', fable: 0.0, general: 0.0, session: 0.0 }),
    ],
    ['b'],
  );
  const funded = cyclesFundableFrom(
    poolFrom(wide, { weekly: 0.55, session: 0.4 }, NOW),
    { fable: 0.025, general: 0.02, session: 0.085 },
    0,
  );
  const b = funded.accounts.find((entry) => entry.name === 'b');
  assert.equal(b?.cycles, 0);
  assert.equal(b?.routable, false);
  assert.equal(contributingAccounts(funded), 1);
});

test('no declared fable route means no restriction, not that nothing is eligible', () => {
  // Absence of a route is drovr not knowing, and refusing every account on that basis
  // would stop the loop dead over missing information.
  const funded = cyclesFundableFrom(
    poolFrom(healthy(), { weekly: 0.55, session: 0.4 }, NOW),
    { fable: 0.025, general: 0.02, session: 0.085 },
    0,
  );
  assert.ok(funded.accounts.every((entry) => entry.routable));
  assert.equal(contributingAccounts(funded), 3);
});

test('a GO says how many accounts carry it, not just how many exist', () => {
  const lopsided = status(
    [
      account({ name: 'a', fable: 0.0, general: 0.0, session: 0.0 }),
      account({ name: 'b', fable: 0.0, general: 0.0, session: 0.0 }),
      account({ name: 'c', fable: 0.0, general: 0.0, session: 0.0 }),
    ],
    ['b', 'c'],
  );
  const decision = decide({ status: lopsided, control: control(), cycles: [], program: 'demo', now: NOW });
  assert.equal(decision.verdict, 'GO');
  assert.match(decision.reason, /from 1 of 3 accounts/);
  assert.match(decision.note ?? '', /no fallback/);
  assert.match(decision.note ?? '', /2 not routed for fable/);
});

test('a pool every account contributes to is not warned about', () => {
  const decision = decide({ status: healthy(), control: control(), cycles: [], program: 'demo', now: NOW });
  assert.equal(decision.verdict, 'GO');
  assert.match(decision.reason, /across 3 accounts/);
  assert.doesNotMatch(decision.note ?? '', /no fallback/);
});

/**
 * The re-based pace gate. The previous version granted `weeklyCeiling × usableAccounts ×
 * elapsed` while measuring spend from drovr's ledger alone, so Craig's foreground work
 * counted on neither side and the entitlement was always too large — it fired zero times
 * in 1008 live decisions. The allowance is now what drovr can actually reach.
 */
const paced = (overrides: {
  accountsAt: number;
  spends: number[];
  weeklyResetInHours?: number;
}) => {
  const at = overrides.accountsAt;
  const spent = (amount: number, index: number): CycleRecord =>
    cycle({
      startedAt: new Date(NOW - (20 - index) * HOUR).toISOString(),
      endedAt: new Date(NOW - (19 - index) * HOUR).toISOString(),
      exit: 'seam',
      poolBefore: { fable: 2, general: 2, session: 2 },
      poolAfter: { fable: 2 - amount, general: 2 - amount, session: 2 },
    });
  return run({
    status: status([
      account({ name: 'a', fable: at, general: at, session: 0, weeklyResetInHours: overrides.weeklyResetInHours ?? 84 }),
      account({ name: 'b', fable: at, general: at, session: 0, weeklyResetInHours: overrides.weeklyResetInHours ?? 84 }),
      account({ name: 'c', fable: at, general: at, session: 0, weeklyResetInHours: overrides.weeklyResetInHours ?? 84 }),
    ]),
    cycles: overrides.spends.map(spent),
  });
};

test('pace holds the loop when it has outspent the allowance Craig actually left it', () => {
  // Accounts at 0.50 against a 0.55 ceiling leave 0.15 units reachable pool-wide, and
  // drovr has already spent 0.40 of a 0.55 realised allowance half way through the week.
  const decision = paced({ accountsAt: 0.5, spends: [0.2, 0.2] });

  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /ahead of pace on (fable|general)/);
  assert.match(decision.reason, /50% through the window/);
  assert.match(decision.reason, /Clears as the week catches up/);
});

/**
 * The same reading under the old formulation: entitlement was 0.55 × 3 × 0.5 = 0.825
 * against 0.40 spent, so it passed. This asserts the gate can now see what it could not.
 */
test('pace: the old ceiling-based entitlement would have allowed that same spend', () => {
  const ceilingBasedEntitlement = 0.55 * 3 * 0.5;
  assert.ok(0.4 < ceilingBasedEntitlement, 'the old gate saw 0.40 spent as comfortably on pace');
});

test('pace lets the loop burst at the start of a window rather than refusing its first cycle', () => {
  // 1h into the week, so linear entitlement is near zero. One finished cycle is already
  // above that line; the burst allowance is what stops a smoothing gate from blocking
  // every window's first cycle.
  const decision = paced({ accountsAt: 0.05, spends: [0.05], weeklyResetInHours: 167 });
  assert.notEqual(decision.verdict, 'WAIT', decision.reason);
});

test('pace stays quiet when spend is inside a linear burn of the allowance', () => {
  const decision = paced({ accountsAt: 0.05, spends: [0.05, 0.05] });
  assert.equal(decision.verdict, 'GO', decision.reason);
});

test('pace does not read the session bucket, which has no week to be paced across', () => {
  // Session fully spent on every account: affordability must be what refuses, naming the
  // bucket, rather than a pace gate claiming a weekly problem.
  const decision = run({
    status: status([
      account({ name: 'a', fable: 0.05, general: 0.05, session: 0.95 }),
      account({ name: 'b', fable: 0.05, general: 0.05, session: 0.95 }),
    ]),
  });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.note ?? '', /session is tightest/);
});

/**
 * The three layers are separable, which is the point of the split: nothing in readiness
 * reads the pool, so a program that cannot run says so without a teamclaude read.
 */
test('programReadiness answers without a pool, and passes a program that is fit to run', () => {
  const base = {
    status: healthy(),
    cycles: [],
    program: 'demo',
    now: NOW,
  };

  const disabled = programReadiness({
    ...base,
    control: control({ programs: [{ name: 'demo', cwd: '/tmp/demo', enabled: false }] }),
  });
  assert.equal(disabled?.verdict, 'STOP');
  assert.equal(disabled?.pool, null, 'readiness never carries a pool it did not read');

  assert.equal(programReadiness({ ...base, control: control() }), null, 'a fit program returns null');
});

/**
 * The reserve guarantees a cycle can *land*. A weekly bucket running dry means days of
 * nothing, so a cycle admitted against it must be covered plus a reserve. The 5h window
 * refills four or five times a day and is documented as resetting mid-cycle, so running
 * dry there pauses a runner rather than cutting it off — a reserve denominated in whole
 * cycles is a rate limit being treated as a budget.
 *
 * Measured 2026-08-26: p90 session cost 0.390 against a `normal` session ceiling of 0.400,
 * so `1 + reserveCycles` demanded 0.585 of a window that only holds 0.400. No single
 * account could clear admission, by construction rather than by policy.
 */
const oneAccountAt = (session: number) =>
  run({
    status: status([account({ name: 'a', fable: 0.05, general: 0.05, session })]),
    // Five delivering cycles so the session cost estimate is measured, not seeded:
    // p90 of 0.39 against the 0.40 ceiling is the collision under test.
    cycles: Array.from({ length: 5 }, (_unused, index) =>
      cycle({
        startedAt: new Date(NOW - (12 - index) * HOUR).toISOString(),
        endedAt: new Date(NOW - (11 - index) * HOUR).toISOString(),
        exit: 'seam',
        poolBefore: { fable: 2, general: 2, session: 2 },
        poolAfter: { fable: 1.99, general: 1.99, session: 1.61 },
      }),
    ),
  });

test('a session-bound pool needs one cycle of room, not one plus the reserve', () => {
  // A fresh 5h window: 0.40 headroom against a 0.39 cycle is 1.03 cycles — under the old
  // 1.50 requirement this was refused however healthy the weekly buckets were.
  const decision = oneAccountAt(0);
  assert.equal(decision.verdict, 'GO', decision.reason);
  assert.match(decision.note ?? '', /session is tightest/);
});

test('a session-bound pool with less than one cycle of room still waits', () => {
  // 0.20 of the ceiling left is half a cycle: it would start and immediately idle.
  const decision = oneAccountAt(0.2);
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /a start needs 1\.00/, 'one cycle, not one plus the reserve');
});

test('a weekly-bound pool still has to cover the reserve', () => {
  // Session wide open, fable nearly gone: 1.2 cycles of fable is more than one cycle but
  // less than the reserve, and a dry weekly bucket is days rather than hours.
  const decision = run({
    // Late in the week, so the pace gate is not what answers: its line at 99% elapsed is
    // the whole allowance, and this test is about the reserve.
    status: status([
      account({ name: 'a', fable: 0.478, general: 0.05, session: 0, weeklyResetInHours: 1 }),
    ]),
    cycles: Array.from({ length: 5 }, (_unused, index) =>
      cycle({
        startedAt: new Date(NOW - (12 - index) * HOUR).toISOString(),
        endedAt: new Date(NOW - (11 - index) * HOUR).toISOString(),
        exit: 'seam',
        poolBefore: { fable: 2, general: 2, session: 2 },
        poolAfter: { fable: 1.94, general: 1.94, session: 1.99 },
      }),
    ),
  });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.note ?? '', /fable is tightest/);
  assert.match(decision.reason, /a start needs 1\.50/, 'the reserve applies where exhaustion means days');
});

/**
 * A leftover runner in the pane is the one thing that makes a program unstartable while
 * every gate says GO. Measured 2026-08-27: sunnyt's previous runner outlived its watch,
 * so each tick admitted a cycle, booked it as launched, then failed on PaneBusy and
 * recorded `deferred` — 38 times. The pane check lived inside runCycle, after admission,
 * so admission could not know.
 *
 * The cost was not the wasted launch. It was that the phantom launch charged a full cycle
 * against the pool for the rest of the tick, taking aice-x and joinery from 1.35 fundable
 * to 0.35 and refusing them both, every ten minutes, invisibly.
 */
test('a program whose runner still holds its pane is not admitted', () => {
  const decision = run({ runnerPresent: true });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /still holds its pane/);
  assert.match(decision.reason, /drovr-demo/, 'names the agent so it can be found');
});

test('a leftover runner is refused before the pool is charged for it', () => {
  // Ordering is the whole fix: refused here, it is never added to the tick's launched
  // list, so it cannot charge a cycle against the funding the other programs are testing.
  const decision = run({ runnerPresent: true });
  assert.equal(decision.cyclesFundable, null, 'no funding was computed, so none was claimed');
});

test('a present runner with a cycle actually in flight reports that, not a leftover', () => {
  const decision = run({
    runnerPresent: true,
    cycles: [cycle({ endedAt: null, exit: 'running', poolAfter: null })],
  });
  assert.equal(decision.verdict, 'WAIT');
  assert.match(decision.reason, /already in flight/, 'the normal case is not a leftover');
});

test('an absent runner leaves admission alone', () => {
  assert.equal(run({ runnerPresent: false }).verdict, 'GO');
  assert.equal(run({}).verdict, 'GO', 'omitted means unknown, which must not refuse');
});

/**
 * The waterline: each priority step down raises the admission bar by priorityStepCycles,
 * so as the pool drains the lowest-priority programs pause first and the last fundable
 * cycle always goes to the most important program. Before this, priority was only a
 * same-tick sort key — measured binding once in 1008 decisions — and the last cycle went
 * to whichever program happened to be free (docs/allocation-review.md, finding 3).
 */
const ranked = (overrides: Record<string, unknown> = {}) =>
  control({
    reserveCycles: 0.5,
    priorityStepCycles: 0.25,
    programs: [
      { name: 'alpha', cwd: '/tmp/alpha', priority: 1 },
      { name: 'beta', cwd: '/tmp/beta', priority: 3 },
      { name: 'gamma', cwd: '/tmp/gamma', priority: 9 },
    ],
    ...overrides,
  });

// One account, session-bound: 0.28 of headroom against the seeded 0.25 cost is ~1.12
// cycles — above the top program's bar of 1.00 and below everyone else's.
const draining = () =>
  status([account({ name: 'a', fable: 0.05, general: 0.05, session: 0.12 })]);

test('a draining pool runs the top program and holds the ones below it', () => {
  const alpha = run({ status: draining(), control: ranked(), program: 'alpha' });
  const beta = run({ status: draining(), control: ranked(), program: 'beta' });
  const gamma = run({ status: draining(), control: ranked(), program: 'gamma' });
  assert.equal(alpha.verdict, 'GO', alpha.reason);
  assert.equal(beta.verdict, 'WAIT');
  assert.equal(gamma.verdict, 'WAIT');
});

test('a flush pool runs every program, whatever its priority', () => {
  for (const program of ['alpha', 'beta', 'gamma']) {
    const decision = run({ status: healthy(), control: ranked(), program });
    assert.equal(decision.verdict, 'GO', `${program}: ${decision.reason}`);
  }
});

test('a priority hold names who the room is kept for and the bar to clear', () => {
  const beta = run({ status: draining(), control: ranked(), program: 'beta' });
  assert.match(beta.reason, /held back for alpha/);
  assert.match(beta.reason, /beta starts above 1\.25/);
  const gamma = run({ status: draining(), control: ranked(), program: 'gamma' });
  assert.match(gamma.reason, /held back for alpha and beta/);
});

test('below even the rank-0 bar the hold reads as capacity, not priority', () => {
  const empty = status([account({ name: 'a', fable: 0.05, general: 0.05, session: 0.38 })]);
  const beta = run({ status: empty, control: ranked(), program: 'beta' });
  assert.equal(beta.verdict, 'WAIT');
  assert.match(beta.reason, /a start needs/);
  assert.doesNotMatch(beta.reason, /held back/);
});

test('equal-priority programs face the same bar rather than losing to a name sort', () => {
  const tied = ranked({
    programs: [
      { name: 'alpha', cwd: '/tmp/alpha', priority: 1 },
      { name: 'beta', cwd: '/tmp/beta', priority: 1 },
      { name: 'gamma', cwd: '/tmp/gamma', priority: 9 },
    ],
  });
  const beta = run({ status: draining(), control: tied, program: 'beta' });
  assert.equal(beta.verdict, 'GO', beta.reason);
  // gamma sits one distinct step down, not two: ties share a rank.
  const gamma = run({ status: draining(), control: tied, program: 'gamma' });
  assert.match(gamma.reason, /gamma starts above 1\.25/);
});

test('a disabled program above does not deepen the bar', () => {
  const alphaOff = ranked({
    programs: [
      { name: 'alpha', cwd: '/tmp/alpha', priority: 1, enabled: false },
      { name: 'beta', cwd: '/tmp/beta', priority: 3 },
    ],
  });
  assert.equal(run({ status: draining(), control: alphaOff, program: 'beta' }).verdict, 'GO');
});

test('the waterline stacks on the weekly reserve, not instead of it', () => {
  assert.equal(requiredCycles('fable', ranked(), 1), 1.75);
  assert.equal(requiredCycles('session', ranked(), 1), 1.25);
  // Step zero restores priority to a same-tick tiebreak.
  assert.equal(requiredCycles('session', ranked({ priorityStepCycles: 0 }), 2), 1);
});
