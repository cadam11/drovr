import { hoursToWeeklyReset, poolFrom, type AccountHeadroom, type Pool } from './capacity.ts';
import { ceilingsFor, isPaused, priorityRank, type Control } from './control.ts';
import { chargeForRunning,
  consecutiveFailures,
  consecutiveZeroYield,
  cyclesStartedSince,
  estimateCycleCost,
  inFlight,
  lastFinished,
  snapshot,
  spentSince,
  unansweredAsks,
  type CycleCost,
  type CycleRecord,
} from './ledger.ts';
import type { BucketName } from './allocation.ts';
import { agentNameFor } from './herdr.ts';
import type { TeamclaudeStatus } from './teamclaude.ts';

const WEEKLY_WINDOW_HOURS = 168;
const DAY_MS = 86_400_000;

export type Verdict = 'GO' | 'WAIT' | 'STOP';

export type Decision = {
  verdict: Verdict;
  reason: string;
  pool: Pool | null;
  cyclesFundable: number | null;
  /** Which bucket is tightest — the difference between waiting hours and waiting days. */
  binding: BucketName | null;
  earliestRecoveryAt: number | null;
};

export type DecideInput = {
  status: TeamclaudeStatus;
  control: Control;
  /** Every program's cycles: quota is one shared pool, so pace and reservations are global. */
  cycles: CycleRecord[];
  program: string;
  now: number;
  /** Most recent activity on this program’s asks page, if drovr could read it. */
  answeredAt?: number | null;
  /** False when shared notes are off, which is what stops drovr seeing an answer. */
  asksShared?: boolean | null;
  /**
   * Whether a herdr agent for this program is still present. Read by the caller, because
   * decide() does no I/O — and read at all because a leftover runner is the one thing that
   * makes a program unstartable while every other gate says GO. Undefined means unknown
   * (herdr unreachable, or a headless runner), which must never refuse a cycle.
   */
  runnerPresent?: boolean;
};

const ratio = (available: number, cost: number): number =>
  cost <= 0 ? Number.POSITIVE_INFINITY : available / cost;

const BUCKETS: BucketName[] = ['fable', 'general', 'session'];

/** What one account could fund alone, and which of its buckets stopped it there. */
export type AccountFunding = {
  name: string;
  cycles: number;
  binding: BucketName;
  /** False when teamclaude will not route a Fable request here, so it funds nothing. */
  routable: boolean;
};

export type Funding = { cycles: number; binding: BucketName; accounts: AccountFunding[] };

/**
 * The buckets are not a hierarchy: one Fable token decrements all three, so they are
 * simultaneous constraints on the account that served the request and the tightest binds.
 */
const fundingFor = (account: AccountHeadroom, cost: CycleCost): AccountFunding => {
  const tightest = BUCKETS
    .map((bucket) => ({
      name: account.name,
      cycles: ratio(account[bucket], cost[bucket]),
      binding: bucket,
      routable: account.routable,
    }))
    .reduce((best, candidate) => (candidate.cycles < best.cycles ? candidate : best));

  // An account teamclaude will not route Fable to funds nothing, whatever its buckets
  // say. The bucket is still reported: eligibility tracks usage, so the tightest bucket
  // is also what has to reset before the account comes back.
  return account.routable ? tightest : { ...tightest, cycles: 0 };
};

const resetOrder = (pool: Pool, bucket: BucketName): number =>
  pool.resetAt[bucket] ?? Number.POSITIVE_INFINITY;

/**
 * Which bucket to report, since earliestRecoveryAt is read from it. Above zero it is
 * the bucket pinning the account that would serve next — the one with the most to give.
 * At zero no account serves any request, so the useful answer is which bucket frees one
 * up first: a 5h hold is hours away, a weekly one days, and saying the wrong one turns a
 * short wait into an apparent write-off.
 */
const bindingOf = (accounts: AccountFunding[], pool: Pool): BucketName => {
  const best = accounts.reduce((most, account) => (account.cycles > most.cycles ? account : most));
  if (best.cycles > 0) return best.binding;
  return accounts
    .map((account) => account.binding)
    .reduce((soonest, bucket) => (resetOrder(pool, bucket) < resetOrder(pool, soonest) ? bucket : soonest));
};

