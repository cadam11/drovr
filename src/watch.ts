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
  setReserve,
  toggleEnabled,
  type Action,
} from './keys.ts';
import { aiceBaseUrl, interruptAgent } from './herdr.ts';
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

/** OSC 8 hyperlink: clickable in Ghostty and friends, plain text everywhere else. */
const osc8 = (url: string, text: string): string =>
  `\x1b]8;;${url}\x1b\\${paint(36, text)}\x1b]8;;\x1b\\`;

// Resolved once per process by herdr.aiceBaseUrl; a frame must not shell out per program.
const asksLinks = new Map<string, string>();

const asksUrl = (program: Program): string | null => asksLinks.get(program.name) ?? null;

/** Escape sequences occupy no columns, so width has to be measured without them. */
export const visibleLength = (text: string): number =>
  text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

/** Clip to the terminal width so nothing soft-wraps and pushes the frame around. */
export const clip = (text: string, width: number): string => {
  if (visibleLength(text) <= width) return text;
  let out = '';
  let shown = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\x1b') {
      const end = text.indexOf('m', index);
      const stop = end === -1 ? text.length : end;
      out += text.slice(index, stop + 1);
      index = stop;
      continue;
    }
    if (shown >= width - 1) break;
    out += text[index];
    shown += 1;
  }
  return `${out}${ESC}0m…`;
};

const VERDICT_COLOUR: Record<string, number> = { GO: 32, WAIT: 33, STOP: 31, RUN: 36 };

const SEGMENTS: { key: keyof Allocation; char: string; colour: number; label: string }[] = [
  { key: 'yoursSpent', char: '▓', colour: 35, label: 'you spent' },
  { key: 'programsSpent', char: '█', colour: 32, label: 'programs spent' },
  { key: 'programsReserved', char: '▒', colour: 36, label: 'in flight' },
  { key: 'programsAvailable', char: '░', colour: 90, label: 'free to programs' },
  { key: 'yoursReserved', char: '·', colour: 35, label: 'held for you' },
];

const BUCKETS: { name: BucketName; label: string; short: string }[] = [
  { name: 'fable', label: 'fable   7d', short: 'fab' },
  { name: 'general', label: 'general 7d', short: 'gen' },
  { name: 'session', label: 'session 5h', short: '5h' },
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

const KEYS = [
  'j/k select',
  'space enable',
  '[ ] priority',
  'm mode',
  'p pause',
  '+/- cap',
  '< > reserve',
  'r refresh',
  't tick',
  'o asks',
  'x interrupt',
  '? help',
  'q quit',
];

/** Wrapped rather than clipped: a key you cannot see is a key you do not have. */
export const keybarLines = (width: number, narrow: boolean): string[] => {
  const keys = narrow ? KEYS.map((key) => key.split(' ')[0]!) : KEYS;
  const rows: string[][] = [[]];
  let used = 0;

  for (const key of keys) {
    const cost = key.length + 3;
    if (used + cost > width - 4 && rows[rows.length - 1]!.length > 0) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(key);
    used += cost;
  }
  return rows.map((row) => `  ${row.join(dim(' · '))}`);
};

type State = { selected: number; message: string; confirmStop: boolean; help: boolean };

/** Explains what the view means, not only which key does what — modes especially. */
const helpLines = (): string[] => [
  `  ${bold('drovr watch')}`,
  '',
  `  ${bold('Mode')} — how much of each account's weekly quota programs may spend.`,
  '  Whatever is left is held for you, no matter what they do.',
  `    ${paint(31, 'off')}     nothing runs`,
  `    ${paint(33, 'low')}     programs 25%, you keep 75%`,
  `    ${paint(32, 'normal')}  programs 55%, you keep 45%`,
  `    ${paint(36, 'away')}    programs 85%, you keep 15% — for when you are gone`,
  `  ${dim('< and > adjust the current mode by 5%.')}`,
  '',
  `  ${bold('Verdicts')}`,
  `    ${paint(32, 'GO')}    starts on the next tick`,
  `    ${paint(36, 'RUN')}   running now — open its tab to read or talk to it`,
  `    ${paint(33, 'WAIT')}  transient; it retries by itself`,
  `    ${paint(31, 'STOP')}  needs you — the reason says what`,
  '',
  `  ${bold('Bars')} — one per quota bucket, each summing to the whole pool.`,
  ...SEGMENTS.map((segment) => `    ${paint(segment.colour, segment.char)} ${segment.label}`),
  `  ${dim('fable = the runner; general = subagents it spawns; 5h = the burst window.')}`,
  `  ${dim('All three bind at once; the tightest decides.')}`,
  '',
  `  ${bold('Keys')}`,
  '    j k    select            space  enable/disable',
  '    [ ]    priority          o      open asks page',
  '    m      mode              < >    your reserve',
  '    p P    pause / extend    + -    concurrency cap',
  '    t      tick now          r      redraw',
  '    x      interrupt cycle   q      quit',
  '',
  `  ${dim('? or esc closes this')}`,
];

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
  narrow: boolean;
}): string[] => {
  const { status, cycles, ceilings, now, barWidth, narrow } = input;
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
      `  ${(narrow ? bucket.short : bucket.label).padEnd(narrow ? 4 : 11)}${bar(allocation, barWidth)} ` +
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
  narrow: boolean;
}): string[] => {
  const { programs, status, control, cycles, now, state, narrow } = input;
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

    const row =
      ` ${selected ? paint(36, '▸') : ' '}${dim(`p${String(priority).padStart(2)}`)} ` +
      `${selected ? invert(label) : label} ` +
      `${paint(VERDICT_COLOUR[verdict] ?? 37, verdict.padEnd(4))}${narrow ? '' : `  ${dim(detail)}`}`;

    const asks = asksUrl(program);
    const askLine = asks === null ? [] : [`${' '.repeat(6)}${osc8(asks, narrow ? 'asks ›' : asks.replace(/^https:\/\//, ''))}`];
    // On a phone the reason never fits beside the row, so give it its own line.
    const reasonLine = narrow ? [`${' '.repeat(6)}${dim(detail)}`] : [];
    return [row, ...reasonLine, ...askLine].join('\n');
  });
};

