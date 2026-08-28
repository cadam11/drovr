import { allocationFor, type Allocation, type BucketName } from './allocation.ts';
import { hoursToWeeklyReset, poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, effectivePriority, readControl, type Control } from './control.ts';
import { contributingAccounts, cyclesFundableFrom, decide, poolContext, type Verdict } from './decide.ts';
import {
  chargeForRunning, estimateCycleCost, inFlight, lastDecisionAt, readTickStamp, readCycles,
  snapshot, spentSince, type CycleRecord,
} from './ledger.ts';
import { agentNameFor, agentState, aiceBaseUrl, readPreview } from './herdr.ts';
import { holder } from './lock.ts';
import { paths } from './paths.ts';
import type { Preview } from './preview.ts';
import { serviceState } from './service.ts';
import { readStatus, type TeamclaudeStatus } from './teamclaude.ts';

const BUCKETS: BucketName[] = ['fable', 'general', 'session'];
const OVERDUE_INTERVALS = 3;

/** Rounded at the edge so the JSON carries meanings, not float noise. */
const r = (value: number, places = 4): number => Number(value.toFixed(places));

/** allocationFor's division/multiplication over quota fractions is the biggest source of float noise in the payload. */
const roundAllocation = (allocation: Allocation): Allocation => ({
  bucket: allocation.bucket,
  total: r(allocation.total),
  yoursSpent: r(allocation.yoursSpent),
  programsSpent: r(allocation.programsSpent),
  programsReserved: r(allocation.programsReserved),
  programsAvailable: r(allocation.programsAvailable),
  yoursReserved: r(allocation.yoursReserved),
});

export type ProgramState = {
  name: string;
  enabled: boolean;
  priority: number;
  verdict: Verdict | 'RUN';
  reason: string;
  kind: string | null;
  startedAt: string | null;
  pid: number | null;
  asksUrl: string | null;
  context: { percent: number | null; tokens: number | null; subagents: number | null } | null;
  preview: string[] | null;
};

export type DrovrState = {
  schemaVersion: 1;
  generatedAt: string;
  mode: string;
  pauseUntil: string | null;
  maxConcurrentCycles: number;
  /**
   * 1 - ceilings[mode].weekly — the reserve knob itself (keys.ts:setReserve is
   * literally its inverse), not allocation.yoursReserved. That field drifts down
   * as capacity is spent and swings with whichever bucket happens to bind, even
   * though the knob never moved; a panel tile built on it read 27% while the
   * real setting was 45% (see CLAUDE.md's C3 "Held for you" trap).
   */
  reserve: number;
  /**
   * Every ledger-in-flight cycle within control.maxCycleHours — the same count
   * decide() caps against (decide.ts) and buildState reserves against below. A count
   * derived only from state.programs would miss a cycle whose program was removed or
   * renamed out of control.json while still running, and would then disagree with
   * both decide() and this very function about how much capacity is spoken for.
   */
  cyclesInFlight: number;
  service: { loaded: boolean; intervalSeconds: number | null; lastTickAt: string | null; overdue: boolean };
  pool: {
    usableAccounts: number;
    /** How many of them actually fund a cycle. Fewer than usable means no fallback. */
    fundingAccounts: number;
    fable: number;
    general: number;
    session: number;
  };
  bindingBucket: BucketName;
  cyclesFundable: number;
  /**
   * When the bucket that is actually binding next resets — `pool.resetAt[bindingBucket]`,
   * never `pool.earliestRecoveryAt` (the soonest across all three) and never the weekly
   * reset. CLAUDE.md's decide.ts trap is that a 5h hold recovers in hours and a weekly one
   * in days: a renderer with only `hoursToWeeklyReset` can print "tightest bucket: session"
   * beside "resets in 3d" and turn a two-hour wait into an apparent write-off.
   * Null when that bucket has no future reset among the usable accounts.
   */
  bindingRecoveryAt: string | null;
  /**
   * decide.ts's poolContext — the pool-level half of every capacity verdict, identical
   * for each program in a pass. Program reasons deliberately no longer carry it, so a
   * renderer that shows several programs must print this once (beside the bars is where
   * it belongs: it is what explains free-looking bars refusing cycles) or the coupling
   * warning is shown nowhere at all.
   */
  capacityNote: string;
  hoursToWeeklyReset: number | null;
  allocation: Record<BucketName, Allocation>;
  programs: ProgramState[];
  accounts: {
    name: string; org: string | null; status: string | null; sessions: number;
    current: boolean; lastUsedAt: string | null;
    buckets: Record<'session' | 'general' | 'fable', { usedFraction: number | null; resetsAt: string | null }>;
  }[];
  recentCycles: { startedAt: string; program: string; kind: string; exit: string; asksRaised: number }[];
  /**
   * Reserved, and always empty today: nothing produces it. Both real callers of
   * collectState take the `[]` default, because tick.ts drains an intent and applies it
   * within the same tick (resolve → apply → reply) rather than parking it in a queue for
   * a later one. Kept so the panel's queued-intent surface and this shape stay ready for
   * a deferred-application design; do not go looking for the writer, there is none.
   */
  queuedIntents: { id: string; action: string; requestedAt: string; expiresAt: string }[];
};

