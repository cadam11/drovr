import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { isUsable } from './capacity.ts';
import { record } from './record.ts';
import { spentSince, type CycleRecord } from './ledger.ts';
import type { BucketName } from './allocation.ts';
import type { TeamclaudeStatus } from './teamclaude.ts';

const WEEK_MS = 168 * 3_600_000;
const SESSION_MS = 5 * 3_600_000;

/**
 * The window each bucket is measured over, used to place a sample inside its own
 * window rather than assuming every bucket resets together. They do not.
 */
const WINDOW_MS: Record<BucketName, number> = {
  fable: WEEK_MS,
  general: WEEK_MS,
  session: SESSION_MS,
};

/**
 * Craig's own foreground sessions are the pool's largest consumer and the only one
 * drovr has never measured — over the seven days to 2026-08-26 they took roughly 1.17
 * account-units of weekly Fable against drovr's 1.02. The reserve that exists to protect
 * them is a fixed fraction picked by mode, so the question "is 45% a reserve or a wish?"
 * has only ever had an opinion for an answer.
 *
 * teamclaude reports total usage and drovr's ledger reports drovr's, so the difference is
 * Craig's — but only at the instant it is taken, because both are fractions of a window
 * that resets. Nothing reconstructs it after the fact, so it is sampled per tick and kept.
 *
 * This file only records and reads. It feeds no gate: an admission decision that moved
 * with Craig's measured behaviour would be a feedback loop nobody asked for.
 */
const accountSampleShape = z.object({
  name: z.string(),
  usable: z.boolean(),
  fable: z.number(),
  general: z.number(),
  session: z.number(),
  /** Epoch ms. Null when no window is open, i.e. nothing spent in that bucket yet. */
  fableReset: z.number().nullable(),
  generalReset: z.number().nullable(),
  sessionReset: z.number().nullable(),
});

const sampleShape = z.object({
  v: z.literal(1),
  at: z.string(),
  accounts: z.array(accountSampleShape),
});

export type UsageSample = z.infer<typeof sampleShape>;

/** Pure: what teamclaude was reporting at `now`, in the shape the log keeps. */
export const sampleUsage = (status: TeamclaudeStatus, now: number): UsageSample => ({
  v: 1,
  at: new Date(now).toISOString(),
  accounts: status.accounts.map((entry) => ({
    name: entry.name,
    usable: isUsable(entry, now),
    fable: entry.quota.unified7dFable ?? 0,
    general: entry.quota.unified7d ?? 0,
    session: entry.quota.unified5h ?? 0,
    fableReset: entry.quota.unified7dFableReset,
    generalReset: entry.quota.unified7dReset,
    sessionReset: entry.quota.unified5hReset,
  })),
});

/**
 * Bounded by bytes rather than age: a tick fires every ten minutes, so the line count
 * follows the schedule and the schedule can change. 8 MB is roughly four months at the
 * current cadence and three accounts.
 *
 * Rewritten through a staging file for the same reason control.json is — a reader must
 * never catch a half-pruned log — and truncated from the front, so what survives is the
 * recent behaviour the reserve question is actually about.
 */
export const MAX_USAGE_BYTES = 8 * 1024 * 1024;

const prune = (path: string, maxBytes: number): void => {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const keep = lines.slice(Math.floor(lines.length / 2));
  const staging = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(staging, `${keep.join('\n')}\n`, 'utf8');
    renameSync(staging, path);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
};

export const appendSample = (path: string, sample: UsageSample, maxBytes = MAX_USAGE_BYTES): void => {
  appendFileSync(path, `${JSON.stringify(sample)}\n`, 'utf8');
  prune(path, maxBytes);
};

/** Strict: drovr writes this file itself, so an unrecognised line is a defect, not input. */
export const readSamples = (path: string): UsageSample[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const parsed = sampleShape.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`${path}:${index + 1} is not a valid usage sample: ${parsed.error.message}`);
      }
      return parsed.data;
    });
};

