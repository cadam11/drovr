import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  /**
   * `abandoned` is the honest answer where `crash` used to be guessed: the watch hit
   * maxCycleHours while the runner was still alive, so drovr stopped observing a cycle it
   * had not seen the end of. It says nothing about delivery, which is the point.
   */
  exit: z.enum([
    'context', 'capacity', 'seam', 'blocked', 'crash', 'stalled', 'deferred', 'abandoned',
    'running',
  ]),
  poolBefore: poolSnapshot,
  poolAfter: poolSnapshot.nullable(),
  /** Tokens consumed before the first productive action: the re-onboarding tax. */
  startupTokens: z.number().nullable(),
  yield: z
    .object({ ticketsMoved: z.number(), prsOpened: z.number(), commits: z.number() })
    .nullable(),
  asksRaised: z.number().default(0),
  /** The cycle asked to rest until then — its zero yield was declared, not a symptom. */
  pauseUntil: z.string().nullable().default(null),
  /** The claude session id drovr minted for the runner; how its transcript is found. */
  sessionId: z.string().nullable().default(null),
  /** The runner's last message, lifted from its transcript once the cycle ended. */
  closing: z.string().nullable().default(null),
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

/**
 * Exits where the cycle never delivered anything: it never started, or it started
 * and went nowhere. They are not samples of what a cycle costs, and they must not
 * burn a program's daily cap.
 */
const DID_NOT_DELIVER = new Set(['crash', 'stalled', 'deferred']);

/**
 * Exits that say nothing about whether the cycle delivered. Distinct from
 * DID_NOT_DELIVER, which asserts it did not: an abandoned cycle very likely did, drovr
 * just stopped watching before it could find out. It must not burn a program's daily cap
 * on an assumption either way — but its quota spend is real and measured, so unlike the
 * never-ran exits it *is* a cost sample.
 */
const DELIVERY_UNKNOWN = new Set(['abandoned']);

/**
 * The last end record for each cycle, keyed on its identity.
 *
 * Reconciliation appends the truth rather than rewriting history, so an abandoned cycle
 * that later reported has two end records. Anything that measures a cycle has to read the
 * last word on it: counting both would price that cycle twice, once at its understated
 * abandonment cost and once at its real one, and those are exactly the long expensive
 * cycles the percentile is there to catch.
 *
 * Start records are dropped — `exit: 'running'` with a null poolAfter carries no outcome.
 */
export const latestEnds = (cycles: CycleRecord[]): CycleRecord[] => {
  const byIdentity = new Map<string, CycleRecord>();
  for (const cycle of cycles) {
    if (cycle.endedAt === null) continue;
    byIdentity.set(`${cycle.program}|${cycle.startedAt}`, cycle);
  }
  return [...byIdentity.values()];
};

const REPORTED: CycleRecord['exit'][] = ['context', 'capacity', 'seam', 'blocked'];

/**
 * Whether one program's latest cycle wrote a report — the only evidence that it declared
 * itself done. An idle runner proves nothing: it idles while its background shells run.
 */
export const lastCycleReported = (cycles: CycleRecord[]): boolean => {
  const last = latestEnds(cycles).at(-1);
  return last !== undefined && REPORTED.includes(last.exit);
};

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

/**
 * Nearest-rank, so the answer is always a cost a real cycle actually had rather than
 * an interpolation between two of them.
 */
export const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
};

/**
 * Onboarding cycles are read-heavy and Fable-light; averaging them in would skew
 * the estimate every admission decision depends on.
 *
 * A high percentile, not the median. Observed cycle cost is badly right-skewed —
 * measured 2026-08-26 across 33 samples: median 0.10 session, mean 0.16, max 0.58 —
 * so a median under-prices half of all cycles *by construction* and the expensive
 * tail by six times. The number is what a reserve is denominated in, and a reserve
 * sized for the typical cycle is not a reserve. Budget the expensive case.
 */
export const estimateCycleCost = (
  cycles: CycleRecord[],
  seed: CycleCost,
  minSamples = 3,
  fraction = 0.9,
): CycleCost => {
  const costs = latestEnds(cycles)
    .filter((cycle) => cycle.kind === 'delivery' && !DID_NOT_DELIVER.has(cycle.exit))
    .map(costOf)
    .filter((cost): cost is PartialCost => cost !== null);

  // Each bucket keeps its own sample count: the 5h window resets mid-cycle far more
  // often than the weekly ones, so it can fall back to the seed while the others learn.
  const perBucket = (bucket: keyof CycleCost): number => {
    const samples = costs.map((cost) => cost[bucket]).filter((value): value is number => value !== null);
    if (samples.length < minSamples) return seed[bucket];
    return Math.max(percentile(samples, fraction), seed[bucket] / 4);
  };

  return { fable: perBucket('fable'), general: perBucket('general'), session: perBucket('session') };
};