export type StateInput = {
  status: TeamclaudeStatus;
  control: Control;
  cycles: CycleRecord[];
  now: number;
  service: { loaded: boolean; intervalSeconds: number | null; lastTickAt: number | null };
  previews: Map<string, Preview>;
  /** Per program: whether a herdr agent is still present. Absent means unknown. */
  runners?: Map<string, boolean>;
  locks: Map<string, number>;
  asksUrls: Map<string, string>;
  queuedIntents: DrovrState['queuedIntents'];
};

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

const isOverdue = (service: StateInput['service'], now: number): boolean => {
  if (service.intervalSeconds === null || service.lastTickAt === null) return false;
  return now - service.lastTickAt > service.intervalSeconds * 1000 * OVERDUE_INTERVALS;
};

const accountsOf = (status: TeamclaudeStatus): DrovrState['accounts'] =>
  status.accounts.map((account) => ({
    name: account.name,
    org: account.orgName,
    status: account.status,
    sessions: account.sessions,
    current: account.name === status.currentAccount,
    lastUsedAt: account.usage.lastUsed,
    buckets: {
      session: { usedFraction: account.quota.unified5h, resetsAt: iso(account.quota.unified5hReset) },
      general: { usedFraction: account.quota.unified7d, resetsAt: iso(account.quota.unified7dReset) },
      fable: { usedFraction: account.quota.unified7dFable, resetsAt: iso(account.quota.unified7dFableReset) },
    },
  }));

/**
 * A synthetic in-flight cycle for a program `decide()` just admitted, so the next
 * program in priority order sees its capacity as spoken for. Without this, three
 * independently-fundable programs would each see the whole pool and all report GO —
 * the same error decide.ts's own trap notes for real in-flight cycles.
 */
const RUNNING_PLACEHOLDER: CycleRecord = {
  v: 1,
  kind: 'delivery',
  program: '',
  startedAt: '',
  endedAt: null,
  exit: 'running',
  poolBefore: { fable: 0, general: 0, session: 0 },
  poolAfter: null,
  startupTokens: null,
  yield: null,
  asksRaised: 0,
  pauseUntil: null,
};

const programsOf = (input: StateInput): ProgramState[] => {
  const { control, cycles, now, previews, locks, asksUrls } = input;
  const runners = input.runners ?? new Map<string, boolean>();
  const running = inFlight(cycles, now, control.maxCycleHours);
  const ordered = byPriority(control.programs, now, control.deadlineHorizonDays);
  const projected: CycleRecord[] = [];

  return ordered.map((program) => {
    const live = running.find((cycle) => cycle.program === program.name);
    const runnerPresent = runners.get(program.name);
    const decision = decide({
      status: input.status,
      control,
      cycles: [...cycles, ...projected],
      program: program.name,
      now,
      ...(runnerPresent === undefined ? {} : { runnerPresent }),
    });
    if (decision.verdict === 'GO' && program.enabled && live === undefined) {
      projected.push({
        ...RUNNING_PLACEHOLDER,
        program: program.name,
        startedAt: new Date(now).toISOString(),
      });
    }

    const preview = previews.get(program.name) ?? null;
    return {
      name: program.name,
      enabled: program.enabled,
      priority: effectivePriority(program, now, control.deadlineHorizonDays),
      verdict: live === undefined ? decision.verdict : 'RUN',
      reason: decision.reason,
      kind: live?.kind ?? null,
      startedAt: live?.startedAt ?? null,
      pid: locks.get(program.name) ?? null,
      asksUrl: asksUrls.get(program.name) ?? null,
      context: preview === null ? null : {
        percent: preview.contextPercent,
        tokens: preview.contextTokens,
        subagents: preview.subagents,
      },
      preview: preview?.lines ?? null,
    };
  });
};

