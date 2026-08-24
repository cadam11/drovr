import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cyclesFundableFrom, decide } from '../src/decide.ts';
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
  assert.match(decision.reason, /tightest — funds/);
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

test('the coupled pool holds the loop and the reason names who is pinned by what', () => {
  const decision = run({
    status: coupled(),
    control: control({ seedCycleCost: COUPLED_COST }),
  });
  assert.equal(decision.verdict, 'WAIT');
  assert.equal(decision.cyclesFundable, 0);
  assert.equal(decision.binding, 'session');
  assert.equal(decision.earliestRecoveryAt, NOW + 2 * HOUR);
  assert.match(decision.reason, /no account has room in all three buckets/);
  assert.match(decision.reason, /session pins craig\.adam and karen\.adam/);
  assert.match(decision.reason, /fable pins craig/);
  // Appended, not prefixed: every surface clips from the right, so the verdict — what it
  // funds, what it needs, when it recovers — has to be the half that always survives.
  assert.ok(decision.reason.startsWith('session tightest —'), decision.reason);
  // Two wrapped lines at drovr watch's narrowest useful width (100 columns, 6 of indent).
  // Past this the note stops fitting on the one surface that also draws the free-looking
  // bars it exists to explain.
  assert.ok(decision.reason.length <= 188, `reason is ${decision.reason.length} chars`);
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
  assert.match(decision.reason, /recovers in 26m/);
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
  assert.match(shared.reason, /1 ahead of it/);
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

test('the binding bucket is named, so a 5h hold reads differently from a weekly one', () => {
  // Session is the tightest here: fable and general have room, the 5h window does not.
  const squeezed = status([account({ name: 'a', fable: 0.05, general: 0.05, session: 0.39 })]);
  const decision = run({ status: squeezed });
  assert.equal(decision.verdict, 'WAIT');
  assert.equal(decision.binding, 'session');
  assert.match(decision.reason, /session tightest/);
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
  assert.match(decision.reason, /recovers in 90h/);
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
