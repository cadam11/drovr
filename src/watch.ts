import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allocationFor, type Allocation, type BucketName } from './allocation.ts';
import { hoursToWeeklyReset, poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, effectivePriority, readControl, type Program } from './control.ts';
import { decide } from './decide.ts';
import {
  estimateCycleCost,
  inFlight,
  lastDecisionAt,
  readCycles,
  spentSince,
  type CycleRecord,
} from './ledger.ts';
import {
  adjustConcurrency,
  cycleMode,
  cyclePause,
  extendPause,
  nudgePriority,
  toggleEnabled,
  type Action,
} from './keys.ts';
import { interruptAgent } from './herdr.ts';
import { holder } from './lock.ts';
import { paths } from './paths.ts';
import { describeService, serviceState } from './service.ts';
import { readStatus, type TeamclaudeStatus } from './teamclaude.ts';

const ESC = '\x1b[';
const CTRL_C = '\x03';

const dim = (text: string): string => `${ESC}2m${text}${ESC}0m`;
const bold = (text: string): string => `${ESC}1m${text}${ESC}0m`;
const paint = (code: number, text: string): string => `${ESC}${code}m${text}${ESC}0m`;
const invert = (text: string): string => `${ESC}7m${text}${ESC}0m`;

const VERDICT_COLOUR: Record<string, number> = { GO: 32, WAIT: 33, STOP: 31, RUN: 36 };

const SEGMENTS: { key: keyof Allocation; char: string; colour: number; label: string }[] = [
  { key: 'yoursSpent', char: '▓', colour: 35, label: 'you spent' },
  { key: 'programsSpent', char: '█', colour: 32, label: 'programs spent' },
  { key: 'programsReserved', char: '▒', colour: 36, label: 'in flight' },
  { key: 'programsAvailable', char: '░', colour: 90, label: 'free to programs' },
  { key: 'yoursReserved', char: '·', colour: 35, label: 'held for you' },
];

const BUCKETS: { name: BucketName; label: string }[] = [
  { name: 'fable', label: 'fable   7d' },
  { name: 'general', label: 'general 7d' },
  { name: 'session', label: 'session 5h' },
];

const SEED_COST = { fable: 0.1, general: 0.08, session: 0.25 };

/** Largest-remainder allocation so the bar is always exactly `width` cells. */
const barCells = (allocation: Allocation, width: number): number[] => {
  const exact = SEGMENTS.map(
    (segment) => ((allocation[segment.key] as number) / allocation.total) * width,
  );
  const floors = exact.map(Math.floor);
  const deficit = width - floors.reduce((total, value) => total + value, 0);
  const promoted = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, Math.max(0, deficit))
    .map((entry) => entry.index);
  return floors.map((value, index) => value + (promoted.includes(index) ? 1 : 0));
};

const bar = (allocation: Allocation, width: number): string =>
  barCells(allocation, width)
    .map((cells, index) => paint(SEGMENTS[index]!.colour, SEGMENTS[index]!.char.repeat(cells)))
    .join('');

const percent = (value: number, total: number): string => `${((value / total) * 100).toFixed(0)}%`;

const elapsed = (since: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
};

const KEYBAR = [
  'j/k select',
  'space enable',
  '[ ] priority',
  'm mode',
  'p pause',
  '+/- cap',
  'r refresh',
  't tick',
  'x interrupt',
  'q quit',
].join(dim(' · '));

type State = { selected: number; message: string; confirmStop: boolean };

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
};

const allocationLines = (input: {
  status: TeamclaudeStatus;
  cycles: CycleRecord[];
  ceilings: { weekly: number; session: number };
  now: number;
  barWidth: number;
}): string[] => {
  const { status, cycles, ceilings, now, barWidth } = input;
  const pool = poolFrom(status, ceilings, now);
  const cost = estimateCycleCost(cycles, SEED_COST);
  const running = inFlight(cycles);
  const hoursLeft = hoursToWeeklyReset(status, now);
  const windowStart = hoursLeft === null ? now : now - (168 - hoursLeft) * 3_600_000;
  const spent = spentSince(cycles, windowStart);

  const rows = BUCKETS.map((bucket) => {
    const allocation = allocationFor({
      status,
      pool,
      bucket: bucket.name,
      spentByPrograms: spent[bucket.name],
      runningCycles: running.length,
      cycleCost: cost,
      now,
    });
    const yours = allocation.yoursSpent + allocation.yoursReserved;
    return (
      `  ${bucket.label.padEnd(11)}${bar(allocation, barWidth)} ` +
      `${dim(`you ${percent(yours, allocation.total).padStart(4)}`)}`
    );
  });

  const resetIn = hoursLeft === null ? '—' : `${Math.floor(hoursLeft)}h`;
  return [
    '',
    `  ${bold('ALLOCATION')}  ${dim(`${pool.usableAccounts} accounts · weekly resets in ${resetIn}`)}`,
    `  ${SEGMENTS.map((s) => `${paint(s.colour, s.char)} ${dim(s.label)}`).join('  ')}`,
    '',
    ...rows,
  ];
};