const frame = async (state: State): Promise<string> => {
  if (state.help) return helpLines().join('\n');
  const p = paths();
  const status = await readStatus();
  const control = readControl(p.control);
  const cycles = readCycles(p.cycles);
  const now = Date.now();
  const width = Math.max(24, Math.min(process.stdout.columns ?? 100, 120));
  const narrow = width < 72;
  const ceilings = ceilingsFor(control);
  const programs = byPriority(control.programs, now, control.deadlineHorizonDays);
  await Promise.all(
    programs.map(async (program) => {
      if (program.aice?.asksPage == null || asksLinks.has(program.name)) return;
      const base = await aiceBaseUrl(program);
      if (base !== null) asksLinks.set(program.name, `${base}/${program.aice.asksPage}`);
    }),
  );
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
      : allocationLines({
          status,
          cycles,
          ceilings,
          now,
          barWidth: Math.max(8, width - (narrow ? 16 : 28)),
          narrow,
        })),
  );

  lines.push(
    '',
    `  ${bold('PROGRAMS')}  ${dim(`${running.length}/${control.maxConcurrentCycles} in flight`)}`,
    ...programLines({ programs, status, control, cycles, now, state, narrow }),
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

  lines.push('', state.message === '' ? '  ' : paint(36, `  ${state.message}`));
  lines.push(...keybarLines(width, narrow));
  // Clip last: any single over-long line would soft-wrap and shove the frame upward.
  return lines.flatMap((line) => line.split('\n')).map((line) => clip(line, width)).join('\n');
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
  if (key === '?' || (state.help && key === '\x1b')) {
    state.help = !state.help;
    return { message: '', redraw: true };
  }
  if (state.help) return { message: '', redraw: false };
  if (key === 'r') return { message: 'refreshed', redraw: true };
  if (key === 'm') return cycleMode(control, settings.mode);
  if (key === 'p') return cyclePause(control, settings.pauseUntil);
  if (key === 'P') return extendPause(control, settings.pauseUntil);
  if (key === '<' || key === ',') {
    const weekly = settings.ceilings[settings.mode]?.weekly ?? 0.55;
    return setReserve(control, settings.mode, 1 - weekly - 0.05);
  }
  if (key === '>' || key === '.') {
    const weekly = settings.ceilings[settings.mode]?.weekly ?? 0.55;
    return setReserve(control, settings.mode, 1 - weekly + 0.05);
  }
  if (key === '+' || key === '=') return adjustConcurrency(control, 1);
  if (key === '-' || key === '_') return adjustConcurrency(control, -1);
  if (key === 't') return runTickNow();

  if (selected === undefined) return { message: 'no programs configured', redraw: false };
  if (key === 'o') {
    const url = asksUrl(selected);
    if (url === null) return { message: `${selected.name} has no asks page configured`, redraw: false };
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return { message: `opened ${url}`, redraw: true };
  }
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
  const state: State = { selected: 0, message: '', confirmStop: false, help: false };

  const restore = (): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    // Leave the alternate screen last, so the shell's own scrollback comes back intact.
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  };
  const leave = (): never => {
    restore();
    process.exit(0);
  };
  const die = (error: unknown): never => {
    restore();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  };

  /**
   * Home the cursor and clear each line as it is written, rather than clearing the
   * whole screen first: a full clear flickers, and a trailing newline on a frame that
   * fills the terminal scrolls the top away one row per redraw. Content is clamped to
   * the terminal height so it can never scroll at all.
   */
  const draw = async (): Promise<void> => {
    const rows = Math.max(6, process.stdout.rows ?? 40);
    const lines = (await frame(state)).split('\n').slice(0, rows - 1);
    const painted = lines.map((line) => `${line}${ESC}K`).join('\r\n');
    process.stdout.write(`${ESC}H${painted}${ESC}0J`);
  };

  // The alternate screen is what keeps frames out of the shell's scrollback.
  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  process.on('SIGINT', leave);
  process.on('uncaughtException', die);
  process.stdout.on('resize', () => {
    draw().catch(die);
  });

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
