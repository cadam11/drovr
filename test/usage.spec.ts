import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSample,
  observedYours,
  readSamples,
  sampleUsage,
  shareOf,
  type UsageSample,
} from '../src/usage.ts';
import type { CycleRecord } from '../src/ledger.ts';
import { account, HOUR, NOW, status } from './fixtures.ts';

const WEEK = 168 * HOUR;

const cycle = (overrides: Partial<CycleRecord> = {}): CycleRecord => ({
  v: 1,
  kind: 'delivery',
  program: 'demo',
  startedAt: new Date(NOW - 3 * HOUR).toISOString(),
  endedAt: new Date(NOW - 2 * HOUR).toISOString(),
  exit: 'seam',
  poolBefore: { fable: 1.0, general: 1.0, session: 1.0 },
  poolAfter: { fable: 0.9, general: 0.85, session: 0.7 },
  startupTokens: 1000,
  yield: { ticketsMoved: 1, prsOpened: 0, commits: 2 },
  asksRaised: 0,
  pauseUntil: null,
  ...overrides,
});

const sample = (overrides: Partial<UsageSample['accounts'][number]>[] = [], at = NOW): UsageSample => ({
  v: 1,
  at: new Date(at).toISOString(),
  accounts: overrides.map((entry, index) => ({
    name: entry.name ?? `a${index}`,
    usable: entry.usable ?? true,
    fable: entry.fable ?? 0,
    general: entry.general ?? 0,
    session: entry.session ?? 0,
    fableReset: entry.fableReset ?? at + 84 * HOUR,
    generalReset: entry.generalReset ?? at + 84 * HOUR,
    sessionReset: entry.sessionReset ?? at + 2 * HOUR,
  })),
});

test('sampleUsage records every account, marking which are in the pool', () => {
  const taken = sampleUsage(
    status([
      account({ name: 'a', fable: 0.4, general: 0.5, session: 0.1 }),
      account({ name: 'b', disabled: true, fable: 0.9, general: 0.9 }),
    ]),
    NOW,
  );

  assert.equal(taken.accounts.length, 2, 'a disabled account is recorded, not dropped');
  assert.equal(taken.accounts[0]!.usable, true);
  assert.equal(taken.accounts[1]!.usable, false);
  assert.equal(taken.accounts[0]!.general, 0.5);
});

test('sampleUsage reads a null bucket as nothing spent, not as missing', () => {
  const taken = sampleUsage(status([account({ name: 'a', fable: null, general: null })]), NOW);
  assert.equal(taken.accounts[0]!.fable, 0);
  assert.equal(taken.accounts[0]!.general, 0);
});

/**
 * The whole point of the file: total usage minus drovr's ledger is Craig. Getting the
 * subtraction backwards, or reading the wrong window, would make the reserve argument
 * confidently wrong in the direction that matters.
 */
test("shareOf attributes the pool's usage to Craig once drovr's own spend is removed", () => {
  const share = shareOf(
    sample([{ name: 'a', general: 0.6 }, { name: 'b', general: 0.4 }]),
    [cycle()],
    'general',
  );

  assert.equal(Number(share.total.toFixed(2)), 1.0, 'both accounts count toward total usage');
  assert.equal(Number(share.drovr.toFixed(2)), 0.15, "drovr's own cycle spent 1.0 -> 0.85");
  assert.equal(Number(share.yours.toFixed(2)), 0.85);
});

test('shareOf ignores accounts that are out of the pool', () => {
  const share = shareOf(
    sample([{ name: 'a', general: 0.3 }, { name: 'b', general: 0.9, usable: false }]),
    [],
    'general',
  );
  assert.equal(Number(share.total.toFixed(2)), 0.3);
});

/**
 * A sample is a photograph of a window, so only cycles that had already *finished* by
 * then can be inside it. Without the `until` bound a later cycle would be subtracted
 * from an earlier reading and hand back a Craig share that is too small.
 */
test('shareOf does not credit drovr for a cycle that finished after the sample', () => {
  const later = cycle({
    startedAt: new Date(NOW + HOUR).toISOString(),
    endedAt: new Date(NOW + 2 * HOUR).toISOString(),
  });
  const share = shareOf(sample([{ name: 'a', general: 0.6 }]), [later], 'general');
  assert.equal(share.drovr, 0, 'a cycle that ended an hour after the sample is not in it');
  assert.equal(Number(share.yours.toFixed(2)), 0.6);
});

test('shareOf excludes a cycle that started before the window opened', () => {
  // The window opened 84h before NOW, because the reset is 84h after it.
  const before = cycle({
    startedAt: new Date(NOW - WEEK).toISOString(),
    endedAt: new Date(NOW - WEEK + HOUR).toISOString(),
  });
  const share = shareOf(sample([{ name: 'a', general: 0.6 }]), [before], 'general');
  assert.equal(share.drovr, 0);
});