const programLines = (input: {
  programs: Program[];
  status: TeamclaudeStatus;
  control: ReturnType<typeof readControl>;
  cycles: CycleRecord[];
  now: number;
  state: State;
}): string[] => {
  const { programs, status, control, cycles, now, state } = input;
  const running = inFlight(cycles);
  const nameWidth = Math.max(8, ...programs.map((program) => program.name.length)) + 6;
  const projected: CycleRecord[] = [];

  return programs.map((program, index) => {
    const live = running.find((cycle) => cycle.program === program.name);
    const decision = decide({
      status,
      control,
      cycles: [...cycles, ...projected],
      program: program.name,
      now,
    });
    if (decision.verdict === 'GO' && program.enabled && live === undefined) {
      projected.push({
        ...RUNNING_PLACEHOLDER,
        program: program.name,
        startedAt: new Date(now).toISOString(),
      });
    }

    const priority = effectivePriority(program, now, control.deadlineHorizonDays);
    const verdict = live === undefined ? decision.verdict : 'RUN';
    const pid = holder(paths().programLock(program.name));
    const detail =
      live === undefined
        ? decision.reason
        : `pid ${pid ?? '?'} · ${elapsed(live.startedAt, now)} · ${live.kind}`;
    const label = `${program.name}${program.enabled ? '' : ' (off)'}`.padEnd(nameWidth);
    const selected = index === state.selected;

    return (
      ` ${selected ? paint(36, '▸') : ' '}${dim(`p${String(priority).padStart(2)}`)} ` +
      `${selected ? invert(label) : label} ` +
      `${paint(VERDICT_COLOUR[verdict] ?? 37, verdict.padEnd(4))}  ${dim(detail)}`
    );
  });
};

const frame = async (state: State): Promise<string> => {
  const p = paths();
  const status = await readStatus();
  const control = readControl(p.control);
  const cycles = readCycles(p.cycles);
  const now = Date.now();
  const width = Math.max(60, Math.min(process.stdout.columns ?? 100, 120));
  const ceilings = ceilingsFor(control);
  const programs = byPriority(control.programs, now, control.deadlineHorizonDays);
  const running = inFlight(cycles);

  const held =
    control.pauseUntil !== null && Date.parse(control.pauseUntil) > now
      ? paint(33, ` paused until ${control.pauseUntil.slice(11, 16)}`)
      : '';

  const service = describeService(serviceState(), lastDecisionAt(p.decisions), now);
  const healthy = service.startsWith('loaded') && !service.includes('overdue');

  const lines = [
    `${bold('drovr')}  ${dim(`mode ${control.mode}`)}${held}  ` +
      dim(new Date(now).toTimeString().slice(0, 8)),
    `  ${paint(healthy ? 32 : 31, '●')} ${dim(service)}`,
  ];

  lines.push(
    ...(ceilings === null
      ? ['', paint(31, '  mode is off — press m to cycle modes')]
      : allocationLines({ status, cycles, ceilings, now, barWidth: width - 28 })),
  );

  lines.push(
    '',
    `  ${bold('PROGRAMS')}  ${dim(`${running.length}/${control.maxConcurrentCycles} in flight`)}`,
    ...programLines({ programs, status, control, cycles, now, state }),
  );

  const recent = cycles.filter((cycle) => cycle.endedAt !== null).slice(-5).reverse();
  if (recent.length > 0) {
    lines.push('', `  ${bold('RECENT')}`);
    lines.push(
      ...recent.map((cycle) =>
        dim(
          `  ${cycle.startedAt.slice(5, 16).replace('T', ' ')}  ${cycle.program.padEnd(10)}` +
            `${cycle.kind.padEnd(11)}${cycle.exit.padEnd(9)}asks=${cycle.asksRaised}`,
        ),
      ),
    );
  }

  lines.push('', state.message === '' ? '  ' : paint(36, `  ${state.message}`), `  ${KEYBAR}`);
  return lines.join('\n');
};

