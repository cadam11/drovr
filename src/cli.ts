#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, effectivePriority, parseControl, readControl } from './control.ts';
import { cyclesFundableFrom, decide, type Funding } from './decide.ts';
import {
  consecutiveZeroYield,
  estimateCycleCost,
  inFlight,
  lastDecisionAt,
  readCycles,
  type CycleRecord,
} from './ledger.ts';
import { AGENT_NOTES, findCommand, helpTree, renderCommand, renderList } from './help.ts';
import { readAsks } from './asks.ts';
import { textCraig } from './nudge.ts';
import { unverified, verifyDelivery } from './delivery.ts';
import { resolveWorkspace, tidyCycleTabs } from './herdr.ts';
import { setReserve } from './keys.ts';
import { holder } from './lock.ts';
import { ensureDirs, paths } from './paths.ts';
import { publishSnapshot, readMarker, readRunMarker } from './publish-snapshot.ts';
import {
  bootoutCommand,
  bootstrapCommand,
  installAgents,
  agentPath,
  describeService,
  describeSnapshotAgent,
  LABEL,
  plist,
  plistPath,
  plistPathFor,
  SNAPSHOT_LABEL,
  serviceHealth,
  serviceState,
  snapshotServiceState,
} from './service.ts';
import { readStatus } from './teamclaude.ts';
import { inFlightCycles, launchDetached, runProgramCycle, tick } from './tick.ts';
import { watch } from './watch.ts';

const p = paths();