/**
 * Fundability is the sum over accounts of each account's own tightest bucket, never the
 * min of the per-bucket sums — those let an account donate headroom it cannot spend
 * because it is exhausted elsewhere (see capacity.ts).
 *
 * `running` is subtracted here rather than from the pool: cycles already in flight have
 * not shown up as spent quota yet, so without it N concurrent programs each claim the
 * whole pool. It is a count of cycles because fundability is now counted in cycles —
 * there is no per-bucket pool left to deduct a per-bucket cost from.
 */
export const cyclesFundableFrom = (pool: Pool, cost: CycleCost, running: number): Funding => {
  const accounts = pool.perAccount.map((account) => fundingFor(account, cost));
  // A pool with no usable accounts funds nothing. It still has to name a bucket, and
  // session is the shortest wait, so it is the least misleading one to claim.
  if (accounts.length === 0) return { cycles: 0, binding: 'session', accounts };

  const gross = accounts.reduce((total, account) => total + account.cycles, 0);
  return { cycles: Math.max(0, gross - running), binding: bindingOf(accounts, pool), accounts };
};

/**
 * The local part, unless two accounts share one, in which case neither is abbreviated.
 * Length is a hard constraint here and not a preference: this note has to survive beside
 * a program row in `drovr watch`, which is the one surface that also draws the free-looking
 * bars it exists to explain. Keeping the domains costs about thirty columns and pushes the
 * verdict itself off the frame.
 */
const shortName = (name: string, all: AccountFunding[]): string => {
  const local = (candidate: string): string => candidate.split('@')[0] ?? candidate;
  const collides = all.filter((account) => local(account.name) === local(name)).length > 1;
  return collides ? name : local(name);
};

