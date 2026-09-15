#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poolFrom } from './capacity.ts';
import {
  byPriority, ceilingsFor, effectivePriority, isPaused, parseControl, parseDuration, readControl,
} from './control.ts';
import { contributingAccounts, cyclesFundableFrom, decide, poolContext, type Funding } from './decide.ts';
import {
  chargeForRunning,
  consecutiveZeroYield,
  estimateCycleCost,
  inFlight,
  lastDecisionAt,
  latestEnds,
  readTickStamp,
  readCycles,
  snapshot,
  type CycleRecord,
} from './ledger.ts';
import { observedYours, readSamples, shareOf, type UsageSample } from './usage.ts';
import { AGENT_NOTES, findCommand, helpTree, renderCommand, renderList } from './help.ts';
import { readAsks } from './asks.ts';
import { parseReportArgs, writeReport } from './cycle.ts';
import { textCraig } from './nudge.ts';
import { unverified, verifyDelivery } from './delivery.ts';
import { isSettled, releaseRunner as freeRunner, runnerAddress, runnerState, tidyRunnerTerminal } from './orca.ts';
import { setReserve } from './keys.ts';
import { heldBy, holder } from './lock.ts';
import { ensureDirs, paths } from './paths.ts';
import {
  bootoutCommand,
  bootstrapCommand,
  installAgent,
  agentPath,
  describeService,
  LABEL,
  plist,
  plistPath,
  serviceHealth,
  serviceState,
} from './service.ts';
import { readStatus } from './teamclaude.ts';
import { inFlightCycles, launchDetached, runProgramCycle, tick } from './tick.ts';
import { watch } from './watch.ts';

const p = paths();

const defaultControl = {
  mode: 'normal',
  pauseUntil: null,
  sessionId: null,
  closing: null,
  programs: [],
};

const init = (): void => {
  ensureDirs();
  if (existsSync(p.control)) {
    console.log(`${p.control} already exists`);
    return;
  }
  writeFileSync(p.control, `${JSON.stringify(defaultControl, null, 2)}\n`, 'utf8');
  console.log(`wrote ${p.control} — add a program entry, then \`drovr service install\``);
};

const mutate = (change: (control: Record<string, unknown>) => void): void => {
  const raw: Record<string, unknown> = JSON.parse(readFileSync(p.control, 'utf8'));
  change(raw);
  parseControl(raw);
  writeFileSync(p.control, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
};

/**
 * Verdicts are computed in priority order with each admitted program reserving
 * capacity, so the list reflects what a tick would actually do rather than
 * evaluating every program against an empty pool.
 */
const evaluateAll = async (input: {
  control: ReturnType<typeof readControl>;
  status: Awaited<ReturnType<typeof readStatus>>;
  cycles: CycleRecord[];
  now: number;
}) => {
  const { control, status, cycles, now } = input;
  const projected: CycleRecord[] = [];
  const ordered = byPriority(control.programs, now, control.deadlineHorizonDays);
  const asks = new Map(
    await Promise.all(
      ordered.map(async (program) => [program.name, await readAsks(program, now)] as const),
    ),
  );

  // Read here too, and by hand, because this is a *fourth* place decide() is called —
  // after tick.ts, state.ts and, through it, the panel. A guard passed by only some of
  // them prints GO on the surfaces that lack it for a program the tick refuses, which is
  // the drift CLAUDE.md keeps warning about. Undefined on an error or a headless runner:
  // "no agent" and "no answer" are different facts and only the first refuses a cycle.
  const runners = new Map(
    await Promise.all(
      ordered.map(async (program) => {
        if (program.runner !== 'orca') return [program.name, undefined] as const;
        const state = await runnerState(program.name).catch(() => null);
        return [program.name, state === null ? undefined : state !== 'gone'] as const;
      }),
    ),
  );

  return ordered.map((program) => {
    const runnerPresent = runners.get(program.name);
    const decision = decide({
      status,
      control,
      cycles: [...cycles, ...projected],
      program: program.name,
      now,
      answeredAt: asks.get(program.name)?.latestAt ?? null,
      asksShared: asks.get(program.name)?.shared ?? null,
      ...(runnerPresent === undefined ? {} : { runnerPresent }),
    });
    if (decision.verdict === 'GO' && program.enabled) {
      projected.push({
        v: 1,
        kind: 'delivery',
        program: program.name,
        startedAt: new Date(now).toISOString(),
        endedAt: null,
        exit: 'running',
        poolBefore: { fable: 0, general: 0, session: 0 },
        poolAfter: null,
        startupTokens: null,
        yield: null,
        asksRaised: 0,
        pauseUntil: null,
        sessionId: null,
        closing: null,
      });
    }
    return { program, decision, pid: holder(p.programLock(program.name)) };
  });
};

/** Float noise (0.5700000000000001) is technically accurate and unreadable. */
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

const roundCost = (cost: { fable: number; general: number; session: number }) => ({
  fable: round(cost.fable),
  general: round(cost.general),
  session: round(cost.session),
});

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
    'accounts of each account\u2019s own tightest bucket, never the min of the pool sums',
});

