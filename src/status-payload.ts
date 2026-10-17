import { allocationSegments, type Allocation, type BucketName } from './allocation.ts';
import { poolFrom } from './capacity.ts';
import { ceilingsFor, effectivePriority, isPaused, type Control, type Program } from './control.ts';
import { contributingAccounts, cyclesFundableFrom, poolContext, type Decision, type Funding } from './decide.ts';
import { chargeForRunning, estimateCycleCost, inFlight, snapshot, type CycleRecord } from './ledger.ts';
import { describeService, serviceHealth, type ServiceState } from './service.ts';
import { accountsOf } from './state.ts';
import { switchThresholds, type TeamclaudeStatus } from './teamclaude.ts';

/** One program's verdict as its caller computed it, with its lock holder. No I/O happens here. */
export type Evaluation = { program: Program; decision: Decision; pid: number | null };

export type StatusInput = {
  /** The control the pass ran under — after applyAwayMode, so `mode` may already be away. */
  control: Control;
  /** The mode control.json holds, so the payload can say when the phone overrode it. */
  storedMode: Control['mode'];
  status: TeamclaudeStatus;
  cycles: CycleRecord[];
  now: number;
  /** Priority order, every configured program — the CLI's evaluateAll or the tick's own pass. */
  evaluations: Evaluation[];
  service: {
    state: ServiceState;
    lastTickAt: number | null;
    /** The live tick-lock holder, or null; the tick passes null since it is the holder. */
    lockHolder: { pid: number; heldMs: number | null } | null;
  };
};

/** Float noise (0.5700000000000001) is technically accurate and unreadable. */
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Non-finite only when every bucket's estimated cost is zero, which JSON cannot carry. */
const roundFinite = (value: number): number | null => (Number.isFinite(value) ? round(value) : null);

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

const roundCost = (cost: { fable: number; general: number; session: number }) => ({
  fable: round(cost.fable),
  general: round(cost.general),
  session: round(cost.session),
});

const VERDICT_MEANING: Record<string, string> = {
  GO: 'a cycle would launch on the next tick',
  WAIT: 'transient — a later tick will retry, no action needed',
  STOP: 'needs a human: mode is off, or this program produced no yield for several cycles',
};

/** Epoch millis are unreadable in a document someone has to interpret; timestamps go out as ISO. */
const poolPayload = (pool: ReturnType<typeof poolFrom>) => ({
  ...roundCost(pool),
  usableAccounts: pool.usableAccounts,
  resetAt: {
    fable: iso(pool.resetAt.fable),
    general: iso(pool.resetAt.general),
    session: iso(pool.resetAt.session),
  },
  earliestRecoveryAt: iso(pool.earliestRecoveryAt),
  units: 'account-fractions of headroom; one usable account contributes at most 1.0',
});

/**
 * The pool's per-bucket sums cannot be divided by cost to get this: an account is
 * spendable only where it has room in all three buckets at once, so capacity is summed
 * per account, each contributing only what its own tightest bucket allows.
 */
const fundingPayload = (funding: Funding) => ({
  cyclesFundable: roundFinite(funding.cycles),
  bindingBucket: funding.binding,
  fundingAccounts: contributingAccounts(funding),
  perAccount: funding.accounts.map((account) => ({
    name: account.name,
    cyclesFundable: roundFinite(account.cycles),
    bindingBucket: account.binding,
    routableForFable: account.routable,
  })),
  units:
    'whole delivery cycles, net of cycles already in flight; the total is the sum over ' +
    'accounts of each account’s own tightest bucket, never the min of the pool sums',
});

/**
 * The ACCOUNTS block of `drovr watch`, per account, with the headroom the pool was built from.
 * Headroom is null for an account the pool left out (disabled, throttled, or mode off): null
 * reads as "not in the pool", where 0 would read as spent.
 */
const accountsPayload = (status: TeamclaudeStatus, pool: ReturnType<typeof poolFrom> | null) =>
  accountsOf(status).map((entry) => {
    const headroom = pool?.perAccount.find((a) => a.name === entry.name) ?? null;
    const account = status.accounts.find((a) => a.name === entry.name);
    return {
      ...entry,
      headroom: headroom === null ? null : roundCost(headroom),
      // The tick on each bar: where rotation stops routing here. Absent from an older teamclaude.
      switchThresholds: account === undefined ? null : switchThresholds(status, account),
    };
  });

/** The five stacked segments `drovr watch` draws, so a remote bar cannot disagree with the TUI's. */
const allocationPayload = (segments: Record<BucketName, Allocation>) => ({
  ...segments,
  units:
    'account-units per bucket; yoursSpent + programsSpent + programsReserved + programsAvailable + ' +
    'yoursReserved = total, the stacked bar drovr watch draws',
});

