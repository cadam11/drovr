import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Pool } from './capacity.ts';

const poolSnapshot = z.object({ fable: z.number(), general: z.number(), session: z.number() });

export const cycleShape = z.object({
  v: z.literal(1),
  kind: z.enum(['delivery', 'onboarding']),
  program: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** Why the cycle stopped — the main input for tuning the context ceiling. */
  exit: z.enum(['context', 'capacity', 'seam', 'blocked', 'crash', 'deferred', 'running']),
  poolBefore: poolSnapshot,
  poolAfter: poolSnapshot.nullable(),
  /** Tokens consumed before the first productive action: the re-onboarding tax. */
  startupTokens: z.number().nullable(),
  yield: z
    .object({ ticketsMoved: z.number(), prsOpened: z.number(), commits: z.number() })
    .nullable(),
  asksRaised: z.number().default(0),
});

export const decisionShape = z.object({
  v: z.literal(1),
  at: z.string(),
  program: z.string(),
  verdict: z.enum(['GO', 'WAIT', 'STOP']),
  reason: z.string(),
  pool: poolSnapshot.nullable(),
  cyclesFundable: z.number().nullable(),
});

export type CycleRecord = z.infer<typeof cycleShape>;
export type DecisionRecord = z.infer<typeof decisionShape>;
export type CycleCost = { fable: number; general: number; session: number };

export const snapshot = (pool: Pool): CycleCost => ({
  fable: pool.fable,
  general: pool.general,
  session: pool.session,
});

export const appendRecord = (path: string, record: unknown): void => {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
};

/** Malformed lines are surfaced, not skipped — a silently truncated ledger skews every estimate. */
export const readCycles = (path: string): CycleRecord[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const parsed = cycleShape.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`${path}:${index + 1} is not a valid cycle record: ${parsed.error.message}`);
      }
      return parsed.data;
    });
};

type PartialCost = { [K in keyof CycleCost]: number | null };

/**
 * A bucket that grew over the cycle reset mid-flight, which is the normal case for
 * the 5h window during an hours-long cycle. The delta then measures the reset, not
 * the spend, so the sample is discarded rather than recorded as zero — recording
 * zero would drag the median toward nothing and quietly stop the tightest
 * constraint from ever binding.
 */
const delta = (before: number, after: number): number | null =>
  after > before ? null : before - after;

const costOf = (cycle: CycleRecord): PartialCost | null => {
  if (cycle.poolAfter === null) return null;
  return {
    fable: delta(cycle.poolBefore.fable, cycle.poolAfter.fable),
    general: delta(cycle.poolBefore.general, cycle.poolAfter.general),
    session: delta(cycle.poolBefore.session, cycle.poolAfter.session),
  };
};