const defaultControl = {
  mode: 'normal',
  pauseUntil: null,
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

const parseDuration = (input: string): number => {
  const match = /^(\d+)([mhd])$/.exec(input);
  if (match === null) throw new Error(`duration must look like 30m, 3h, or 2d — got "${input}"`);
  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * ms;
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

  return ordered.map((program) => {
    const decision = decide({
      status,
      control,
      cycles: [...cycles, ...projected],
      program: program.name,
      now,
      answeredAt: asks.get(program.name)?.latestAt ?? null,
      asksShared: asks.get(program.name)?.shared ?? null,
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
  perAccount: funding.accounts.map((account) => ({
    name: account.name,
    cyclesFundable: roundFinite(account.cycles),
    bindingBucket: account.binding,
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
  const lastTick = lastDecisionAt(p.decisions);
  // control.maxCycleHours, never inFlight's own 24h default: decide() and buildState both
  // cut off there, and a 13h-old cycle with no end record would otherwise have this payload
  // reserving a cycle the per-program verdicts printed from it do not.
  const running = inFlight(cycles, now, control.maxCycleHours);
  const pool = ceilings === null ? null : poolFrom(status, ceilings, now);
  const cost = estimateCycleCost(cycles, control.seedCycleCost);

  return {
    service: {
      health: serviceHealth(state, lastTick, now),
      explanation: describeService(state, lastTick, now),
      lastTickAt: iso(lastTick),
    },
    mode: control.mode,
    modeMeaning:
      control.mode === 'off'
        ? 'no cycles will start'
        : `programs may use up to ${round((control.ceilings[control.mode]?.weekly ?? 0) * 100)}% of each account's weekly quota; the rest stays available to Craig`,
    pausedUntil: control.pauseUntil,
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
    .map((account) => `${account.name} ${account.cycles.toFixed(2)} (${account.binding})`)
    .join(' · ');
  return `${funding.cycles.toFixed(2)} cycles fundable, ${funding.binding} binding — ${perAccount}`;
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

  console.log(`service: ${describeService(serviceState(), lastDecisionAt(p.decisions), now)}`);
  console.log(`mode: ${control.mode}${control.pauseUntil === null ? '' : ` (paused until ${control.pauseUntil})`}`);
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
    // nothing at all.
    console.log(`capacity: ${describeFunding(cyclesFundableFrom(pool, cost, running.length))}`);
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

const showLedger = (limit: number, json: boolean): void => {
  const recent = readCycles(p.cycles).slice(-limit);
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
  }
};

/** Installs and reloads both the tick and snapshot launchd agents in one call —
 * see service.ts:installAgents for why they must never be split into two steps. */
const installService = (intervalSeconds: number): void => {
  ensureDirs();
  const cliPath = resolve(fileURLToPath(new URL('./cli.ts', import.meta.url)));
  const results = installAgents({
    tickIntervalSeconds: intervalSeconds,
    nodeBin: process.execPath, cliPath, logDir: p.logs, path: agentPath(),
  });
  for (const { label, outcome } of results) {
    console.log(`wrote ${plistPathFor(label)}`);
    if (outcome === 'reloaded') console.log(`  ${label}: reloaded so it picks up this plist`);
    if (outcome === 'loaded') console.log(`  ${label}: loaded — starts on its next interval`);
    if (outcome === 'failed') {
      console.error(`  ${label}: could not load automatically. Run: ${bootstrapCommand(label)}`);
      process.exitCode = 1;
    }
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

  const statusPage = flag(rest, 'status-page') ?? `craig/drovr-status.html`;
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
      ...(rest.includes('--no-aice') ? { aice: null } : { aice: { asksPage, statusPage } }),
    });
    control.programs = programs;
  });
  console.log(`added ${name} → ${absolute}`);
  console.log('first tick will onboard it: reconstruct state, publish, raise one ask, then stop');
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

/** Both agents are independent launchd entries — see CLAUDE.md's service.ts trap —
 * so status is reported for each rather than folded into one combined shape. */
const showService = (json: boolean): void => {
  const tick = serviceState();
  const snapshot = snapshotServiceState();
  const lastTick = lastDecisionAt(p.decisions);
  // lastRunAt (every invocation) drives health/description, not lastPublishedAt
  // (only an actual publish) — shouldPublish deliberately skips most invocations,
  // so publishedAt alone reads a healthy agent as stalled (CLAUDE.md I1).
  const lastRunAt = readRunMarker(p.snapshotRun)?.lastRunAt ?? null;
  const lastPublishedAt = readMarker(p.snapshotState)?.publishedAt ?? null;
  const now = Date.now();
  if (json) {
    console.log(JSON.stringify({
      tick: {
        health: serviceHealth(tick, lastTick, now),
        explanation: describeService(tick, lastTick, now),
        lastTickAt: lastTick === null ? null : new Date(lastTick).toISOString(),
        ...tick, plistPath: plistPath(),
        loadCommand: bootstrapCommand(LABEL), unloadCommand: bootoutCommand(LABEL),
      },
      snapshot: {
        health: serviceHealth(snapshot, lastRunAt, now),
        explanation: describeSnapshotAgent(snapshot, lastRunAt, now),
        lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
        lastPublishedAt: lastPublishedAt === null ? null : new Date(lastPublishedAt).toISOString(),
        ...snapshot, plistPath: plistPathFor(SNAPSHOT_LABEL),
        loadCommand: bootstrapCommand(SNAPSHOT_LABEL), unloadCommand: bootoutCommand(SNAPSHOT_LABEL),
      },
    }, null, 2));
    return;
  }
  console.log(`tick: ${describeService(tick, lastTick, now)}`);
  if (tick.pid !== null) console.log(`  a tick is executing right now (pid ${tick.pid})`);
  console.log(`snapshot: ${describeSnapshotAgent(snapshot, lastRunAt, now)}`);
  if (snapshot.pid !== null) console.log(`  a snapshot publish is executing right now (pid ${snapshot.pid})`);
  console.log(`plists: ${plistPath()}`);
  console.log(`        ${plistPathFor(SNAPSHOT_LABEL)}`);
  console.log(`logs:   ${p.logs}`);
};

const uninstallService = (): void => {
  for (const label of [LABEL, SNAPSHOT_LABEL]) {
    const target = plistPathFor(label);
    if (!existsSync(target)) {
      console.log(`${label}: not installed`);
      continue;
    }
    console.log(`${label}: unload it with:  ${bootoutCommand(label)}`);
    console.log(`${label}: then remove:     rm ${target}`);
  }
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
  if (command === 'tick') return tick();
  if (command === 'snapshot') {
    const outcome = await publishSnapshot();
    if (outcome === 'failed') {
      console.error('snapshot publish failed — see the reason logged above');
      process.exitCode = 1;
      return;
    }
    console.log(outcome === 'published' ? 'snapshot published' : 'snapshot unchanged — not published');
    return;
  }
  if (command === 'run-cycle') {
    const name = rest[0];
    if (name === undefined) throw new Error('run-cycle needs a program name');
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
  if (command === 'watch') return watch(Number.parseInt(rest[0] ?? '15', 10));
  if (command === 'ledger') {
    const limit = Number.parseInt(rest.find((a) => !a.startsWith('-')) ?? '20', 10);
    return showLedger(limit, json);
  }

  if (command === 'pause') {
    const spec = rest[0];
    if (spec === undefined) throw new Error('pause needs a duration, e.g. `drovr pause 3h`');
    const until = new Date(Date.now() + parseDuration(spec)).toISOString();
    mutate((control) => { control.pauseUntil = until; });
    console.log(`paused until ${until}`);
    return;
  }

  if (command === 'resume') {
    mutate((control) => { control.pauseUntil = null; });
    console.log('resumed');
    return;
  }

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
      const workspaceId = await resolveWorkspace(program).catch(() => null);
      if (workspaceId === null) {
        console.log(`${program.name}: no herdr workspace, nothing to tidy`);
        continue;
      }
      const closed = await tidyCycleTabs({ program: program.name, workspaceId, keepTabId: null });
      console.log(
        closed.length === 0
          ? `${program.name}: no empty cycle tabs`
          : `${program.name}: closed ${closed.join(', ')}`,
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