const modeMeaning = (control: Control, storedMode: Control['mode']): string => {
  if (control.mode === 'off') return 'no cycles will start';
  const share = round((control.ceilings[control.mode]?.weekly ?? 0) * 100);
  const phone = control.mode === storedMode ? '' : `; away is the phone's toggle for this pass, the stored mode is ${storedMode}`;
  return `programs may use up to ${share}% of each account's weekly quota; the rest stays available to Craig${phone}`;
};

/**
 * The one shape `drovr status --json` prints and the tick publishes to hey. Pure: the caller
 * reads control, teamclaude, the ledger and launchd and decides every program; this only
 * arranges what it was handed, so the CLI and the tick cannot drift apart.
 */
export const buildStatusPayload = (input: StatusInput) => {
  const { control, storedMode, status, cycles, now, evaluations, service } = input;
  const ceilings = ceilingsFor(control);
  // control.maxCycleHours, never inFlight's own 24h default: decide() cuts off there, and a
  // 13h-old cycle with no end record would otherwise reserve a cycle the verdicts do not.
  const running = inFlight(cycles, now, control.maxCycleHours);
  const pool = ceilings === null ? null : poolFrom(status, ceilings, now);
  const cost = estimateCycleCost(cycles, control.seedCycleCost);
  // chargeForRunning, never the raw count: the same charge decide() applies, or this payload
  // over-reports fundability against the verdicts printed in it (CLAUDE.md, state.ts trap).
  const funding = pool === null ? null : cyclesFundableFrom(pool, cost, chargeForRunning(running, snapshot(pool), cost));

  return {
    generatedAt: new Date(now).toISOString(),
    service: {
      health: serviceHealth(service.state, service.lastTickAt, now),
      explanation: describeService(service.state, service.lastTickAt, now, service.lockHolder),
      lastTickAt: iso(service.lastTickAt),
      // The launchd StartInterval; null when no plist is installed. A reader judges staleness against it.
      intervalSeconds: service.state.intervalSeconds,
    },
    mode: control.mode,
    modeFromPhone: control.mode !== storedMode,
    modeMeaning: modeMeaning(control, storedMode),
    pausedUntil: control.pauseUntil,
    // isPaused, not a bare presence check on pausedUntil: a lapsed timestamp is not a
    // pause, and --json has no renderer downstream to apply that guard itself.
    paused: isPaused(control, now),
    pool: pool === null ? null : poolPayload(pool),
    capacity: funding === null ? null : fundingPayload(funding),
    // The pool-level half of every verdict, once (CLAUDE.md, the reason/note split): a reader
    // showing several programs prints this beside the bars, never a program's poolNote N times.
    capacityNote: funding === null || pool === null ? null : poolContext(funding, pool, now),
    allocation:
      pool === null
        ? null
        : allocationPayload(allocationSegments({ status, pool, cycles, runningCycles: running.length, cycleCost: cost, now })),
    estimatedCycleCost: {
      ...roundCost(cost),
      units: 'account-fractions consumed by one typical delivery cycle',
    },
    inFlight: running.map((cycle) => ({
      program: cycle.program,
      startedAt: cycle.startedAt,
      kind: cycle.kind,
    })),
    accounts: accountsPayload(status, pool),
    accountsUnits:
      'per teamclaude account: each bucket’s used fraction of its own quota and its next reset; ' +
      'headroom is what the pool counts for it under the current ceilings, null when it is not usable; ' +
      'switchThresholds is the used fraction per bucket at which teamclaude stops routing to the account',
    concurrencyCap: control.maxConcurrentCycles,
    programs: evaluations.map(({ program, decision, pid }) => ({
      name: program.name,
      cwd: program.cwd,
      host: program.host,
      enabled: program.enabled,
      priority: program.priority,
      effectivePriority: effectivePriority(program, now, control.deadlineHorizonDays),
      deadline: program.deadline,
      verdict: decision.verdict,
      verdictMeaning: VERDICT_MEANING[decision.verdict],
      reason: decision.reason,
      // Pool-level context, identical across programs in this array — kept separate so a
      // consumer showing several programs is not handed the same sentence N times.
      poolNote: decision.note,
      bindingBucket: decision.binding,
      cyclesFundable: decision.cyclesFundable === null ? null : round(decision.cyclesFundable),
      recoversAt: iso(decision.earliestRecoveryAt),
      runningPid: pid,
    })),
  };
};

export type StatusPayload = ReturnType<typeof buildStatusPayload>;
