import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Allocation, type BucketName } from './allocation.ts';
import { byPriority, readControl, type Program } from './control.ts';
import { interruptAgent } from './herdr.ts';
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
import { holder } from './lock.ts';
import { paths } from './paths.ts';
import { agentNameFor, collectState, type DrovrState, type ProgramState } from './state.ts';

const ESC = '\x1b[';
const CTRL_C = '\x03';

const dim = (text: string): string => `${ESC}2m${text}${ESC}0m`;
const bold = (text: string): string => `${ESC}1m${text}${ESC}0m`;
const paint = (code: number, text: string): string => `${ESC}${code}m${text}${ESC}0m`;
const invert = (text: string): string => `${ESC}7m${text}${ESC}0m`;

/** OSC 8 hyperlink: clickable in Ghostty and friends, plain text everywhere else. */
const osc8 = (url: string, text: string): string =>
  `\x1b]8;;${url}\x1b\\${paint(36, text)}\x1b]8;;\x1b\\`;

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

/** View-only concerns: never persisted, never fetched — the opposite of DrovrState. */
type ViewState = { selected: number; message: string; confirmStop: boolean; help: boolean };

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

const allocationLines = (input: {
  allocation: Record<BucketName, Allocation>;
  usableAccounts: number;
  hoursToWeeklyReset: number | null;
  barWidth: number;
  narrow: boolean;
}): string[] => {
  const { allocation, usableAccounts, hoursToWeeklyReset, barWidth, narrow } = input;
  const rows = BUCKETS.map((bucket) => {
    const alloc = allocation[bucket.name];
    const yours = alloc.yoursSpent + alloc.yoursReserved;
    return (
      `  ${(narrow ? bucket.short : bucket.label).padEnd(narrow ? 4 : 11)}${bar(alloc, barWidth)} ` +
      `${dim(`you ${percent(yours, alloc.total).padStart(4)}`)}`
    );
  });

  const resetIn = hoursToWeeklyReset === null ? '—' : `${Math.floor(hoursToWeeklyReset)}h`;
  return [
    '',
    `  ${bold('ALLOCATION')}  ${dim(`${usableAccounts} accounts · weekly resets in ${resetIn}`)}`,
    `  ${SEGMENTS.map((s) => `${paint(s.colour, s.char)} ${dim(s.label)}`).join('  ')}`,
    '',
    ...rows,
  ];
};

const programLines = (input: {
  programs: ProgramState[];
  now: number;
  selected: number;
  narrow: boolean;
}): string[] => {
  const { programs, now, selected, narrow } = input;
  const nameWidth = Math.max(8, ...programs.map((program) => program.name.length)) + 6;

  return programs.map((program, index) => {
    const live = program.startedAt !== null;
    const detail = live
      ? `pid ${program.pid ?? '?'} · ${elapsed(program.startedAt as string, now)} · ${program.kind ?? '?'}`
      : program.reason;
    const label = `${program.name}${program.enabled ? '' : ' (off)'}`.padEnd(nameWidth);
    const isSelected = index === selected;

    const row =
      ` ${isSelected ? paint(36, '▸') : ' '}${dim(`p${String(program.priority).padStart(2)}`)} ` +
      `${isSelected ? invert(label) : label} ` +
      `${paint(VERDICT_COLOUR[program.verdict] ?? 37, program.verdict.padEnd(4))}${narrow ? '' : `  ${dim(detail)}`}`;

    const askLine =
      program.asksUrl === null
        ? []
        : [
            `${' '.repeat(6)}${osc8(
              program.asksUrl,
              narrow ? 'asks ›' : program.asksUrl.replace(/^https:\/\//, ''),
            )}`,
          ];
    // On a phone the reason never fits beside the row, so give it its own line.
    const reasonLine = narrow ? [`${' '.repeat(6)}${dim(detail)}`] : [];
    return [row, ...reasonLine, ...askLine].join('\n');
  });
};

/**
 * DrovrState.service deliberately carries only loaded/intervalSeconds/lastTickAt/overdue —
 * enough to draw the same picture as decide(), not launchd's raw exit-status detail.
 * A richer message would need fields the shared state does not (and should not) carry.
 */