/** Spend only; a reset-corrupted sample contributes nothing rather than a zero. */
const spendOf = (cycle: CycleRecord): CycleCost => {
  const cost = costOf(cycle);
  return {
    fable: cost?.fable ?? 0,
    general: cost?.general ?? 0,
    session: cost?.session ?? 0,
  };
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/**
 * Onboarding cycles are read-heavy and Fable-light; averaging them in would skew
 * the estimate every admission decision depends on.
 */
export const estimateCycleCost = (
  cycles: CycleRecord[],
  seed: CycleCost,
  minSamples = 3,
): CycleCost => {
  const costs = cycles
    .filter((cycle) => cycle.kind === 'delivery' && cycle.exit !== 'crash' && cycle.exit !== 'deferred')
    .map(costOf)
    .filter((cost): cost is PartialCost => cost !== null);

  // Each bucket keeps its own sample count: the 5h window resets mid-cycle far more
  // often than the weekly ones, so it can fall back to the seed while the others learn.
  const perBucket = (bucket: keyof CycleCost): number => {
    const samples = costs.map((cost) => cost[bucket]).filter((value): value is number => value !== null);
    if (samples.length < minSamples) return seed[bucket];
    return Math.max(median(samples), seed[bucket] / 4);
  };

  return { fable: perBucket('fable'), general: perBucket('general'), session: perBucket('session') };
};

/** Drovr's own spend inside the current weekly window — the pace-keeping numerator. */
export const spentSince = (cycles: CycleRecord[], windowStart: number): CycleCost => {
  const spends = cycles
    .filter((cycle) => Date.parse(cycle.startedAt) >= windowStart)
    .map(spendOf);
  return {
    fable: spends.reduce((total, spend) => total + spend.fable, 0),
    general: spends.reduce((total, spend) => total + spend.general, 0),
    session: spends.reduce((total, spend) => total + spend.session, 0),
  };
};

/**
 * A cycle is in flight when its start record has no matching end record. Reading
 * it from the ledger rather than from locks means a decision made in any process
 * sees every program's running work.
 */
export const inFlight = (
  cycles: CycleRecord[],
  now = Date.now(),
  maxHours = 24,
): CycleRecord[] => {
  const ended = new Set(
    cycles.filter((cycle) => cycle.endedAt !== null).map((cycle) => `${cycle.program}|${cycle.startedAt}`),
  );
  // A SIGKILLed worker never writes its end record. Without this the cycle would
  // block its program and hold a concurrency slot forever, and only a hand-edit of
  // the ledger would clear it.
  const cutoff = now - maxHours * 3_600_000;
  return cycles.filter(
    (cycle) =>
      cycle.exit === 'running' &&
      !ended.has(`${cycle.program}|${cycle.startedAt}`) &&
      Date.parse(cycle.startedAt) >= cutoff,
  );
};

/**
 * Start and end share a record shape, so a cycle is counted by its identity, not
 * its rows. Crashes are excluded: the daily cap limits how much real work a program
 * may do, and a burst of cycles that died on a broken PATH should not burn the day.
 * Repeated crashing is caught by consecutiveCrashes instead.
 */
export const cyclesStartedSince = (cycles: CycleRecord[], since: number): number => {
  // None of these did any work, so none should cost a program its day: a crash never
  // ran, a deferral never started, and a blocked cycle only rediscovered that someone
  // owes it an answer. The blocked backoff is what bounds those instead.
  const idle = new Set(['crash', 'deferred', 'blocked']);
  const unspent = new Set(
    cycles
      .filter((cycle) => idle.has(cycle.exit))
      .map((cycle) => `${cycle.program}|${cycle.startedAt}`),
  );
  return new Set(
    cycles
      .filter((cycle) => Date.parse(cycle.startedAt) >= since)
      .map((cycle) => `${cycle.program}|${cycle.startedAt}`)
      .filter((identity) => !unspent.has(identity)),
  ).size;
};

/**
 * A crash loop needs a human, but only while it is still looping. Counting the whole
 * tail of history latches forever: an environment that was broken for twenty minutes
 * and has since been fixed would keep a program stopped until someone cleared it by
 * hand. Only recent crashes count, so a fixed cause resumes on its own and a genuine
 * loop re-latches on its next attempt.
 */
export const consecutiveCrashes = (
  cycles: CycleRecord[],
  now = Date.now(),
  windowMinutes = 60,
): number => {
  const cutoff = now - windowMinutes * 60_000;
  const finished = cycles.filter((cycle) => cycle.endedAt !== null);
  let streak = 0;
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const cycle = finished[index]!;
    if (cycle.exit === 'deferred') continue;
    if (cycle.exit !== 'crash') break;
    if (Date.parse(cycle.endedAt ?? cycle.startedAt) < cutoff) break;
    streak += 1;
  }
  return streak;
};

/**
 * Cycles that ran and achieved nothing while *not* blocked. A blocked cycle is
 * waiting on a human answer, which is a different condition entirely — counting it
 * as stuck reports a malfunction when the truth is that someone owes it a reply.
 */
export const consecutiveZeroYield = (cycles: CycleRecord[]): number => {
  const finished = cycles.filter(
    (cycle) => cycle.kind === 'delivery' && cycle.endedAt !== null && cycle.exit !== 'blocked',
  );
  let streak = 0;
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const produced = finished[index]!.yield;
    if (produced === null) break;
    if (produced.ticketsMoved + produced.prsOpened + produced.commits > 0) break;
    streak += 1;
  }
  return streak;
};

/** The most recently finished cycle, whatever it was. */
export const lastFinished = (cycles: CycleRecord[]): CycleRecord | null =>
  cycles.filter((cycle) => cycle.endedAt !== null).at(-1) ?? null;

/**
 * Asks raised by the last productive cycle, where every cycle since came back
 * blocked. That pattern means nobody has answered them — the program is not stalled
 * or broken, it is owed a reply.
 */
export const unansweredAsks = (cycles: CycleRecord[]): { asks: number; at: number } | null => {
  const finished = cycles.filter(
    (cycle) => cycle.endedAt !== null && cycle.exit !== 'deferred' && cycle.exit !== 'crash',
  );
  const blockedTail = [...finished].reverse().findIndex((cycle) => cycle.exit !== 'blocked');
  if (blockedTail <= 0) return null;

  const raiser = finished[finished.length - 1 - blockedTail];
  if (raiser === undefined || raiser.asksRaised === 0) return null;
  return { asks: raiser.asksRaised, at: Date.parse(raiser.endedAt ?? raiser.startedAt) };
};

/** When a tick last recorded a decision — the real proof the service is firing. */
export const lastDecisionAt = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  const parsed = decisionShape.safeParse(JSON.parse(last));
  if (!parsed.success) return null;
  const at = Date.parse(parsed.data.at);
  return Number.isNaN(at) ? null : at;
};