const statusPayload = async () => {
  const control = readControl(p.control);
  const status = await readStatus();
  const cycles = readCycles(p.cycles);
  const now = Date.now();
  const ceilings = ceilingsFor(control);
  const state = serviceState();
  // The heartbeat is the liveness signal; the decision log is the fallback for an
  // install that predates it, so an upgrade does not read as 'no tick has ever run'.
  const lastTick = readTickStamp(p.lastTick) ?? lastDecisionAt(p.decisions);
  // control.maxCycleHours, never inFlight's own 24h default: decide() and buildState both
  // cut off there, and a 13h-old cycle with no end record would otherwise have this payload
  // reserving a cycle the per-program verdicts printed from it do not.
  const running = inFlight(cycles, now, control.maxCycleHours);
  const pool = ceilings === null ? null : poolFrom(status, ceilings, now);
  const cost = estimateCycleCost(cycles, control.seedCycleCost);

  return {
    service: {
      health: serviceHealth(state, lastTick, now),
      explanation: describeService(state, lastTick, now, tickLockHolder()),
      lastTickAt: iso(lastTick),
    },
    mode: control.mode,
    modeMeaning:
      control.mode === 'off'
        ? 'no cycles will start'
        : `programs may use up to ${round((control.ceilings[control.mode]?.weekly ?? 0) * 100)}% of each account's weekly quota; the rest stays available to Craig`,
    pausedUntil: control.pauseUntil,
    // isPaused, not a bare presence check on pausedUntil: a lapsed timestamp is not a
    // pause, and --json has no renderer downstream to apply that guard itself.
    paused: isPaused(control, now),
    pool: pool === null ? null : poolPayload(pool),
    capacity: pool === null ? null : fundingPayload(cyclesFundableFrom(pool, cost, running.length)),
    estimatedCycleCost: {
      ...roundCost(cost),
      units: 'account-fractions consumed by one typical delivery cycle',
    },
    inFlight: running.map((cycle) => ({
      program: cycle.program,
      startedAt: cycle.startedAt,
      kind: cycle.kind,
    })),
    concurrencyCap: control.maxConcurrentCycles,
    programs: (await evaluateAll({ control, status, cycles, now })).map(({ program, decision, pid }) => ({
      name: program.name,
      cwd: program.cwd,
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

/** Non-finite only when every bucket's estimated cost is zero, which JSON cannot carry. */
const roundFinite = (value: number): number | null => (Number.isFinite(value) ? round(value) : null);

const describeFunding = (funding: Funding): string => {
  const perAccount = funding.accounts
    .map((account) => {
      // Naming the bucket for an account teamclaude will not route to would blame the
      // wrong thing: its buckets may be fine and it still cannot serve a Fable request.
      const why = account.routable ? account.binding : `${account.binding}, not routed`;
      return `${account.name} ${account.cycles.toFixed(2)} (${why})`;
    })
    .join(' · ');
  const carrying = contributingAccounts(funding);
  const spread = carrying === funding.accounts.length
    ? ''
    : ` from ${carrying} of ${funding.accounts.length} accounts`;
  return `${funding.cycles.toFixed(2)} cycles fundable${spread}, ${funding.binding} binding — ${perAccount}`;
};

const VERDICT_MEANING: Record<string, string> = {
  GO: 'a cycle would launch on the next tick',
  WAIT: 'transient — a later tick will retry, no action needed',
  STOP: 'needs a human: mode is off, or this program produced no yield for several cycles',
};

const showStatus = async (): Promise<void> => {
  const control = readControl(p.control);
  const status = await readStatus();
  const cycles = readCycles(p.cycles);
  const now = Date.now();
  const ceilings = ceilingsFor(control);
  // Same cutoff decide() uses, so the capacity line and the verdicts beneath it agree.
  const running = inFlight(cycles, now, control.maxCycleHours);

  const lastTick = readTickStamp(p.lastTick) ?? lastDecisionAt(p.decisions);
  console.log(`service: ${describeService(serviceState(), lastTick, now, tickLockHolder())}`);
  // isPaused, not a null check: a pause is only a pause while it is still in the future,
  // and decide() has always treated it that way. Reading pauseUntil !== null printed
  // "paused until 22:16" for hours after it lapsed, directly above verdicts that named a
  // different reason entirely — the same false-cause bug the panel had (CLAUDE.md).
  const pause = isPaused(control, now) ? ` (paused until ${control.pauseUntil})` : '';
  console.log(`mode: ${control.mode}${pause}`);
  if (ceilings !== null) {
    const pool = poolFrom(status, ceilings, now);
    const cost = estimateCycleCost(cycles, control.seedCycleCost);
    // Account-units, never a percentage: 0.81 across 3 accounts is 27% of the theoretical
    // pool, and printing it as "81%" reads as four fifths of the quota still free.
    console.log(
      `pool: fable ${pool.fable.toFixed(2)} · general ${pool.general.toFixed(2)}` +
        ` · session ${pool.session.toFixed(2)} account-units of headroom across` +
        ` ${pool.usableAccounts} accounts (1.00 = one whole account)`,
    );
    console.log(
      `cycle cost estimate: fable ${cost.fable.toFixed(3)} · general ${cost.general.toFixed(3)} · session ${cost.session.toFixed(3)}`,
    );
    // Printed next to the pool line because the pool line is what misleads: an account is
    // spendable only where it has room in all three buckets, so free-looking sums can fund
    // nothing at all. Charged the same way decide() charges — chargeForRunning, never the
    // raw count — or this line over-reports fundability against the verdicts beneath it
    // (the state.ts drift trap, which this call had re-made).
    const funding = cyclesFundableFrom(pool, cost, chargeForRunning(running, snapshot(pool), cost));
    console.log(`capacity: ${describeFunding(funding)}`);
    // The pool context, once. Every verdict beneath shares it; their reasons carry only
    // what is true of that program alone.
    console.log(`  ${poolContext(funding, pool, now)}`);
  }
  console.log(`cycles recorded: ${cycles.length} · zero-yield streak: ${consecutiveZeroYield(cycles)}`);

  const names = running.map((cycle) => cycle.program).join(', ');
  console.log(
    `in flight: ${running.length}/${control.maxConcurrentCycles}${running.length === 0 ? '' : ` (${names})`}`,
  );

  for (const { program, decision, pid } of await evaluateAll({ control, status, cycles, now })) {
    const shown = effectivePriority(program, now, control.deadlineHorizonDays);
    const flags = `${program.enabled ? '' : ' [disabled]'}${pid === null ? '' : ` [pid ${pid}]`}`;
    console.log(`  [p${shown}] ${program.name}${flags}: ${decision.verdict} — ${decision.reason}`);
  }
};


/**
 * Frees a program's pane when its runner has outlived the cycle that started it. Manual
 * on purpose: an idle runner with no report may hold unsaved work, and drovr choosing to
 * end it unprompted is the one kind of kill the design refuses. This is Craig deciding.
 *
 * Safe by construction rather than by care — `releaseRunner` will not send `/exit` to an
 * agent that is not settled, so a runner still working or waiting on a dialog is reported
 * and left alone rather than interrupted.
 */
const releaseRunner = async (name: string | undefined): Promise<void> => {
  if (name === undefined) throw new Error('release needs a program, e.g. `drovr release sunnyt`');
  const control = readControl(p.control);
  if (!control.programs.some((entry) => entry.name === name)) {
    throw new Error(`no program named "${name}" in ${p.control}`);
  }

  const state = await runnerState(name);
  if (state === 'gone') {
    // No claude to ask out, but the tab it left (or the pty it died in) may still be remembered.
    await freeRunner(name);
    console.log(`${name}: no runner to release — its terminal is free`);
    return;
  }
  const address = await runnerAddress(name);

  if (!isSettled(state)) {
    console.error(
      `${name}: its runner is ${state}, so it was left alone — /exit typed into a live ` +
        `turn is swallowed and the terminal stays held. Open ${address.where} and answer what it ` +
        `is waiting on, then run this again.` +
        (address.open === null ? '' : `\n  open it:  ${address.open}`),
    );
    process.exitCode = 1;
    return;
  }

  const released = await freeRunner(name);
  console.log(
    released
      ? `${name}: released its runner — the next tick can start a cycle`
      : `${name}: the runner did not exit; it still holds ${address.where}. Run this again, or ` +
        `close the tab` + (address.open === null ? '' : `:  ${address.open}`),
  );
  if (!released) process.exitCode = 1;
};

/**
 * The live tick-lock holder, for describeService. Read here rather than there so that
 * function stays pure — the same reason collectState takes its warning sink from the
 * caller instead of choosing one.
 */
const tickLockHolder = (): { pid: number; heldMs: number | null } | null => {
  const held = heldBy(p.tickLock);
  if (held === null) return null;
  return { pid: held.pid, heldMs: held.at === null ? null : Math.max(0, Date.now() - held.at) };
};

type LedgerView = { limit: number; json: boolean; closing: boolean; program: string | null; last: boolean };

/** The most recent ended cycle of each program, in the order those cycles started. */
const lastPerProgram = (cycles: CycleRecord[]): CycleRecord[] => {
  const byProgram = new Map<string, CycleRecord>();
  for (const cycle of latestEnds(cycles)) byProgram.set(cycle.program, cycle);
  return [...byProgram.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
};

const showLedger = ({ limit, json, closing, program, last }: LedgerView): void => {
  const mine = readCycles(p.cycles).filter((cycle) => program === null || cycle.program === program);
  const recent = last ? lastPerProgram(mine) : mine.slice(-limit);
  if (json) {
    console.log(JSON.stringify({ exitReasons: AGENT_NOTES.exitReasons, cycles: recent }, null, 2));
    return;
  }
  for (const cycle of recent) {
    const produced = cycle.yield;
    const total = produced === null ? '—' : produced.ticketsMoved + produced.prsOpened + produced.commits;
    console.log(
      `${cycle.startedAt.slice(0, 16)}  ${cycle.program.padEnd(16)} ${cycle.kind.padEnd(10)} ${cycle.exit.padEnd(9)} yield=${total} asks=${cycle.asksRaised}`,
    );
    if (closing && cycle.closing !== null) console.log(cycle.closing.replace(/^/gm, '    ') + '\n');
  }
};

const BUCKETS = ['fable', 'general', 'session'] as const;

/**
 * What the mode ceilings are actually protecting. `reserve` is a fraction Craig picks by
 * mode; this is the only place drovr says whether that fraction covers the consumer it
 * exists for. Measured, not modelled — and it feeds no gate, so reading it is safe to do
 * at any time.
 */
const showUsage = (json: boolean): void => {
  const samples = readSamples(p.usage);
  const cycles = readCycles(p.cycles);
  const control = readControl(p.control);
  const ceilings = control.mode === 'off' ? null : control.ceilings[control.mode] ?? null;
  const reserve = ceilings === null ? null : 1 - ceilings.weekly;

  const rows = BUCKETS.map((bucket) => ({
    bucket,
    latest: samples.length === 0 ? null : shareOf(samples.at(-1) as UsageSample, cycles, bucket),
    observed: observedYours(samples, cycles, bucket),
  }));

  if (json) {
    console.log(JSON.stringify({
      note:
        'yours = total account usage minus what drovr\'s own ledger accounts for, in ' +
        'account-units (N usable accounts = N.0). peakFraction is that peak as a share of ' +
        'the pool, directly comparable to configuredReserve. Sampled once per tick; ' +
        'nothing here feeds an admission decision.',
      samples: samples.length,
      firstSampleAt: samples[0]?.at ?? null,
      lastSampleAt: samples.at(-1)?.at ?? null,
      mode: control.mode,
      configuredReserve: reserve,
      buckets: rows.map((row) => ({
        bucket: row.bucket,
        yoursNow: row.latest === null ? null : Number(row.latest.yours.toFixed(3)),
        drovrNow: row.latest === null ? null : Number(row.latest.drovr.toFixed(3)),
        totalNow: row.latest === null ? null : Number(row.latest.total.toFixed(3)),
        observedPeakP90: row.observed === null ? null : Number(row.observed.peak.toFixed(3)),
        observedPeakFractionP90:
          row.observed === null ? null : Number(row.observed.peakFraction.toFixed(3)),
      })),
    }, null, 2));
    return;
  }

  if (samples.length === 0) {
    console.log('no usage samples yet — the tick records one per firing, so give it a tick.');
    return;
  }
  console.log(
    `${samples.length} samples, ${samples[0]!.at.slice(0, 16)} to ${samples.at(-1)!.at.slice(0, 16)}`,
  );
  console.log(`mode ${control.mode}${reserve === null ? '' : `, reserve held for you ${(reserve * 100).toFixed(0)}%`}`);
  console.log('');
  console.log('bucket    yours now  drovr now   your p90 peak   as % of pool');
  for (const row of rows) {
    const yours = row.latest === null ? '—' : row.latest.yours.toFixed(2);
    const drovr = row.latest === null ? '—' : row.latest.drovr.toFixed(2);
    const peak = row.observed === null ? '—' : row.observed.peak.toFixed(2);
    const pct = row.observed === null ? '—' : `${(row.observed.peakFraction * 100).toFixed(0)}%`;
    console.log(
      `${row.bucket.padEnd(9)} ${yours.padStart(9)} ${drovr.padStart(10)} ${peak.padStart(15)} ${pct.padStart(14)}`,
    );
  }

  const weekly = rows.find((row) => row.bucket === 'general')?.observed ?? null;
  if (weekly === null) {
    console.log('');
    console.log('Not enough samples yet to say whether the reserve is sized for you.');
    return;
  }
  if (reserve === null) return;
  console.log('');
  console.log(
    weekly.peakFraction > reserve
      ? `Your own weekly p90 (${(weekly.peakFraction * 100).toFixed(0)}%) is above the ` +
        `${(reserve * 100).toFixed(0)}% held for you — the reserve is under-sized for how you ` +
        `actually use the pool. Widen it with "drovr reserve ${Math.min(0.95, Math.ceil(weekly.peakFraction * 20) / 20).toFixed(2)}".`
      : `Your own weekly p90 (${(weekly.peakFraction * 100).toFixed(0)}%) fits inside the ` +
        `${(reserve * 100).toFixed(0)}% held for you — the reserve covers you as configured.`,
  );
};

const installService = (intervalSeconds: number): void => {
  ensureDirs();
  const cliPath = resolve(fileURLToPath(new URL('./cli.ts', import.meta.url)));
  const outcome = installAgent({
    tickIntervalSeconds: intervalSeconds,
    nodeBin: process.execPath, cliPath, logDir: p.logs, path: agentPath(),
  });
  console.log(`wrote ${plistPath()}`);
  if (outcome === 'reloaded') console.log(`  ${LABEL}: reloaded so it picks up this plist`);
  if (outcome === 'loaded') console.log(`  ${LABEL}: loaded — starts on its next interval`);
  if (outcome === 'failed') {
    console.error(`  ${LABEL}: could not load automatically. Run: ${bootstrapCommand(LABEL)}`);
    process.exitCode = 1;
  }
};

const flag = (rest: string[], name: string): string | undefined => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};

/** Appends a program, validating the whole file before it lands. */
const addProgram = (rest: string[]): void => {
  const [name, cwd] = rest;
  if (name === undefined || cwd === undefined) {
    throw new Error('usage: drovr add <name> <path> [--priority n] [--deadline YYYY-MM-DD] ...');
  }
  const absolute = resolve(cwd.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(absolute)) throw new Error(`${absolute} does not exist`);

  const asksPage = flag(rest, 'asks') ?? null;

  mutate((control) => {
    const programs = Array.isArray(control.programs) ? control.programs : [];
    if (programs.some((entry) => (entry as { name?: unknown }).name === name)) {
      throw new Error(`a program named "${name}" already exists`);
    }
    programs.push({
      name,
      cwd: absolute,
      priority: Number.parseInt(flag(rest, 'priority') ?? '0', 10),
      deadline: flag(rest, 'deadline') ?? null,
      ...(flag(rest, 'model') === undefined ? {} : { model: flag(rest, 'model') }),
      ...(rest.includes('--no-direnv') ? { useDirenv: false } : {}),
      ...(rest.includes('--no-aice') ? { aice: null } : { aice: { asksPage } }),
    });
    control.programs = programs;
  });
  console.log(`added ${name} → ${absolute}`);
  console.log('first tick will onboard it: reconstruct state, raise one ask, then stop');
};

/**
 * The loop agent's way to end its cycle: validated before anything touches disk, and
 * written atomically, so drovr's watch can never read a torn or malformed report. The
 * program-name check keeps a typo from stranding the report in a directory nothing
 * watches while the real cycle runs on to a stall.
 */
const reportCycle = (rest: string[]): void => {
  const { program, report } = parseReportArgs(rest, Date.now());
  const control = readControl(p.control);
  if (!control.programs.some((entry) => entry.name === program)) {
    const known = control.programs.map((entry) => entry.name).join(', ');
    throw new Error(`no program named "${program}" — tracked: ${known}`);
  }
  const written = writeReport(program, report);
  console.log(`reported ${program}: exit=${written.exit} → ${p.lastCycle(program)}`);

  // Applied here rather than by the tick so the request takes effect the moment it is
  // made, through the one code path that already validates the whole control file.
  if (written.pauseUntil !== null || written.cadence !== null) {
    mutate((control) => {
      const programs = Array.isArray(control.programs) ? (control.programs as Record<string, unknown>[]) : [];
      const entry = programs.find((candidate) => candidate.name === program);
      if (entry === undefined) throw new Error(`no program named "${program}" in control.json`);
      if (written.pauseUntil !== null) entry.pauseUntil = written.pauseUntil;
      if (written.cadence !== null) entry.cadence = written.cadence;
    });
    if (written.pauseUntil !== null) {
      console.log(`${program} rests until ${written.pauseUntil} — resume early: drovr resume ${program}`);
    }
    if (written.cadence !== null) {
      console.log(`${program} now runs at most once per ${written.cadence} — change: drovr cadence ${program} off`);
    }
  }
  console.log('the cycle is now over — drovr will close this session; start nothing new');
};

/**
 * `drovr cadence` — read, set, or clear a program's standing run frequency. Kept beside
 * report because a cycle can set the same field; this is Craig's handle on it.
 */
const setCadence = (rest: string[]): void => {
  const [name, value] = rest;
  const control = readControl(p.control);
  if (name === undefined) {
    for (const program of control.programs) {
      console.log(`  ${program.name}: ${program.cadence ?? 'every tick is a candidate'}`);
    }
    console.log('set with: drovr cadence <program> <every, e.g. 12h or 7d>  |  drovr cadence <program> off');
    return;
  }
  if (value === undefined) throw new Error('usage: drovr cadence <program> <every|off>');
  if (value !== 'off') parseDuration(value);
  mutate((raw) => {
    const programs = Array.isArray(raw.programs) ? (raw.programs as Record<string, unknown>[]) : [];
    const entry = programs.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no program named "${name}"`);
    entry.cadence = value === 'off' ? null : value;
  });
  console.log(value === 'off' ? `${name}: cadence cleared` : `${name}: at most one cycle per ${value}`);
};

const removeProgram = (name: string | undefined): void => {
  if (name === undefined) throw new Error('usage: drovr rm <name>');
  mutate((control) => {
    const programs = Array.isArray(control.programs) ? control.programs : [];
    const kept = programs.filter((entry) => (entry as { name?: unknown }).name !== name);
    if (kept.length === programs.length) throw new Error(`no program named "${name}"`);
    control.programs = kept;
  });
  console.log(`removed ${name} (its ledger history and ~/.drovr/programs/${name} are left alone)`);
};

const showService = (json: boolean): void => {
  const tick = serviceState();
  // The heartbeat is the liveness signal; the decision log is the fallback for an
  // install that predates it, so an upgrade does not read as 'no tick has ever run'.
  const lastTick = readTickStamp(p.lastTick) ?? lastDecisionAt(p.decisions);
  const now = Date.now();
  if (json) {
    console.log(JSON.stringify({
      tick: {
        health: serviceHealth(tick, lastTick, now),
        explanation: describeService(tick, lastTick, now, tickLockHolder()),
        lastTickAt: lastTick === null ? null : new Date(lastTick).toISOString(),
        ...tick, plistPath: plistPath(),
        loadCommand: bootstrapCommand(LABEL), unloadCommand: bootoutCommand(LABEL),
      },
    }, null, 2));
    return;
  }
  console.log(`tick: ${describeService(tick, lastTick, now, tickLockHolder())}`);
  if (tick.pid !== null) console.log(`  a tick is executing right now (pid ${tick.pid})`);
  console.log(`plist: ${plistPath()}`);
  console.log(`logs:  ${p.logs}`);
};

const uninstallService = (): void => {
  const target = plistPath();
  if (!existsSync(target)) {
    console.log(`${LABEL}: not installed`);
    return;
  }
  console.log(`${LABEL}: unload it with:  ${bootoutCommand(LABEL)}`);
  console.log(`${LABEL}: then remove:     rm ${target}`);
};

const showHelp = (topic: string | undefined, json: boolean): void => {
  if (json) {
    console.log(JSON.stringify(topic === undefined ? helpTree() : findCommand(topic), null, 2));
    return;
  }
  if (topic === undefined) {
    console.log(renderList());
    return;
  }
  const command = findCommand(topic);
  if (command === undefined) {
    throw new Error(`no command named "${topic}" — run \`drovr help\` for the list`);
  }
  console.log(renderCommand(command));
};

/**
 * `tick` and `run-cycle` are the only two commands that never run in front of a human: their
 * output goes straight to a launchd redirect or a `<program>-worker.log`, where an undated line
 * cannot be lined up with the ledger record that explains it. UTC ISO so it lines up with
 * cycles.jsonl exactly. Every other command prints to a terminal or to an agent parsing it,
 * where a prefix is noise at best and broken JSON at worst — so this is opt-in, not global.
 */
const stampConsole = (): void => {
  for (const level of ['log', 'error'] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]): void => write(new Date().toISOString(), ...args);
  }
};

const main = async (argv: string[]): Promise<void> => {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');

  // `drovr <cmd> --help` reaches the same detail page as `drovr help <cmd>`.
  if (command !== undefined && rest.includes('--help') && findCommand(command) !== undefined) {
    return showHelp(command, json);
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    return showHelp(
      rest.find((argument) => !argument.startsWith('-')),
      json,
    );
  }

  if (command === 'init') return init();
  if (command === 'tick') {
    stampConsole();
    return tick();
  }
  if (command === 'run-cycle') {
    const name = rest[0];
    if (name === undefined) throw new Error('run-cycle needs a program name');
    stampConsole();
    return runProgramCycle(name);
  }
  if (command === 'status') {
    if (json) {
      console.log(JSON.stringify(await statusPayload(), null, 2));
      return;
    }
    return showStatus();
  }
  if (command === 'add') return addProgram(rest);
  if (command === 'rm') return removeProgram(rest[0]);
  if (command === 'report') return reportCycle(rest);
  if (command === 'watch') return watch(Number.parseInt(rest[0] ?? '15', 10));
  if (command === 'ledger') {
    const words = rest.filter((a) => !a.startsWith('-'));
    return showLedger({
      program: words.find((a) => !/^\d+$/.test(a)) ?? null,
      limit: Number.parseInt(words.find((a) => /^\d+$/.test(a)) ?? '20', 10),
      json,
      closing: rest.includes('--closing'),
      last: rest.includes('--last'),
    });
  }

  if (command === 'usage') return showUsage(json);

  if (command === 'release') return releaseRunner(rest[0]);

  if (command === 'pause') {
    const [first, second] = rest;
    if (first === undefined) {
      throw new Error('usage: drovr pause <duration>  |  drovr pause <program> <duration>');
    }
    // A bare duration pauses everything; a program name pauses that program alone.
    const scoped = !/^\d+[mhd]$/.test(first);
    const spec = scoped ? second : first;
    if (spec === undefined) throw new Error(`pause needs a duration, e.g. \`drovr pause ${first} 3h\``);
    const until = new Date(Date.now() + parseDuration(spec)).toISOString();
    mutate((control) => {
      if (!scoped) {
        control.pauseUntil = until;
        return;
      }
      const programs = Array.isArray(control.programs) ? (control.programs as Record<string, unknown>[]) : [];
      const entry = programs.find((candidate) => candidate.name === first);
      if (entry === undefined) throw new Error(`no program named "${first}"`);
      entry.pauseUntil = until;
    });
    console.log(scoped ? `${first} paused until ${until}` : `paused until ${until}`);
    return;
  }

  if (command === 'resume') {
    const name = rest.find((argument) => !argument.startsWith('-'));
    mutate((control) => {
      if (name === undefined) {
        control.pauseUntil = null;
        return;
      }
      const programs = Array.isArray(control.programs) ? (control.programs as Record<string, unknown>[]) : [];
      const entry = programs.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`no program named "${name}"`);
      entry.pauseUntil = null;
    });
    console.log(name === undefined ? 'resumed' : `${name} resumed`);
    return;
  }

  if (command === 'cadence') return setCadence(rest);

  if (command === 'cap') {
    const [name, value] = rest;
    const control = readControl(p.control);
    if (name === undefined) {
      console.log(`global daily cap: ${control.maxCyclesPerDay}`);
      for (const program of control.programs) {
        const own = program.maxCyclesPerDay;
        console.log(`  ${program.name}: ${own === null ? `${control.maxCyclesPerDay} (global)` : own}`);
      }
      console.log('set with: drovr cap <n>  |  drovr cap <program> <n>  |  drovr cap <program> global');
      return;
    }

    // `drovr cap 12` sets the global; `drovr cap aice-x 12` overrides one program.
    const globalOnly = value === undefined && Number.isFinite(Number.parseInt(name, 10));
    mutate((raw) => {
      if (globalOnly) {
        raw.maxCyclesPerDay = Number.parseInt(name, 10);
        return;
      }
      const programs = Array.isArray(raw.programs) ? raw.programs : [];
      const found = programs.find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === name,
      );
      if (found === undefined) throw new Error(`no program named "${name}"`);
      found.maxCyclesPerDay = value === 'global' ? null : Number.parseInt(value ?? '', 10);
      if (value !== 'global' && !Number.isFinite(found.maxCyclesPerDay)) {
        throw new Error('usage: drovr cap <program> <n|global>');
      }
    });
    console.log(globalOnly ? `global daily cap → ${name}` : `${name} daily cap → ${value}`);
    return;
  }

  if (command === 'start') {
    const name = rest[0];
    if (name === undefined) throw new Error('usage: drovr start <program>');
    const control = readControl(p.control);
    const program = control.programs.find((entry) => entry.name === name);
    if (program === undefined) throw new Error(`no program named "${name}"`);
    // Detached, like tick does, so it does not hold the terminal for the whole cycle.
    launchDetached(program.name);
    return;
  }

  if (command === 'notify') {
    const control = readControl(p.control);
    const wanted = rest.filter((arg) => arg !== '--json');
    const message =
      wanted.length > 0
        ? wanted.join(' ')
        : `drovr: notification test from ${hostname()} at ${new Date().toISOString()}`;

    if (control.phoneNumber === null) {
      console.error('no phoneNumber in ~/.drovr/control.json, so drovr cannot text anyone.');
      process.exitCode = 1;
      return;
    }

    const result = await textCraig(control.phoneNumber, message, control.originationNumber);
    const from = control.originationNumber ?? 'whichever number SNS picks';

    // Accepting a message and delivering it are different events, minutes apart. The
    // only place the difference shows up is the delivery log, so look rather than guess.
    const verdict = rest.includes('--no-verify')
      ? unverified('not checked (--no-verify)')
      : await verifyDelivery(result, 90_000);

    if (json) {
      console.log(
        JSON.stringify(
          {
            accepted: result.sent,
            delivery: verdict.state,
            reason: verdict.reason,
            to: control.phoneNumber,
            from,
            via: result.via,
            messageId: result.messageId,
            message,
            note: 'accepted means the API took the message; delivery is the one that matters',
            usingThis: AGENT_NOTES,
          },
          null,
          2,
        ),
      );
      if (!result.sent || verdict.state === 'failed') process.exitCode = 1;
      return;
    }
    if (!result.sent) {
      console.error('the send was refused — the reason is logged above.');
      process.exitCode = 1;
      return;
    }
    console.log(`sent to ${control.phoneNumber} from ${from} via ${result.via}`);
    console.log(`delivery: ${verdict.state} — ${verdict.reason}`);
    if (verdict.state === 'failed') process.exitCode = 1;
    return;
  }

  if (command === 'tidy') {
    const control = readControl(p.control);
    const running = new Set(inFlightCycles().map((cycle) => cycle.program));
    for (const program of control.programs) {
      if (running.has(program.name)) {
        console.log(`${program.name}: cycle in flight, left alone`);
        continue;
      }
      const closed = await tidyRunnerTerminal(program.name);
      console.log(
        closed === null
          ? `${program.name}: no empty cycle terminal`
          : `${program.name}: closed ${closed}`,
      );
    }
    return;
  }

  if (command === 'reserve') {
    const control = readControl(p.control);
    if (control.mode === 'off') throw new Error('mode is off — nothing is being spent to reserve against');
    const ceilings = control.ceilings[control.mode];
    if (rest[0] === undefined) {
      const held = 1 - (ceilings?.weekly ?? 0);
      console.log(
        `${Math.round(held * 100)}% of each account's weekly quota is held for you in mode "${control.mode}"`,
      );
      console.log(`set it with: drovr reserve <percent>`);
      return;
    }
    const percent = Number.parseFloat(rest[0].replace('%', ''));
    if (!Number.isFinite(percent)) throw new Error(`reserve needs a percentage, e.g. \`drovr reserve 45\``);
    console.log(setReserve(p.control, control.mode, percent / 100).message);
    return;
  }

  if (command === 'mode') {
    const mode = rest[0];
    if (mode === undefined) throw new Error('mode needs one of: off, low, normal, away');
    mutate((control) => { control.mode = mode; });
    console.log(`mode set to ${mode}`);
    return;
  }

  if (command === 'service') {
    const sub = rest[0];
    const seconds = Number.parseInt(rest[1] ?? '600', 10);
    if (sub === 'status') return showService(json);
    if (sub === 'uninstall') return uninstallService();
    if (sub === 'install') return installService(seconds);
    if (sub === 'print') {
      const cliPath = resolve(fileURLToPath(new URL('./cli.ts', import.meta.url)));
      console.log(plist({
        label: LABEL, command: 'tick', nodeBin: process.execPath, cliPath,
        intervalSeconds: seconds, logDir: p.logs, path: agentPath(),
      }));
      return;
    }
    throw new Error(`unknown service subcommand "${sub ?? ''}" — expected status, install, uninstall or print (label: ${LABEL})`);
  }

  console.error(command === undefined ? '' : `unknown command "${command}"\n`);
  console.log(renderList());
  if (command !== undefined) process.exitCode = 1;
};

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