test('shareOf reads the session bucket over a 5h window, not a week', () => {
  // A cycle 6h old is outside a 5h window but inside a weekly one.
  const old = cycle({
    startedAt: new Date(NOW - 7 * HOUR).toISOString(),
    endedAt: new Date(NOW - 6 * HOUR).toISOString(),
  });
  assert.equal(shareOf(sample([{ name: 'a', session: 0.5 }]), [old], 'session').drovr, 0);
  assert.ok(shareOf(sample([{ name: 'a', general: 0.5 }]), [old], 'general').drovr > 0);
});

test('shareOf never reports a negative share when the ledger over-reports', () => {
  const expensive = cycle({ poolAfter: { fable: 0.0, general: 0.0, session: 0.0 } });
  const share = shareOf(sample([{ name: 'a', general: 0.1 }]), [expensive], 'general');
  assert.equal(share.yours, 0, 'clamped, because a shrunken pool can make the ledger exceed usage');
});

test('observedYours withholds a number until it has enough samples to mean one', () => {
  const few = [sample([{ name: 'a', general: 0.5 }])];
  assert.equal(observedYours(few, [], 'general'), null);
});

/**
 * The peak is what a reserve has to cover, so it must be a high percentile of Craig's
 * behaviour rather than a typical one — the same argument as pricing a cycle at p90.
 */
test('observedYours reports a high percentile of the share, not the average', () => {
  const samples = Array.from({ length: 30 }, (_, index) =>
    sample([{ name: 'a', general: index === 29 ? 0.9 : 0.1 }], NOW + index * 60_000),
  );
  const observed = observedYours(samples, [], 'general', 0.9, 24);
  assert.ok(observed !== null);
  assert.equal(Number(observed.now.toFixed(2)), 0.9, 'now is the latest sample');
  assert.equal(Number(observed.peak.toFixed(2)), 0.1, 'p90 of 30 mostly-quiet samples stays low');

  const busy = Array.from({ length: 30 }, (_, index) =>
    sample([{ name: 'a', general: index < 25 ? 0.8 : 0.1 }], NOW + index * 60_000),
  );
  const loud = observedYours(busy, [], 'general', 0.9, 24);
  assert.equal(Number(loud!.peak.toFixed(2)), 0.8);
});

test('observedYours expresses the peak as a share of the pool, for comparing to a ceiling', () => {
  const samples = Array.from({ length: 30 }, (_, index) =>
    sample([{ name: 'a', general: 0.6 }, { name: 'b', general: 0.6 }], NOW + index * 60_000),
  );
  const observed = observedYours(samples, [], 'general', 0.9, 24);
  assert.equal(Number(observed!.peak.toFixed(2)), 1.2);
  assert.equal(Number(observed!.peakFraction.toFixed(2)), 0.6, '1.2 units across 2 accounts');
});

test('readSamples round-trips what appendSample wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-usage-'));
  const path = join(dir, 'usage.jsonl');

  appendSample(path, sample([{ name: 'a', general: 0.2 }]));
  appendSample(path, sample([{ name: 'a', general: 0.3 }], NOW + 60_000));

  const read = readSamples(path);
  assert.equal(read.length, 2);
  assert.equal(read[1]!.accounts[0]!.general, 0.3);
});

test('readSamples surfaces a malformed line rather than skipping it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-usage-'));
  const path = join(dir, 'usage.jsonl');
  writeFileSync(path, `${JSON.stringify({ v: 1, at: 'now' })}\n`, 'utf8');
  assert.throws(() => readSamples(path), /not a valid usage sample/);
});

test('readSamples treats an absent log as empty, not as an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-usage-'));
  assert.deepEqual(readSamples(join(dir, 'nothing.jsonl')), []);
});

/**
 * An unattended supervisor writes this file every ten minutes forever, so the bound has
 * to be enforced rather than assumed. Truncating from the front keeps the recent
 * behaviour, which is the part the reserve question is about.
 */
test('appendSample bounds the log, keeping the newest half', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-usage-'));
  const path = join(dir, 'usage.jsonl');

  for (let index = 0; index < 200; index += 1) {
    appendSample(path, sample([{ name: 'a', general: index / 1000 }], NOW + index * 60_000), 4_000);
  }

  assert.ok(statSync(path).size <= 4_000, `log stayed bounded, was ${statSync(path).size}`);
  const read = readSamples(path);
  assert.ok(read.length > 0);
  assert.equal(
    read.at(-1)!.at,
    new Date(NOW + 199 * 60_000).toISOString(),
    'the most recent sample always survives a prune',
  );
  assert.ok(
    Date.parse(read[0]!.at) > NOW,
    'the oldest samples were dropped rather than the newest',
  );
  assert.ok(read.length < 200, 'the log is a window on recent behaviour, not all of it');
});