const serviceLine = (service: DrovrState['service'], now: number): string => {
  if (!service.loaded) {
    return 'launchd agent is not loaded, so no tick will fire. Fix: drovr service install';
  }
  if (service.lastTickAt === null) {
    const every = service.intervalSeconds === null ? '' : ` (fires every ${service.intervalSeconds}s)`;
    return `loaded${every}, but no tick has recorded a decision yet`;
  }
  const minutes = Math.max(0, Math.round((now - Date.parse(service.lastTickAt)) / 60_000));
  const ago = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m ago`;
  const overdue = service.overdue ? ' — overdue, the agent may be stalled' : '';
  return `loaded. Last tick recorded a decision ${ago}${overdue}`;
};

/**
 * Pure: every value comes from `state`, never from the clock or the filesystem. This is
 * what guarantees the TUI and the web panel can never show different verdicts — they are
 * two renderers over the one DrovrState collectState() produces.
 */
export const frame = (state: DrovrState, view: ViewState): string => {
  if (view.help) return helpLines().join('\n');

  const now = Date.parse(state.generatedAt);
  const width = Math.max(24, Math.min(process.stdout.columns ?? 100, 120));
  const narrow = width < 72;

  const held =
    state.pauseUntil !== null && Date.parse(state.pauseUntil) > now
      ? paint(33, ` paused until ${state.pauseUntil.slice(11, 16)}`)
      : '';

  const healthy = state.service.loaded && !state.service.overdue;

  const lines = [
    `${bold('drovr')}  ${dim(`mode ${state.mode}`)}${held}  ` +
      dim(new Date(now).toTimeString().slice(0, 8)),
    `  ${paint(healthy ? 32 : 31, '●')} ${dim(serviceLine(state.service, now))}`,
  ];

  lines.push(
    ...(state.mode === 'off'
      ? ['', paint(31, '  mode is off — press m to cycle modes')]
      : allocationLines({
          allocation: state.allocation,
          usableAccounts: state.pool.usableAccounts,
          hoursToWeeklyReset: state.hoursToWeeklyReset,
          barWidth: Math.max(8, width - (narrow ? 16 : 28)),
          narrow,
        })),
  );

  const running = state.programs.filter((program) => program.verdict === 'RUN').length;
  lines.push(
    '',
    `  ${bold('PROGRAMS')}  ${dim(`${running}/${state.maxConcurrentCycles} in flight`)}`,
    ...programLines({ programs: state.programs, now, selected: view.selected, narrow }),
  );

  const recent = state.recentCycles.slice(0, 5);
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

  lines.push('', view.message === '' ? '  ' : paint(36, `  ${view.message}`));
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
      // agentNameFor matches the truncated, lowercased name herdr actually registered
      // (herdr.ts:startCycleAgent) — a name built any other way silently misses.
      await interruptAgent(agentNameFor(program.name));
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

const handle = async (
  key: string,
  view: ViewState,
  programs: Program[],
  state: DrovrState | null,
): Promise<Action> => {
  const control = paths().control;
  const selected = programs[view.selected];
  const settings = readControl(control);

  if (view.confirmStop) {
    view.confirmStop = false;
    if (key !== 'y') return { message: 'stop cancelled', redraw: true };
    return selected === undefined
      ? { message: 'no program selected', redraw: false }
      : stopCycle(selected);
  }

  if (key === 'j' || key === `${ESC}B`) {
    view.selected = Math.min(programs.length - 1, view.selected + 1);
    return { message: '', redraw: true };
  }
  if (key === 'k' || key === `${ESC}A`) {
    view.selected = Math.max(0, view.selected - 1);
    return { message: '', redraw: true };
  }
  if (key === '?' || (view.help && key === '\x1b')) {
    view.help = !view.help;
    return { message: '', redraw: true };
  }
  if (view.help) return { message: '', redraw: false };
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
    const url = state?.programs.find((program) => program.name === selected.name)?.asksUrl ?? null;
    if (url === null) return { message: `${selected.name} has no asks page configured`, redraw: false };
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return { message: `opened ${url}`, redraw: true };
  }
  if (key === ' ' || key === 'e') return toggleEnabled(control, selected.name);
  if (key === '[') return nudgePriority(control, selected.name, -1);
  if (key === ']') return nudgePriority(control, selected.name, 1);
  if (key === 'x') {
    view.confirmStop = true;
    const verb = selected.runner === 'herdr' ? 'interrupt' : 'stop';
    return { message: `${verb} ${selected.name}? y to confirm, any other key to cancel`, redraw: true };
  }
  return { message: '', redraw: false };
};

/**
 * console.error during collectState() (readPreview's best-effort failure path) would
 * otherwise land mid-frame on the alternate screen, scrolling it and polluting the
 * shell's real scrollback once the screen is left. Captured for the duration of the
 * call and restored on every exit, including rejection — the message becomes the
 * frame's own status line instead of an unsolicited terminal write.
 */
const collectStateQuietly = async (): Promise<{ state: DrovrState; warning: string | null }> => {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]): void => {
    // The status line is one row; execFile's own error messages append the child's raw
    // stdout after a newline, and that tail must not blow up the frame into extra rows.
    const [firstLine] = args.map((arg) => String(arg)).join(' ').split('\n');
    messages.push(firstLine ?? '');
  };
  try {
    const state = await collectState();
    return { state, warning: messages.at(-1) ?? null };
  } finally {
    console.error = original;
  }
};

/** Runs until interrupted; the terminal is restored on every exit path. */
export const watch = async (intervalSeconds: number): Promise<void> => {
  const view: ViewState = { selected: 0, message: '', confirmStop: false, help: false };
  let lastState: DrovrState | null = null;

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
    const { state, warning } = await collectStateQuietly();
    lastState = state;
    if (warning !== null) view.message = warning;
    const lines = frame(state, view).split('\n').slice(0, rows - 1);
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
        handle(chunk, view, programs, lastState)
          .then((action) => {
            view.message = action.message;
            if (action.redraw) draw().catch(die);
          })
          .catch(die);
      } catch (error) {
        view.message = error instanceof Error ? error.message : String(error);
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
