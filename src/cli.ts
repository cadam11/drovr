#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, effectivePriority, parseControl, readControl } from './control.ts';
import { decide } from './decide.ts';
import {
  consecutiveZeroYield,
  estimateCycleCost,
  readCycles,
  type CycleRecord,
} from './ledger.ts';
import { holder } from './lock.ts';
import { ensureDirs, paths } from './paths.ts';
import { LABEL, plist, plistPath } from './service.ts';
import { readStatus } from './teamclaude.ts';
import { inFlightCycles, runProgramCycle, tick } from './tick.ts';

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

const showStatus = async (): Promise<void> => {
  const control = readControl(p.control);
  const status = await readStatus();
  const cycles = readCycles(p.cycles);
  const now = Date.now();
  const ceilings = ceilingsFor(control);

  console.log(`mode: ${control.mode}${control.pauseUntil === null ? '' : ` (paused until ${control.pauseUntil})`}`);
  if (ceilings !== null) {
    const pool = poolFrom(status, ceilings, now);
    const cost = estimateCycleCost(cycles, control.seedCycleCost);
    console.log(
      `pool: fable ${(pool.fable * 100).toFixed(0)}% · general ${(pool.general * 100).toFixed(0)}%` +
        ` · session ${(pool.session * 100).toFixed(0)}% across ${pool.usableAccounts} accounts`,
    );
    console.log(
      `cycle cost estimate: fable ${cost.fable.toFixed(3)} · general ${cost.general.toFixed(3)} · session ${cost.session.toFixed(3)}`,
    );
  }
  console.log(`cycles recorded: ${cycles.length} · zero-yield streak: ${consecutiveZeroYield(cycles)}`);

  const running = inFlightCycles();
  const names = running.map((cycle) => cycle.program).join(', ');
  console.log(
    `in flight: ${running.length}/${control.maxConcurrentCycles}${running.length === 0 ? '' : ` (${names})`}`,
  );

  // Tick launches in priority order and each launch reserves capacity, so the
  // preview must accumulate its own hypothetical launches to match reality.
  const projected: CycleRecord[] = [];
  for (const program of byPriority(control.programs, now, control.deadlineHorizonDays)) {
    const decision = decide({
      status,
      control,
      cycles: [...cycles, ...projected],
      program: program.name,
      now,
    });
    const pid = holder(p.programLock(program.name));
    const shown = effectivePriority(program, now, control.deadlineHorizonDays);
    const flags = `${program.enabled ? '' : ' [disabled]'}${pid === null ? '' : ` [pid ${pid}]`}`;
    console.log(`  [p${shown}] ${program.name}${flags}: ${decision.verdict} — ${decision.reason}`);

    if (decision.verdict !== 'GO' || !program.enabled) continue;
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
};

const showLedger = (limit: number): void => {
  for (const cycle of readCycles(p.cycles).slice(-limit)) {
    const produced = cycle.yield;
    const total = produced === null ? '—' : produced.ticketsMoved + produced.prsOpened + produced.commits;
    console.log(
      `${cycle.startedAt.slice(0, 16)}  ${cycle.program.padEnd(16)} ${cycle.kind.padEnd(10)} ${cycle.exit.padEnd(9)} yield=${total} asks=${cycle.asksRaised}`,
    );
  }
};

const installService = (intervalSeconds: number): void => {
  ensureDirs();
  const cliPath = resolve(fileURLToPath(new URL('./cli.ts', import.meta.url)));
  const target = plistPath();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, plist({ nodeBin: process.execPath, cliPath, intervalSeconds, logDir: p.logs }), 'utf8');
  console.log(`wrote ${target}`);
  console.log(`load it with:  launchctl bootstrap gui/$(id -u) ${target}`);
};

const usage = `drovr — capacity-aware supervisor for long-horizon delivery loops

  drovr init                 write ~/.drovr/control.json
  drovr status               pool capacity, cost estimate, per-program verdict
  drovr tick                 evaluate once; launch cycles where capacity allows
  drovr run-cycle <program>  run one cycle now (what tick launches)
  drovr pause <30m|3h|2d>    hold cycles for a while
  drovr resume               clear a pause
  drovr mode <off|low|normal|away>
  drovr ledger [n]           last n cycles (default 20)
  drovr service install [seconds]   write the launchd agent (default 600)
  drovr service print               print the plist without writing it
`;

const main = async (argv: string[]): Promise<void> => {
  const [command, ...rest] = argv;

  if (command === 'init') return init();
  if (command === 'tick') return tick();
  if (command === 'run-cycle') {
    const name = rest[0];
    if (name === undefined) throw new Error('run-cycle needs a program name');
    return runProgramCycle(name);
  }
  if (command === 'status') return showStatus();
  if (command === 'ledger') return showLedger(Number.parseInt(rest[0] ?? '20', 10));

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
    if (sub === 'install') return installService(seconds);
    if (sub === 'print') {
      const cliPath = resolve(fileURLToPath(new URL('./cli.ts', import.meta.url)));
      console.log(plist({ nodeBin: process.execPath, cliPath, intervalSeconds: seconds, logDir: p.logs }));
      return;
    }
    throw new Error(`unknown service subcommand "${sub ?? ''}" — expected install or print (label: ${LABEL})`);
  }

  console.log(usage);
  if (command !== undefined && command !== 'help' && command !== '--help') process.exitCode = 1;
};

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
