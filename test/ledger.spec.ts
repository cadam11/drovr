import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consecutiveFailures,
  cyclesStartedSince,
  estimateCycleCost,
  latestEnds,
  spentSince,
  type CycleCost,
  type CycleRecord,
} from '../src/ledger.ts';
import { HOUR, NOW } from './fixtures.ts';

const SEED: CycleCost = { fable: 0.1, general: 0.08, session: 0.25 };

const cycle = (overrides: Partial<CycleRecord> = {}): CycleRecord => ({
  v: 1,
  kind: 'delivery',
  program: 'demo',
  startedAt: new Date(NOW - 2 * HOUR).toISOString(),
  endedAt: new Date(NOW - HOUR).toISOString(),
  exit: 'seam',
  poolBefore: { fable: 1, general: 1, session: 1 },
  poolAfter: { fable: 0.9, general: 0.9, session: 0.9 },
  startupTokens: null,
  yield: { ticketsMoved: 1, prsOpened: 0, commits: 2 },
  asksRaised: 0,
  ...overrides,
});

/**
 * `maxCycleHours` bounds how long drovr *watches* a cycle. It does not bound the cycle,
 * because drovr never kills one — so at the deadline the watch exits while the runner is
 * still alive, and drovr is left holding a verdict about something it stopped observing.
 * Recording that as `crash` is a lie in the one direction that matters: it says the cycle
 * delivered nothing, and it throws away the quota sample of the most expensive cycles there
 * are. Measured 2026-08-27: sunnyt ran 12.8h, was recorded as a crash, and its spend was
 * excluded from the pricing every admission decision depends on.
 */
test('an abandoned cycle is a cost sample, because it really spent the quota', () => {
  // Distinct identities, because latestEnds collapses repeats of the same cycle — which
  // is the whole point of it, and which an earlier version of this fixture tripped over.
  const abandoned = (index: number) =>
    cycle({
      startedAt: new Date(NOW - (10 - index) * HOUR).toISOString(),
      exit: 'abandoned',
      poolBefore: { fable: 1, general: 1, session: 1 },
      poolAfter: { fable: 0.6, general: 0.6, session: 0.5 },
    });
  const cost = estimateCycleCost([abandoned(0), abandoned(1), abandoned(2)], SEED, 3, 0.9);
  assert.equal(Number(cost.fable.toFixed(2)), 0.4, 'a 12h cycle prices the expensive tail');
});

test('an abandoned cycle does not burn the daily cap, since delivery is unknown', () => {
  const abandoned = cycle({ exit: 'abandoned' });
  assert.equal(cyclesStartedSince([abandoned], 0), 0);
});

test('an abandoned cycle is not counted as a failure — it is not known to have failed', () => {
  const at = (index: number) =>
    cycle({ startedAt: new Date(NOW - (10 - index) * HOUR).toISOString(), exit: 'abandoned' });
  assert.equal(consecutiveFailures([at(0), at(1), at(2)], NOW, 60), 0);
});

/**
 * The reconciliation appends the truth rather than rewriting history, so both records
 * exist. Everything that measures a cycle has to read the last word on it, or an abandoned
 * cycle that later reported is counted twice — once as its understated abandonment cost and
 * once as its real one.
 */
test('a superseded record is not counted twice as a cost sample', () => {
  const started = new Date(NOW - 3 * HOUR).toISOString();
  const guess = cycle({ startedAt: started, exit: 'abandoned', poolAfter: { fable: 0.9, general: 0.9, session: 0.9 } });
  const truth = cycle({ startedAt: started, exit: 'seam', poolAfter: { fable: 0.5, general: 0.5, session: 0.5 } });

  const ends = latestEnds([guess, truth]);
  assert.equal(ends.length, 1, 'one cycle, one end record');
  assert.equal(ends[0]!.exit, 'seam', 'the later record wins');
});

test('a reconciled cycle does burn the daily cap, because it is now known to have delivered', () => {
  const started = new Date(NOW - 3 * HOUR).toISOString();
  const guess = cycle({ startedAt: started, exit: 'abandoned' });
  const truth = cycle({ startedAt: started, exit: 'seam' });
  assert.equal(cyclesStartedSince([guess], 0), 0, 'unknown delivery does not count');
  assert.equal(cyclesStartedSince([guess, truth], 0), 1, 'a known seam does');
});

test('latestEnds ignores start records, which carry no outcome', () => {
  const started = new Date(NOW - 3 * HOUR).toISOString();
  const start = cycle({ startedAt: started, endedAt: null, exit: 'running', poolAfter: null });
  assert.deepEqual(latestEnds([start]), []);
});

test('spentSince counts a superseded cycle once, at its real cost', () => {
  const started = new Date(NOW - 3 * HOUR).toISOString();
  const guess = cycle({ startedAt: started, exit: 'abandoned', poolBefore: { fable: 1, general: 1, session: 1 }, poolAfter: { fable: 0.9, general: 0.9, session: 0.9 } });
  const truth = cycle({ startedAt: started, exit: 'seam', poolBefore: { fable: 1, general: 1, session: 1 }, poolAfter: { fable: 0.5, general: 0.5, session: 0.5 } });
  const spent = spentSince([guess, truth], NOW - 8 * HOUR);
  assert.equal(Number(spent.fable.toFixed(2)), 0.5, 'not 0.6, which would double count');
});

/**
 * The reconciliation's guarantee, stated as the shape the ledger ends up in: two end
 * records for one cycle, the later one operative. Everything downstream reads through
 * latestEnds, so this is the invariant that makes appending safe.
 */
test('a reconciled cycle reads as its real outcome everywhere at once', () => {
  const started = new Date(NOW - 13 * HOUR).toISOString();
  const identity = [
    cycle({ startedAt: started, endedAt: null, exit: 'running', poolAfter: null }),
    cycle({
      startedAt: started,
      exit: 'abandoned',
      poolAfter: { fable: 0.8, general: 0.8, session: 0.8 },
      yield: null,
      startupTokens: null,
    }),
    cycle({
      startedAt: started,
      exit: 'seam',
      poolAfter: { fable: 0.42, general: 0.42, session: 0.42 },
      yield: { ticketsMoved: 3, prsOpened: 1, commits: 9 },
      startupTokens: 14_000,
    }),
  ];

  const ends = latestEnds(identity);
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.exit, 'seam', 'the outcome is the report, not the abandonment');
  assert.equal(ends[0]!.yield?.commits, 9, 'the yield is recovered');
  assert.equal(cyclesStartedSince(identity, 0), 1, 'and it now counts as work done');
  assert.equal(
    Number(spentSince(identity, NOW - 20 * HOUR).fable.toFixed(2)),
    0.58,
    'costed once, at the full spend rather than the understated abandonment figure',
  );
});