const listOf = (names: string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** How many accounts actually contribute a fundable cycle, whatever the total says. */
export const contributingAccounts = (funding: Funding): number =>
  funding.accounts.filter((account) => account.cycles > 0).length;

/**
 * "across 3 accounts" is a lie when one of them is carrying all of it. Measured live on
 * 2026-08-25: two of Craig's three accounts were spent and the third — the only one
 * teamclaude would route Fable to — was also serving his own foreground sessions, while
 * the verdict still read "across 3 accounts". The total was right; the picture was not.
 */
const sourcedFrom = (funding: Funding, usable: number): string => {
  const from = contributingAccounts(funding);
  return from === usable ? `across ${usable} accounts` : `from ${from} of ${usable} accounts`;
};

/**
 * A pool resting on a single account has no fallback, and that account is also where
 * Craig's own sessions land — so one busy afternoon of his removes drovr's whole runway.
 * The headline number cannot express that, so it is said out loud.
 *
 * Silent for a single-account pool: there is no concentration to warn about when there
 * was never more than one account to spread across.
 */
const concentrationNote = (funding: Funding, usable: number): string | null => {
  if (usable < 2) return null;
  const carrying = funding.accounts.filter((account) => account.cycles > 0);
  if (carrying.length !== 1) return null;
  const unroutable = funding.accounts.filter((account) => !account.routable).length;
  const why = unroutable === 0 ? '' : `, ${unroutable} not routed for fable`;
  return `all of it on ${shortName(carrying[0]!.name, funding.accounts)} with no fallback${why}`;
};

/**
 * The allocation bars and this verdict answer different questions — the bars show how
 * much of each bucket is spent pool-wide, which reads as free while no single account
 * has room in all three at once. That gap is what got misread as capacity, so when it is
 * what refuses a cycle the reason has to name it and say which bucket pins whom.
 *
 * Appended, never prefixed: every surface clips a long reason from the right, so whichever
 * half goes last is the half that can be lost. The verdict — what it funds, what it needs,
 * when it recovers — is the half that must always survive.
 *
 * Silent for a single-account pool: with one account min-of-sums and sum-of-mins agree,
 * so there is no discrepancy to explain and "session tightest" already says it.
 */
const couplingNote = (funding: Funding): string | null => {
  if (funding.accounts.length < 2) return null;
  const pinned = funding.accounts.filter((account) => account.cycles <= 0);
  if (pinned.length === 0) return null;

  const pins = BUCKETS
    .map((bucket) => pinned.filter((account) => account.binding === bucket))
    .filter((group) => group.length > 0)
    .map(
      (group, index) =>
        `${group[0]!.binding}${index === 0 ? ' is full on' : ' on'} ` +
        listOf(group.map((account) => shortName(account.name, funding.accounts))),
    )
    .join(', ');

  if (pinned.length === funding.accounts.length) {
    return `no account has room in all three buckets: ${pins}`;
  }
  const spare = funding.accounts.length - pinned.length;
  const has = spare === 1 ? 'has' : 'have';
  return `only ${spare} of ${funding.accounts.length} accounts ${has} room in all three buckets: ${pins}`;
};

/**
 * Cycles drovr may always run right after a reset, whatever the line says. Linear
 * entitlement from zero refuses the first cycle of every window — at 1% elapsed the line
 * sits near zero while one finished cycle is already above it — which would turn a gate
 * meant to smooth the week into one that never lets it start. Short-term bursting is
 * legitimate; sustained over-spending is what this gate is for.
 */
const PACE_BURST_CYCLES = 2;

/**
 * Is the loop ahead of a linear burn of its own weekly allowance?
 *
 * The allowance is `pool + spent`: what is still reachable under the ceiling, plus what
 * drovr already spent to get there. That is the whole re-basing. The previous version
 * granted `weeklyCeiling × usableAccounts × elapsed` — the ceiling as though drovr owned
 * all of it — while measuring spend from drovr's ledger alone. Craig's foreground work
 * counted on neither side, so the entitlement was systematically too large and the gate
 * could not fire: measured across 1008 decisions in the seven days to 2026-08-26, it
 * fired **zero** times while the daily cap refused 267 cycles doing its job for it.
 *
 * Deriving the allowance from `pool` instead fixes three things at once. Both sides now
 * sit on the same basis — what drovr can actually reach — so the comparison means
 * something. Craig's usage is already deducted, per account, by capacity.ts, so this
 * gate inherits the clamp rather than re-deriving it and inherits the min-of-sums rule
 * with it. And it needs neither `weeklyCeiling` nor `usableAccounts`, because the pool
 * encodes both.
 *
 * It only ever holds, and it clears itself: the line rises with elapsed time and the
 * allowance rises again at the reset. Nothing has to be cleared by hand.
 */
const paceExceeded = (input: DecideInput, pool: Pool, cost: CycleCost): string | null => {
  const hoursLeft = hoursToWeeklyReset(input.status, input.now);
  if (hoursLeft === null) return null;

  const elapsed = Math.min(1, Math.max(0, (WEEKLY_WINDOW_HOURS - hoursLeft) / WEEKLY_WINDOW_HOURS));
  const windowStart = input.now - (WEEKLY_WINDOW_HOURS - hoursLeft) * 3_600_000;
  const spent = spentSince(input.cycles, windowStart);

  // Session is deliberately absent: it is a five-hour window, so there is no week to
  // pace it across and the affordability gate already refuses when it binds.
  const over = (['fable', 'general'] as const).find((bucket) => {
    const allowance = pool[bucket] + spent[bucket];
    return spent[bucket] > Math.max(allowance * elapsed, cost[bucket] * PACE_BURST_CYCLES);
  });
  if (over === undefined) return null;

  const allowance = pool[over] + spent[over];
  return (
    `ahead of pace on ${over} — ${spent[over].toFixed(2)} spent of a ${allowance.toFixed(2)} ` +
    `weekly allowance at ${Math.round(elapsed * 100)}% through the window (all programs). ` +
    `Clears as the week catches up, or at the reset in ${Math.round(hoursLeft)}h`
  );
};

/**
 * Hours, until an hour is the wrong unit. `Math.round` turned a 26-minute session hold into
 * "recovers in 0h", which reads as "any moment now" for a wait that is not — the same class
 * of misreport as naming the wrong bucket, and on the same line.
 */
const untilText = (at: number | null, now: number): string => {
  if (at === null) return 'unknown';
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
};

const halt = (reason: string): Decision => ({
  verdict: 'STOP',
  reason,
  pool: null,
  cyclesFundable: null,
  binding: null,
  earliestRecoveryAt: null,
});

/** Recovery is read from the binding bucket's own reset, not the soonest of all three. */
const hold = (
  reason: string,
  pool: Pool | null,
  funding: Funding | null,
): Decision => ({
  verdict: 'WAIT',
  reason,
  pool,
  cyclesFundable: funding?.cycles ?? null,
  binding: funding?.binding ?? null,
  earliestRecoveryAt:
    funding === null || pool === null ? (pool?.earliestRecoveryAt ?? null) : pool.resetAt[funding.binding],
});

/**
 * Is this program in a fit state to run at all? Null means yes.
 *
 * Separated from the capacity gates below because they answer a different question about
 * a different resource, and fusing them made one function of eleven gates — the shape the
 * allocation review flagged (docs/allocation-review.md, finding 5). Nothing here reads the
 * pool, which is the test of the seam: a program that is disabled, latched, paused or
 * owed an answer is not going to run however much quota exists, so none of this should
 * have to wait on a teamclaude read to say so.
 */
export const programReadiness = (input: DecideInput): Decision | null => {
  const { control, program, now } = input;
  const mine = input.cycles.filter((cycle) => cycle.program === program);

  // Tick skips disabled programs, so reporting anything but STOP here would promise
  // a cycle that is never going to start.
  const entry = control.programs.find((candidate) => candidate.name === program);
  if (entry !== undefined && !entry.enabled) {
    return halt('disabled — enable it to let cycles start');
  }

  const stuck = consecutiveZeroYield(mine);
  if (stuck >= control.stuckCycleThreshold) {
    return halt(`${stuck} consecutive cycles produced no yield — escalating instead of looping`);
  }

  // Only recent failures latch, so a fixed cause resumes without anyone clearing it.
  const failures = consecutiveFailures(mine, now, control.crashWindowMinutes);
  if (failures >= control.stuckCycleThreshold) {
    return halt(
      `${failures} cycles crashed or stalled in the last ${control.crashWindowMinutes}m — see ` +
        `~/.drovr/logs/${program}-worker.log. Retries on its own once those age out, ` +
        `or run "drovr run-cycle ${program}" to try immediately.`,
    );
  }

  if (isPaused(control, now)) return hold(`paused until ${control.pauseUntil}`, null, null);

  // A blocked cycle means every remaining item is waiting on a human answer, so
  // starting another straight away only pays to rediscover that. Back off instead of
  // burning a cycle every tick, and say plainly that it is waiting on Craig.
  const last = lastFinished(mine);
  if (last?.exit === 'blocked' && last.endedAt !== null) {
    // An answer on the asks page ends the wait immediately: that is the event the
    // backoff was standing in for.
    const answered = (input.answeredAt ?? 0) > Date.parse(last.endedAt);
    const retryAt = Date.parse(last.endedAt) + control.blockedBackoffMinutes * 60_000;
    if (!answered && retryAt > now) {
      const mins = Math.ceil((retryAt - now) / 60_000);
      // Shared notes being off is the reason an answer goes unnoticed, so name it.
      const unnoticed =
        input.asksShared === false
          ? '. Shared notes are off on that page, so drovr cannot see your reply'
          : '';
      return hold(
        `waiting on you — the last cycle was blocked on unanswered asks. Retries in ${mins}m, ` +
          `or answer them and run "drovr start ${program}"${unnoticed}`,
        null,
        null,
      );
    }
  }

  return null;
};

/**
 * The limits that are about sharing rather than about quota: one cycle per program, a
 * global concurrency cap, a per-program daily cap, and an answer Craig owes. Null means
 * none of them refuse.
 *
 * These take the pool only to attach it to the hold, so every WAIT still carries the
 * numbers the renderers draw. They do not read it.
 */
const admissionLimits = (
  input: DecideInput,
  pool: Pool,
  running: CycleRecord[],
): Decision | null => {
  const { control, program, now } = input;
  const mine = input.cycles.filter((cycle) => cycle.program === program);
  const entry = control.programs.find((candidate) => candidate.name === program);

  if (running.some((cycle) => cycle.program === program)) {
    return hold('a cycle for this program is already in flight', pool, null);
  }

  // Second, and before anything that computes funding. A runner present with no cycle in
  // flight is a leftover that outlived its watch, and it will refuse the launch with
  // PaneBusy however healthy the pool is. Admitting it anyway is not merely a wasted
  // launch: tick books an admitted program as launched, so the phantom charges a full
  // cycle against the pool for the rest of the pass and starves every program behind it.
  // Measured 2026-08-27 — 38 deferrals, each one taking two other programs from 1.35
  // fundable to 0.35.
  if (input.runnerPresent === true) {
    return hold(
      `its previous runner still holds its pane — agent ${agentNameFor(program)} outlived ` +
        `its cycle. Run "drovr release ${program}" once it is settled, or open its tab in ` +
        'herdr and answer whatever it is waiting on',
      pool,
      null,
    );
  }

  if (running.length >= control.maxConcurrentCycles) {
    return hold(
      `${running.length} cycles ahead of it, cap is ${control.maxConcurrentCycles}`,
      pool,
      null,
    );
  }

  const cap = entry?.maxCyclesPerDay ?? control.maxCyclesPerDay;
  const today = cyclesStartedSince(mine, now - DAY_MS);
  if (today >= cap) {
    return hold(
      `daily cap reached (${today}/${cap} cycles that did work). Raise it with ` +
        `"drovr cap ${program} <n>"`,
      pool,
      null,
    );
  }

  // Last, because everything above is a harder constraint. A program otherwise ready
  // to run and sitting on unanswered asks is waiting on Craig, and saying so is more
  // use than naming whichever check happened to fire.
  const owed = unansweredAsks(mine);
  if (owed !== null && (input.answeredAt ?? 0) <= owed.at) {
    return hold(
      `waiting on you — ${owed.asks} ask(s) raised ${Math.round((now - owed.at) / 60_000)}m ago ` +
        'and every cycle since has come back blocked' +
        (input.asksShared === false
          ? `. Shared notes are off on that page, so answer and run "drovr start ${program}"`
          : ''),
      pool,
      null,
    );
  }

  return null;
};

/**
 * How much runway a cycle must see before it is admitted, which is **not** the same
 * number for every bucket.
 *
 * The reserve exists so a cycle can *land* — finish its work and make it durable — rather
 * than being cut off mid-flight. So the question is what can actually cut one off. A dry
 * weekly bucket is days of nothing, and a cycle admitted into one can genuinely die there:
 * that is what `reserveCycles` is for. A dry 5h window is not that. It refills four or five
 * times a day, capacity.ts's own ledger rule documents it resetting *mid-cycle* as the
 * normal case for an hours-long cycle, and a runner that reaches it waits and continues.
 * Requiring a whole cycle plus a reserve of a bucket like that is a rate limit being
 * treated as a budget.
 *
 * It was also, in effect, unsatisfiable. Measured 2026-08-26: p90 session cost 0.390
 * against a `normal` session ceiling of 0.400, so `1 + reserveCycles` demanded 0.585 of a
 * window holding 0.400 — no single account could ever clear admission, whatever its weekly
 * buckets held. That went unnoticed while session was priced at the median 0.10, because
 * 0.15 fitted comfortably; moving to a high percentile was right for the weekly buckets and
 * collided here with a reserve that should not have applied.
 *
 * Session still has to cover one whole cycle. Below that a cycle starts and immediately
 * idles waiting for the window, which holds a pane and a concurrency slot, gets nudged as
 * a stall, and pays full onboarding for nothing.
 *
 * Keyed on the reported binding bucket rather than folded into each per-bucket ratio: the
 * ratios are what every renderer prints as "room for N cycles", and changing their meaning
 * would move that number on four surfaces at once. This is approximate when accounts bind
 * on different buckets — `bindingOf` reports the one pinning the account that would serve
 * next — and the substance survives the approximation, because the reserve still applies
 * whenever a weekly bucket is what actually constrains that account.
 *
 * `rank` is the program's place in the drain order (control.ts's `priorityRank`): each
 * step down raises the bar by `priorityStepCycles`, so as the pool drains the
 * lowest-priority programs pause first and the last cycle goes to the top one — the
 * contract in design.md. Before this, priority was only a same-tick sort key and the last
 * fundable cycle went to whichever program happened to be free: measured 2026-08-27,
 * aice-x (priority 3) took the pool's final cycle while sunnyt (priority 1) was held for
 * ten minutes by its own leftover pane, then waited 5h on the session reset.
 */
export const requiredCycles = (binding: BucketName, control: Control, rank: number): number =>
  (binding === 'session' ? 1 : 1 + control.reserveCycles) + rank * control.priorityStepCycles;

/**
 * Can the pool fund a whole cycle plus a reserve, and is the loop within its weekly
 * pace? The only two gates that read quota, and the only one of the three layers that
 * can return GO.
 */
const capacityVerdict = (input: DecideInput, pool: Pool, running: CycleRecord[]): Decision => {
  const { control, now } = input;
  const cost = estimateCycleCost(input.cycles, control.seedCycleCost);

  const offPace = paceExceeded(input, pool, cost);
  if (offPace !== null) return hold(offPace, pool, null);

  // Not running.length: a cycle already draining more than it was priced at has to
  // stop admission while it happens, not once it has finished and been measured.
  const charged = chargeForRunning(running, snapshot(pool), cost);
  const funding = cyclesFundableFrom(pool, cost, charged);
  const { rank, above } = priorityRank(control, input.program, now);
  const required = requiredCycles(funding.binding, control, rank);
  if (funding.cycles < required) {
    const recovery = untilText(pool.resetAt[funding.binding], now);

    // A pool that would admit this program at rank 0 is being held by priority alone,
    // and that is the one raised threshold worth explaining on the line: the reader sees
    // room and needs to know who it is being kept for. The coupling note is skipped here
    // on purpose — priority, not the bucket coupling, is what refuses.
    if (rank > 0 && funding.cycles >= requiredCycles(funding.binding, control, 0)) {
      return hold(
        `room for ${funding.cycles.toFixed(2)} cycles, held back for ${listOf(above)} — ` +
          `${input.program} starts above ${required.toFixed(2)} ` +
          `(${funding.binding} is tightest); more room in ${recovery}`,
        pool,
        funding,
      );
    }

    const note = couplingNote(funding);
    // The session/weekly asymmetry in the threshold is deliberately not explained here.
    // The honest answer costs characters the frame does not have: the worst case below is
    // already near the 200 that survive `drovr watch`'s wrapped detail lines, and that
    // budget exists because this is the one surface that also draws the free-looking bars
    // the note is there to explain. `requiredCycles` and design.md carry the reason; a
    // question asked once does not belong on a line printed every tick.
    return hold(
      `${funding.binding} is tightest: room for ${funding.cycles.toFixed(2)} cycles, ` +
        `a start needs ${required.toFixed(2)} (${running.length} running); ` +
        `more room in ${recovery}` +
        `${note === null ? '' : ` — ${note}`}`,
      pool,
      funding,
    );
  }

  const concentration = concentrationNote(funding, pool.usableAccounts);
  return {
    verdict: 'GO',
    reason:
      `room for ${funding.cycles.toFixed(2)} more cycles ` +
      `${sourcedFrom(funding, pool.usableAccounts)} ` +
      `(${running.length} running; ${funding.binding} is tightest)` +
      `${concentration === null ? '' : ` — ${concentration}`}`,
    pool,
    cyclesFundable: funding.cycles,
    binding: funding.binding,
    earliestRecoveryAt: pool.earliestRecoveryAt,
  };
};

/**
 * Three layers, composed in hardness order: is the program fit to run, is it allowed a
 * slot, can the pool afford it. Each is pure and independently testable; all the I/O
 * stays in the caller.
 */
export const decide = (input: DecideInput): Decision => {
  const ceilings = ceilingsFor(input.control);
  if (ceilings === null) return halt('mode is off');

  const notReady = programReadiness(input);
  if (notReady !== null) return notReady;

  const pool = poolFrom(input.status, ceilings, input.now);
  if (pool.usableAccounts === 0) return hold('no usable accounts', pool, null);

  const running = inFlight(input.cycles, input.now, input.control.maxCycleHours);
  const limited = admissionLimits(input, pool, running);
  if (limited !== null) return limited;

  return capacityVerdict(input, pool, running);
};

export const poolSnapshot = snapshot;