const cliPath = (): string => fileURLToPath(new URL('./cli.ts', import.meta.url));

const runTickNow = (): Action => {
  const child = spawn(process.execPath, [cliPath(), 'tick'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { message: 'tick launched', redraw: true };
};

/**
 * A herdr cycle is a real session Craig can talk to, so this interrupts it rather
 * than killing it — the runner gets to wind down and write its report. The headless
 * runner has no such affordance, so its process group is signalled instead.
 */
const stopCycle = async (program: Program): Promise<Action> => {
  if (program.runner === 'herdr') {
    try {
      await interruptAgent(`drovr-${program.name}`.toLowerCase());
      return { message: `interrupted ${program.name} — it can still wind down cleanly`, redraw: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { message: `could not interrupt ${program.name}: ${detail}`, redraw: false };
    }
  }

  const pid = holder(paths().programLock(program.name));
  if (pid === null) return { message: `${program.name} has no cycle running`, redraw: false };
  try {
    process.kill(-pid, 'SIGTERM');
    return { message: `sent SIGTERM to ${program.name} (pid ${pid})`, redraw: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { message: `could not stop ${program.name}: ${detail}`, redraw: false };
  }
};

const handle = async (key: string, state: State, programs: Program[]): Promise<Action> => {
  const control = paths().control;
  const selected = programs[state.selected];
  const settings = readControl(control);

  if (state.confirmStop) {
    state.confirmStop = false;
    if (key !== 'y') return { message: 'stop cancelled', redraw: true };
    return selected === undefined
      ? { message: 'no program selected', redraw: false }
      : stopCycle(selected);
  }

  if (key === 'j' || key === `${ESC}B`) {
    state.selected = Math.min(programs.length - 1, state.selected + 1);
    return { message: '', redraw: true };
  }
  if (key === 'k' || key === `${ESC}A`) {
    state.selected = Math.max(0, state.selected - 1);
    return { message: '', redraw: true };
  }
  if (key === 'r') return { message: 'refreshed', redraw: true };
  if (key === 'm') return cycleMode(control, settings.mode);
  if (key === 'p') return cyclePause(control, settings.pauseUntil);
  if (key === 'P') return extendPause(control, settings.pauseUntil);
  if (key === '+' || key === '=') return adjustConcurrency(control, 1);
  if (key === '-' || key === '_') return adjustConcurrency(control, -1);
  if (key === 't') return runTickNow();

  if (selected === undefined) return { message: 'no programs configured', redraw: false };
  if (key === ' ' || key === 'e') return toggleEnabled(control, selected.name);
  if (key === '[') return nudgePriority(control, selected.name, -1);
  if (key === ']') return nudgePriority(control, selected.name, 1);
  if (key === 'x') {
    state.confirmStop = true;
    const verb = selected.runner === 'herdr' ? 'interrupt' : 'stop';
    return { message: `${verb} ${selected.name}? y to confirm, any other key to cancel`, redraw: true };
  }
  return { message: '', redraw: false };
};

/** Runs until interrupted; the terminal is restored on every exit path. */
export const watch = async (intervalSeconds: number): Promise<void> => {
  const state: State = { selected: 0, message: '', confirmStop: false };

  const restore = (): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(`${ESC}?25h`);
  };
  const leave = (): never => {
    restore();
    process.stdout.write('\n');
    process.exit(0);
  };
  const die = (error: unknown): never => {
    restore();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  };

  const draw = async (): Promise<void> => {
    process.stdout.write(`${ESC}2J${ESC}H${await frame(state)}\n`);
  };

  process.stdout.write(`${ESC}?25l`);
  process.on('SIGINT', leave);
  process.on('uncaughtException', die);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      if (chunk === CTRL_C || chunk === 'q') leave();
      try {
        const control = readControl(paths().control);
        const programs = byPriority(control.programs, Date.now(), control.deadlineHorizonDays);
        handle(chunk, state, programs)
          .then((action) => {
            state.message = action.message;
            if (action.redraw) draw().catch(die);
          })
          .catch(die);
      } catch (error) {
        state.message = error instanceof Error ? error.message : String(error);
        draw().catch(die);
      }
    });
  }

  await draw();
  // The interval itself keeps the event loop alive; unref-ing it would exit at once.
  setInterval(() => {
    draw().catch(die);
  }, Math.max(2, intervalSeconds) * 1000);
};