/** Pure: every read already happened in collectState. */
export const buildState = (input: StateInput): DrovrState => {
  const { status, control, cycles, now } = input;
  const ceilings = ceilingsFor(control) ?? { weekly: 0, session: 0 };
  const pool = poolFrom(status, ceilings, now);
  // Same window decide() uses (control.maxCycleHours, not inFlight's own 24h
  // default), so the reservation and bar segments never disagree with the verdict.
  const inFlightCycles = inFlight(cycles, now, control.maxCycleHours);
  const running = inFlightCycles.length;
  const cost = estimateCycleCost(cycles, control.seedCycleCost);
  // The same call decide() makes, charged the same way. Passing the *count* here while
  // decide() passes chargeForRunning would make every renderer over-report fundability
  // against the verdict printed beside it — the anti-drift rule, in the one direction
  // that reads as free capacity.
  const funding = cyclesFundableFrom(pool, cost, chargeForRunning(inFlightCycles, snapshot(pool), cost));
  const hoursLeft = hoursToWeeklyReset(status, now);
  const windowStart = hoursLeft === null ? now : now - (168 - hoursLeft) * 3_600_000;
  const spent = spentSince(cycles, windowStart);

  const allocation = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, roundAllocation(allocationFor({
      status, pool, bucket,
      spentByPrograms: spent[bucket],
      runningCycles: running,
      cycleCost: cost,
      now,
    }))]),
  ) as Record<BucketName, Allocation>;

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    mode: control.mode,
    pauseUntil: control.pauseUntil,
    maxConcurrentCycles: control.maxConcurrentCycles,
    reserve: r(1 - ceilings.weekly),
    cyclesInFlight: running,
    service: {
      loaded: input.service.loaded,
      intervalSeconds: input.service.intervalSeconds,
      lastTickAt: iso(input.service.lastTickAt),
      overdue: isOverdue(input.service, now),
    },
    pool: {
      usableAccounts: pool.usableAccounts,
      fundingAccounts: contributingAccounts(funding),
      fable: r(pool.fable), general: r(pool.general), session: r(pool.session),
    },
    bindingBucket: funding.binding,
    cyclesFundable: r(funding.cycles, 2),
    bindingRecoveryAt: iso(pool.resetAt[funding.binding]),
    // The same function decide() uses for every decision's note, on the same charged
    // funding — computed here rather than lifted off one program's decision so a pass
    // with no capacity verdicts (every program held earlier) still draws the line.
    capacityNote: poolContext(funding, pool, now),
    hoursToWeeklyReset: hoursLeft === null ? null : r(hoursLeft, 1),
    allocation,
    programs: programsOf(input),
    accounts: accountsOf(status),
    recentCycles: cycles
      .filter((cycle) => cycle.endedAt !== null)
      .slice(-8).reverse()
      .map((cycle) => ({
        startedAt: cycle.startedAt, program: cycle.program,
        kind: cycle.kind, exit: cycle.exit, asksRaised: cycle.asksRaised,
      })),
    queuedIntents: input.queuedIntents,
  };
};

/**
 * The only I/O. Previews are read concurrently and never allowed to reject.
 *
 * `onWarning` exists because readPreview's own failures are surfaced, not logged
 * (see herdr.ts:readPreview), and the two real callers need it to land differently.
 * The terminal UI (watch.ts) can never print mid-frame, so it folds the warning into
 * the view instead. The panel publisher (publish-snapshot.ts) has no frame to fold
 * it into and runs unattended from launchd, so it passes console.error, and that is
 * exactly the case this diagnostic exists for. Passing nothing drops the warning —
 * only correct for a caller with neither a frame nor a log to put it in.
 */
export const collectState = async (
  queuedIntents: DrovrState['queuedIntents'] = [],
  onWarning?: (message: string) => void,
): Promise<DrovrState> => {
  const p = paths();
  const now = Date.now();
  const status = await readStatus();
  const control = readControl(p.control);
  const cycles = readCycles(p.cycles);
  const running = inFlight(cycles, now, control.maxCycleHours);

  const previews = new Map<string, Preview>();
  const asksUrls = new Map<string, string>();
  const locks = new Map<string, number>();
  // Whether each program's runner is still present, which decide() needs to see a
  // leftover pane. Gathered here rather than left to tick because every renderer runs
  // decide() itself: a guard only the tick passes shows GO on four surfaces for a
  // program the tick will refuse, which is exactly the drift CLAUDE.md warns about.
  const runners = new Map<string, boolean>();

  for (const program of control.programs) {
    const pid = holder(p.programLock(program.name));
    if (pid !== null) locks.set(program.name, pid);
  }

  await Promise.all(control.programs.map(async (program) => {
    if (program.aice?.asksPage != null) {
      const base = await aiceBaseUrl(program);
      if (base !== null) asksUrls.set(program.name, `${base}/${program.aice.asksPage}`);
    }
    if (program.runner === 'herdr') {
      // Left unset on an error, not false: "no agent" and "no answer" are different facts
      // and only the first may refuse a cycle.
      const state = await agentState(agentNameFor(program.name)).catch((error: unknown) => {
        onWarning?.(`could not read ${program.name}'s runner state: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (state !== null) runners.set(program.name, state !== 'gone');
    }
    if (!running.some((cycle) => cycle.program === program.name)) return;
    const { preview, warning } = await readPreview(agentNameFor(program.name));
    if (preview !== null) previews.set(program.name, preview);
    if (warning !== null) onWarning?.(warning);
  }));

  const service = serviceState();
  return buildState({
    status, control, cycles, now,
    service: {
      loaded: service.loaded,
      intervalSeconds: service.intervalSeconds,
      // Liveness is 'a tick completed', not 'a tick decided something' — with every
      // program disabled no decision is logged and the agent is fine. Fallback keeps
      // an install that predates the heartbeat from reading as never having run.
      lastTickAt: readTickStamp(p.lastTick) ?? lastDecisionAt(p.decisions),
    },
    previews, locks, asksUrls, queuedIntents, runners,
  });
};