export type Share = {
  at: number;
  /** Every usable account's used-fraction, summed: the pool's total consumption. */
  total: number;
  /** What drovr's own ledger accounts for inside the same window. */
  drovr: number;
  /** The remainder, which is Craig. Clamped: the ledger can over-report a shrunken pool. */
  yours: number;
};

const usable = (sample: UsageSample) => sample.accounts.filter((entry) => entry.usable);

const resetField = {
  fable: 'fableReset',
  general: 'generalReset',
  session: 'sessionReset',
} as const;

/**
 * When the window containing this sample opened. Read from the soonest future reset
 * among usable accounts, mirroring capacity.ts — accounts drift apart by hours, and the
 * soonest is the one whose window drovr is about to be judged against.
 *
 * Null resets mean no window is open, which is the same as nothing spent: the window
 * starts at the sample and the drovr term is zero, which is exactly right.
 */
const windowStartOf = (sample: UsageSample, bucket: BucketName, at: number): number => {
  const resets = usable(sample)
    .map((entry) => entry[resetField[bucket]])
    .filter((reset): reset is number => reset !== null && reset > at);
  return resets.length === 0 ? at : Math.min(...resets) - WINDOW_MS[bucket];
};

/**
 * Split one sample into Craig's share and drovr's. Both terms are bounded to the window
 * the sample sits in, and the ledger term is bounded to cycles that had *finished* by
 * then — a cycle still running had not yet shown up in the usage this sample recorded.
 */
export const shareOf = (sample: UsageSample, cycles: CycleRecord[], bucket: BucketName): Share => {
  const at = Date.parse(sample.at);
  const total = usable(sample).reduce((sum, entry) => sum + entry[bucket], 0);
  const drovr = spentSince(cycles, windowStartOf(sample, bucket, at), at)[bucket];
  return record('usage.shareOf', { sample, cycles, bucket }, { at, total, drovr, yours: Math.max(0, total - drovr) });
};

export const sharesOf = (
  samples: UsageSample[],
  cycles: CycleRecord[],
  bucket: BucketName,
): Share[] => samples.map((sample) => shareOf(sample, cycles, bucket));

export type Observed = {
  bucket: BucketName;
  samples: number;
  /** Craig's share at the most recent sample, in account-units. */
  now: number;
  /** The high-water mark a reserve would have to cover, at `fraction`. */
  peak: number;
  /** Peak as a fraction of the usable pool, which is what a mode ceiling is set against. */
  peakFraction: number;
};

/**
 * What a reserve sized from evidence would have to be. Reported at a high percentile for
 * the same reason a cycle is priced at one: the reserve exists for the weeks Craig is
 * busy, and a median would size it for the weeks he is not.
 *
 * Null below `minSamples` rather than a confident number off three ticks — an under-sized
 * reserve argued from thin evidence is worse than the fixed fraction it would replace.
 */
export const observedYours = (
  samples: UsageSample[],
  cycles: CycleRecord[],
  bucket: BucketName,
  fraction = 0.9,
  minSamples = 24,
): Observed | null =>
  record(
    'usage.observedYours',
    { samples, cycles, bucket, fraction, minSamples },
    observedYoursUnrecorded(samples, cycles, bucket, fraction, minSamples),
  );

const observedYoursUnrecorded = (
  samples: UsageSample[],
  cycles: CycleRecord[],
  bucket: BucketName,
  fraction: number,
  minSamples: number,
): Observed | null => {
  if (samples.length < minSamples) return null;
  const shares = sharesOf(samples, cycles, bucket);
  const sorted = [...shares].sort((a, b) => a.yours - b.yours);
  const rank = Math.ceil(fraction * sorted.length);
  const peak = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!.yours;
  const accounts = usable(samples[samples.length - 1]!).length;
  return {
    bucket,
    samples: samples.length,
    now: shares[shares.length - 1]!.yours,
    peak,
    peakFraction: accounts === 0 ? 0 : peak / accounts,
  };
};