/**
 * What the cycles already in flight should be charged, counted in cycles so it can be
 * subtracted from a cycle count (see decide.ts: a per-bucket deduction models nothing
 * now that fundability is summed per account).
 *
 * Charging a flat estimate per running cycle is what let three cycles pin three
 * accounts on 2026-08-25: each was billed 0.085 session at admission while actually
 * draining 0.23 to 0.58, so drovr kept admitting against room that was already gone.
 * A cycle is charged whichever is worse — the estimate, or what the pool has actually
 * lost since it started — so an expensive one stops admission as it happens rather
 * than after it finishes.
 *
 * Floored at one cycle each: a cycle that started seconds ago has drained nothing yet
 * and must still cost a full cycle. A 5h window that reset mid-cycle makes the
 * observed drain negative, and then the estimate stands on its own.
 */
export const chargeForRunning = (
  running: CycleRecord[],
  poolNow: CycleCost,
  cost: CycleCost,
): number => {
  const buckets: (keyof CycleCost)[] = ['fable', 'general', 'session'];
  return running.reduce((total, cycle) => {
    const observed = buckets.map((bucket) => {
      const drained = cycle.poolBefore[bucket] - poolNow[bucket];
      if (drained <= 0 || cost[bucket] <= 0) return 0;
      return drained / cost[bucket];
    });
    return total + Math.max(1, ...observed);
  }, 0);
};

/**
 * Drovr's own spend inside the current weekly window — the pace-keeping numerator.
 *
 * `until` bounds it to cycles that had *finished* by a past instant, which is what a
 * historical usage sample has to be compared against: a cycle still running had not yet
 * shown up in the quota that sample recorded. Unbounded by default, because every live
 * caller means "everything in the window so far".
 */
export const spentSince = (
  cycles: CycleRecord[],
  windowStart: number,
  until = Number.POSITIVE_INFINITY,
): CycleCost => {
  const spends = latestEnds(cycles)
    .filter(
      (cycle) =>
        Date.parse(cycle.startedAt) >= windowStart &&
        (cycle.endedAt === null || Date.parse(cycle.endedAt) <= until),
    )
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
 * Repeated failure is caught by consecutiveFailures instead.
 */
export const cyclesStartedSince = (cycles: CycleRecord[], since: number): number => {
  // None of these did any work, so none should cost a program its day: a crash never
  // ran, a deferral never started, a stalled cycle sat at its prompt, and a blocked
  // cycle only rediscovered that someone owes it an answer. Their own backoffs and
  // the failure latch are what bound them instead.
  const idle = new Set([...DID_NOT_DELIVER, ...DELIVERY_UNKNOWN, 'blocked']);
  // The *latest* exit per identity, not any of them: an abandoned cycle later reconciled
  // to a seam has both records, and matching on either would keep excluding it from the
  // cap after drovr learned it had delivered.
  const unspent = new Set(
    latestEnds(cycles)
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

/** A cycle that got as far as starting and still delivered nothing. */
const FAILED = new Set(['crash', 'stalled']);

/**
 * A failure loop needs a human, but only while it is still looping. Counting the
 * whole tail of history latches forever: an environment that was broken for twenty
 * minutes and has since been fixed would keep a program stopped until someone
 * cleared it by hand. Only recent failures count, so a fixed cause resumes on its
 * own and a genuine loop re-latches on its next attempt.
 *
 * Stalls count alongside crashes: nudging a stalled runner then starting a fresh
 * cycle is cheap once, but a program that stalls every time would otherwise loop
 * on it forever, paying full onboarding each round.
 */
export const consecutiveFailures = (
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
    if (!FAILED.has(cycle.exit)) break;
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
  // A cycle that asked to rest declared *why* it produced nothing, exactly like a
  // blocked one — counting it would latch a program as stuck for waiting well.
  const finished = cycles.filter(
    (cycle) =>
      cycle.kind === 'delivery' &&
      cycle.endedAt !== null &&
      cycle.exit !== 'blocked' &&
      cycle.pauseUntil === null,
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

/** The most recent start, ended or not — a cycle in flight opens its cadence window too. */
export const lastStartedAt = (cycles: CycleRecord[]): number | null => {
  let latest: number | null = null;
  for (const cycle of cycles) {
    const at = Date.parse(cycle.startedAt);
    if (!Number.isNaN(at) && (latest === null || at > latest)) latest = at;
  }
  return latest;
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

/**
 * Whether the launchd agent is alive and whether it had anything to decide are
 * different facts, and conflating them cost a false alarm: `lastDecisionAt` only
 * advances when an *enabled* program is evaluated, so disabling every program made
 * drovr report its own supervisor as possibly stalled while ticks fired normally.
 * Every completed tick stamps this instead, decisions or not.
 */
export const stampTick = (path: string, now: number): void => {
  writeFileSync(path, `${JSON.stringify({ at: new Date(now).toISOString() })}\n`, 'utf8');
};

const tickStampShape = z.object({ at: z.string() });

export const readTickStamp = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const parsed = tickStampShape.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) return null;
  const at = Date.parse(parsed.data.at);
  return Number.isNaN(at) ? null : at;
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
