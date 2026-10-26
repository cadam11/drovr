import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { type Allocation, type BucketName } from './allocation.ts';
import { byPriority, readControl, type Program } from './control.ts';
import { interruptRunner, releaseLeftover as releaseIfSafe } from './orca.ts';
import { lastCycleReported, readCycles } from './ledger.ts';
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
import { record } from './record.ts';
import { collectState, type DrovrState, type ProgramState } from './state.ts';

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
const visibleLengthUnrecorded = (text: string): number =>
  text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;

/**
 * Bounded word wrap, for text that must not lose its tail. A WAIT reason can run past 200
 * characters — a coupling explanation naming which bucket pins which accounts, or a crash
 * latch carrying a log path and the command that retries it — and clipping one to a program
 * row drops exactly the half that says what to do about it.
 *
 * `maxLines` is a hard cap rather than "however many it takes": the frame is sliced to
 * `stdout.rows - 1`, so lines spent here come off the bottom, and the bottom is the keybar.
 * The final line absorbs whatever is left and is clipped by the caller like any other.
 */
const wrapTextUnrecorded = (text: string, width: number, maxLines: number): string[] => {
  if (width < 1 || maxLines < 1) throw new Error(`wrapText needs width>=1 and maxLines>=1, got ${width}/${maxLines}`);
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width && lines.length < maxLines - 1) {
    const space = rest.lastIndexOf(' ', width);
    const at = space > 0 ? space : width;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  lines.push(rest);
  return lines;
};

/** Clip to the terminal width so nothing soft-wraps and pushes the frame around. */
const clipUnrecorded = (text: string, width: number): string => {
  if (visibleLengthUnrecorded(text) <= width) return text;
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

/** Time until a reset, in teamclaude's own dashboard vocabulary: 59m, 4h49m, 2d18h. */
const untilLabelUnrecorded = (at: string | null, now: number): string => {
  if (at === null) return '—';
  const minutes = Math.round((Date.parse(at) - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
};

/**
 * `key` is what a mouse click on the label feeds back in as a keystroke. Null for the
 * entries a click cannot disambiguate ('[ ]' is two opposite actions) — and for the
 * selection keys, where the mouse has its own affordances: click a row, or scroll.
 */
const KEYS: { label: string; key: string | null }[] = [
  { label: 'j/k select', key: null },
  { label: 'space enable', key: ' ' },
  { label: '[ ] priority', key: null },
  { label: 'm mode', key: 'm' },
  { label: 'p pause', key: 'p' },
  { label: '+/- cap', key: null },
  { label: '< > reserve', key: null },
  { label: 'r refresh', key: 'r' },
  { label: 't tick', key: 't' },
  { label: 'o asks', key: 'o' },
  { label: 's start', key: 's' },
  { label: 'x interrupt', key: 'x' },
  { label: 'l release', key: 'l' },
  { label: '? help', key: '?' },
  { label: 'q quit', key: 'q' },
];

type KeybarEntry = { shown: string; key: string | null; start: number; end: number };

/**
 * One layout, two readers: keybarLines renders it and keybarKeyAt hit-tests it, so a
 * click can never land on a different key than the one drawn there. Columns count only
 * visible characters — the ' · ' separators are three columns however they are painted.
 */
const keybarLayout = (width: number, narrow: boolean): KeybarEntry[][] => {
  const rows: KeybarEntry[][] = [[]];
  let used = 0;

  for (const { label, key } of KEYS) {
    const shown = narrow ? label.split(' ')[0]! : label;
    const cost = shown.length + 3;
    if (used + cost > width - 4 && rows[rows.length - 1]!.length > 0) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push({ shown, key, start: 2 + used, end: 2 + used + shown.length });
    used += cost;
  }
  return rows;
};

/** Wrapped rather than clipped: a key you cannot see is a key you do not have. */
const keybarLinesUnrecorded = (width: number, narrow: boolean): string[] =>
  keybarLayout(width, narrow).map(
    (row) => `  ${row.map((entry) => entry.shown).join(dim(' · '))}`,
  );

/** The keystroke a click at this keybar row and column stands for, if any. */
export const keybarKeyAt = (
  width: number,
  narrow: boolean,
  row: number,
  column: number,
): string | null => {
  const entries = keybarLayout(width, narrow)[row] ?? [];
  const key = entries.find((entry) => column >= entry.start && column < entry.end)?.key ?? null;
  return record('watch.keybarKeyAt', { width, narrow, row, column }, key);
};

/**
 * View-only concerns: never persisted, never fetched — the opposite of DrovrState.
 * `previewWarning` is optional so a caller that never drives the preview-reading
 * path (every existing test) can omit it entirely; `watch()` always supplies it.
 */
type ViewState = {
  selected: number;
  message: string;
  confirmStop: boolean;
  confirmStart: boolean;
  help: boolean;
  previewWarning?: string | null;
};

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
  '    x      interrupt cycle   l      release a finished runner',
  '    q      quit',
  `  ${dim('Mouse: click a program to select it, its asks link to open it, a key below to run it.')}`,
  '',
  // A documented floor, because the frame degrades quietly below it rather than
  // refusing: bars shrink, labels shorten, and under 24 columns rows start clipping.
  // The keys and the interrupt confirmation survive to 24 rows by construction.
  // Kept under 78 visible columns so it never soft-wraps the help screen itself.
  `  ${dim('Sized for 80×24+. Narrower shortens labels and bars; keys always show.')}`,
  '',
  `  ${dim('? or esc closes this')}`,
];

const allocationLines = (input: {
  allocation: Record<BucketName, Allocation>;
  usableAccounts: number;
  fundingAccounts: number;
  hoursToWeeklyReset: number | null;
  bindingBucket: BucketName;
  barWidth: number;
  narrow: boolean;
}): string[] => {
  const { allocation, usableAccounts, fundingAccounts, hoursToWeeklyReset, bindingBucket, barWidth, narrow } = input;
  const rows = BUCKETS.map((bucket) => {
    const alloc = allocation[bucket.name];
    const yours = alloc.yoursSpent + alloc.yoursReserved;
    // decide()/CLAUDE.md: the three buckets are not a hierarchy, and only one of
    // them is the reason admission is what it is. Marking it is the only way the
    // TUI and the panel (which prints bindingBucket directly) can be checked
    // against each other instead of both just listing three numbers.
    const binds = bucket.name === bindingBucket ? paint(31, ' binds') : '';
    return (
      `  ${(narrow ? bucket.short : bucket.label).padEnd(narrow ? 4 : 11)}${bar(alloc, barWidth)} ` +
      `${dim(`you ${percent(yours, alloc.total).padStart(4)}`)}${binds}`
    );
  });

  const resetIn = hoursToWeeklyReset === null ? '—' : `${Math.floor(hoursToWeeklyReset)}h`;
  return [
    '',
    `  ${bold('ALLOCATION')}  ${dim(`${accountsLabelUnrecorded(fundingAccounts, usableAccounts)} · weekly resets in ${resetIn}`)}`,
    `  ${SEGMENTS.map((s) => `${paint(s.colour, s.char)} ${dim(s.label)}`).join('  ')}`,
    '',
    ...rows,
  ];
};

const ACCOUNT_BUCKETS: { key: 'session' | 'general' | 'fable'; label: string }[] = [
  { key: 'session', label: '5h' },
  { key: 'general', label: 'wk' },
  { key: 'fable', label: 'F7' },
];

/** A used-fraction bar, coloured by how close the bucket is to its limit. */
const usedBar = (fraction: number | null, width: number): string => {
  if (fraction === null) return dim('?'.repeat(width));
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  const colour = clamped >= 0.8 ? 31 : clamped >= 0.5 ? 33 : 32;
  return paint(colour, '█'.repeat(filled)) + paint(90, '░'.repeat(width - filled));
};

/**
 * teamclaude's own dashboard, folded in so drovr watch is the one screen: every account,
 * its three buckets with their own reset countdowns, and the account the fable route will
 * serve next (►) — the one the runner's next request actually lands on. ✗ marks an account
 * the route refuses: its headroom shows in the bars above but funds nothing (capacity.ts).
 */
const accountLines = (input: {
  accounts: DrovrState['accounts'];
  now: number;
  width: number;
  narrow: boolean;
}): string[] => {
  const { accounts, now, width, narrow } = input;
  if (accounts.length === 0) return [];
  const nameWidth = narrow ? 14 : Math.min(28, Math.max(...accounts.map((entry) => entry.name.length)));
  const statusWidth = narrow ? 0 : 9;
  // Indent, marker, name, status, and per bucket: label, bar, a six-wide countdown, gaps.
  const fixed = 4 + nameWidth + 1 + statusWidth + ACCOUNT_BUCKETS.length * 11;
  const barWidth = Math.max(3, Math.floor((width - fixed) / ACCOUNT_BUCKETS.length));

  const target = accounts.find((entry) => entry.fableTarget);
  const header =
    `  ${bold('ACCOUNTS')}  ` +
    dim(target === undefined ? 'fable route has no target' : `fable route → ${target.name}`);

  const rows = accounts.map((entry) => {
    const marker = entry.fableTarget ? paint(32, '►') : entry.fableEligible === false ? paint(31, '✗') : ' ';
    const name = clipUnrecorded(narrow ? entry.name.split('@')[0]! : entry.name, nameWidth).padEnd(nameWidth);
    const status = narrow
      ? ''
      : entry.disabled
        ? dim('disabled'.padEnd(statusWidth))
        : paint(entry.status === 'active' ? 32 : 33, (entry.status ?? '?').padEnd(statusWidth));
    const buckets = ACCOUNT_BUCKETS.map(({ key, label }) => {
      const bucket = entry.buckets[key];
      return `${dim(label)} ${usedBar(bucket.usedFraction, barWidth)} ${untilLabelUnrecorded(bucket.resetsAt, now).padEnd(6)}`;
    }).join(' ');
    return `  ${marker} ${name} ${status}${buckets}`;
  });
  return ['', header, ...rows];
};

/**
 * "3 accounts" beside three near-empty bars reads as a healthy pool. It is not the
 * same statement as "3 accounts can fund a cycle", and on 2026-08-25 the difference
 * was two spent accounts and one carrying everything. Say both numbers when they differ.
 */
const accountsLabelUnrecorded = (funding: number, usable: number): string =>
  funding === usable ? `${usable} accounts` : `${funding} of ${usable} accounts funding`;

const DETAIL_INDENT = 6;

/**
 * How many characters of a reason must survive, whatever the window. Fixed at two
 * lines, a 60-column terminal carried 108 characters and silently dropped the coupling
 * note off the end while a 100-column one kept the whole sentence — the same reason
 * telling two different stories depending on the window, which is exactly the failure
 * `allocation.ts`'s trap is about. Capped at four lines so a long reason can never eat
 * the whole body; the tail is reserved separately in `frame`, so these no longer cost
 * the keybar.
 */
const REASON_BUDGET = 200;
const detailLinesFor = (width: number): number =>
  Math.min(4, Math.max(2, Math.ceil(REASON_BUDGET / Math.max(8, width - DETAIL_INDENT))));

/**
 * `ask` is separate from `text` so the frame can tag it as its own click target: with
 * mouse reporting on, the terminal no longer opens OSC 8 links on a plain click — the
 * click comes to drovr instead — so drovr has to do the opening itself.
 */
const programLines = (input: {
  programs: ProgramState[];
  now: number;
  selected: number;
  narrow: boolean;
  width: number;
}): { text: string; ask: string | null }[] => {
  const { programs, now, selected, narrow, width } = input;
  const nameWidth = Math.max(8, ...programs.map((program) => program.name.length)) + 6;

  return programs.map((program, index) => {
    const startedAt = program.startedAt;
    const detail = startedAt === null
      ? program.reason
      : `pid ${program.pid ?? '?'} · ${elapsed(startedAt, now)} · ${program.kind ?? '?'}`;
    const label = `${program.name}${program.enabled ? '' : ' (off)'}`.padEnd(nameWidth);
    const isSelected = index === selected;

    const head =
      ` ${isSelected ? paint(36, '▸') : ' '}${dim(`p${String(program.priority).padStart(2)}`)} ` +
      `${isSelected ? invert(label) : label} ` +
      `${paint(VERDICT_COLOUR[program.verdict] ?? 37, program.verdict.padEnd(4))}`;

    // Beside the row only while it fits whole. A reason clipped to the row loses its tail,
    // and the tail is where a long one keeps the coupling explanation or the retry command.
    const inline = !narrow && visibleLengthUnrecorded(head) + 2 + detail.length <= width;
    const row = inline ? `${head}  ${dim(detail)}` : head;
    const detailLines = inline
      ? []
      : wrapTextUnrecorded(detail, Math.max(8, width - DETAIL_INDENT), detailLinesFor(width))
          .map((line) => `${' '.repeat(DETAIL_INDENT)}${dim(line)}`);

    const ask =
      program.asksUrl === null
        ? null
        : `${' '.repeat(DETAIL_INDENT)}${osc8(
            program.asksUrl,
            narrow ? 'asks ›' : program.asksUrl.replace(/^https:\/\//, ''),
          )}`;
    return { text: [row, ...detailLines].join('\n'), ask };
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
 * What a rendered line stands for under the mouse: a program row (and its wrapped
 * detail lines), or a keybar row whose columns keybarKeyAt resolves. Null is dead space.
 */
export type LineHit = { program: number } | { asks: number } | { keybar: number };

type Tagged = { text: string; hit: LineHit | null };

const plain = (text: string): Tagged => ({ text, hit: null });

/**
 * Shared by every frame the view can draw — the normal body-plus-tail frame and the
 * help overlay alike — so a rows budget or a width clip added to one can never be
 * forgotten on the other. `foot` is reserved first because it is the part a viewer
 * must always be able to see (keybar, confirmation prompt); `body` is what gives way.
 *
 * Program rows carry embedded newlines, so both halves are flattened before either is
 * measured — counting entries rather than rendered lines would under-reserve. Hits are
 * carried through the same flatten-and-slice, which is what keeps a click aligned with
 * what is actually on screen after the clamp rather than with what was rendered.
 */
const clampAndClip = (
  body: Tagged[],
  foot: Tagged[],
  width: number,
  rows?: number,
): { text: string; hits: (LineHit | null)[] } => {
  const split = (source: Tagged[]): Tagged[] =>
    source.flatMap((line) => line.text.split('\n').map((text) => ({ text, hit: line.hit })));
  const flatBody = split(body);
  const flatFoot = split(foot);
  const budget = rows === undefined ? flatBody.length + flatFoot.length : Math.max(1, rows - 1);
  const kept =
    flatFoot.length >= budget
      ? flatFoot.slice(0, budget)
      : [...flatBody.slice(0, budget - flatFoot.length), ...flatFoot];
  return {
    // Clip last: any single over-long line would soft-wrap and shove the frame upward.
    text: kept.map((line) => clipUnrecorded(line.text, width)).join('\n'),
    hits: kept.map((line) => line.hit),
  };
};

/**
 * Pure when `columns` is supplied, which `draw()` always does: every value then comes
 * from `state` and `view`, never from the clock or the filesystem. This is what
 * guarantees the TUI and the web panel can never show different verdicts — they are
 * two renderers over the one DrovrState collectState() produces. `columns` falls back
 * to reading the terminal width itself only as a convenience for callers — tests,
 * mainly — that do not care which width they get.
 *
 * `rows` is the terminal height. Supplied, the frame is clamped to `rows - 1` here
 * rather than sliced by the caller, because the caller's slice took the bottom off:
 * the message line, the preview warning and the keybar are all appended last. Omitted,
 * the frame is whatever height it needs — only correct for a caller with no viewport.
 */
const frameWithHitsUnrecorded = (
  state: DrovrState,
  view: ViewState,
  columns?: number,
  rows?: number,
): { text: string; hits: (LineHit | null)[] } => {
  const width = Math.max(24, Math.min(columns ?? process.stdout.columns ?? 100, 120));
  // The help screen has no keybar/message tail of its own — it is one long body — but
  // it still needs the same rows clamp and width clip, or it scrolls the alternate
  // screen exactly like an unclamped normal frame would.
  if (view.help) return clampAndClip(helpLines().map(plain), [], width, rows);

  const now = Date.parse(state.generatedAt);
  const narrow = width < 72;

  const held =
    state.pauseUntil !== null && Date.parse(state.pauseUntil) > now
      ? paint(33, ` paused until ${state.pauseUntil.slice(11, 16)}`)
      : '';

  const healthy = state.service.loaded && !state.service.overdue;

  const lines: Tagged[] = [
    plain(
      `${bold('drovr')}  ${dim(`mode ${state.mode}${state.modeFromPhone ? ' (phone)' : ''}`)}${held}  ` +
        dim(new Date(now).toTimeString().slice(0, 8)),
    ),
    plain(`  ${paint(healthy ? 32 : 31, '●')} ${dim(serviceLine(state.service, now))}`),
  ];

  lines.push(
    ...(state.mode === 'off'
      ? ['', paint(31, '  mode is off — press m to cycle modes')]
      : [
          ...allocationLines({
            allocation: state.allocation,
            usableAccounts: state.pool.usableAccounts,
            fundingAccounts: state.pool.fundingAccounts,
            hoursToWeeklyReset: state.hoursToWeeklyReset,
            bindingBucket: state.bindingBucket,
            // Everything the row carries beside the bar: indent, label, the `you NN%`
            // reading, and — the part that was missing — the six columns of ` binds`.
            // Reserving only 16 at narrow widths let clip() eat the marker, so a
            // 60-column frame showed three bars and no indication which one refuses.
            barWidth: Math.max(8, width - (narrow ? 22 : 28)),
            narrow,
          }),
          // The pool context, once. Program reasons no longer carry it (decide.ts's
          // reason/note split), so this line beside the bars is where the coupling
          // warning lives — the bars are exactly what it exists to explain.
          ...wrapTextUnrecorded(state.capacityNote, Math.max(8, width - 4), 3).map(
            (line) => `  ${dim(line)}`,
          ),
          ...accountLines({ accounts: state.accounts, now, width, narrow }),
        ]
    ).map(plain),
  );

  // state.cyclesInFlight (not a count of state.programs with verdict RUN) — a cycle
  // whose program was removed or renamed out of control.json while still running is
  // still counted by decide() and by buildState's own reservation maths, and the
  // header must agree with the capacity picture, not just the program list.
  lines.push(
    plain(''),
    plain(`  ${bold('PROGRAMS')}  ${dim(`${state.cyclesInFlight}/${state.maxConcurrentCycles} in flight`)}`),
    // The row and its wrapped detail lines select the program; the ask link is its own
    // target, because with mouse reporting on the terminal no longer opens it itself.
    ...programLines({ programs: state.programs, now, selected: view.selected, narrow, width })
      .flatMap(({ text, ask }, index): Tagged[] => [
        { text, hit: { program: index } },
        ...(ask === null ? [] : [{ text: ask, hit: { asks: index } }]),
      ]),
  );

  const recent = state.recentCycles.slice(0, 5);
  if (recent.length > 0) {
    lines.push(plain(''), plain(`  ${bold('RECENT')}`));
    lines.push(
      ...recent.map((cycle) =>
        plain(dim(
          `  ${cycle.startedAt.slice(5, 16).replace('T', ' ')}  ${cycle.program.padEnd(10)}` +
            `${cycle.kind.padEnd(11)}${cycle.exit.padEnd(9)}asks=${cycle.asksRaised}`,
        )),
      ),
    );
  }

  // Its own row, never shared with view.message: readPreview's warning and an action
  // message (notably the 'x' interrupt confirmation) can each be live at once, and the
  // confirmation prompt must never be the one that silently disappears.
  //
  // Held out of `lines` and re-attached below rather than pushed onto the end: at
  // Craig's real configuration (3 programs, asks links, recent cycles) the body alone
  // is 34 rows at every width watch draws, so appending these put them past the
  // viewport on any terminal shorter than 35. Pressing `x` then armed view.confirmStop
  // with no visible prompt, and the next keystroke either interrupted a live cycle or
  // silently cancelled — a hidden confirmation on the only destructive key.
  const tail: Tagged[] = [
    plain(''),
    plain(view.message === '' ? '  ' : paint(36, `  ${view.message}`)),
    ...(view.previewWarning == null ? [] : [plain(paint(33, `  ${view.previewWarning}`))]),
    ...keybarLinesUnrecorded(width, narrow).map((text, index) => ({ text, hit: { keybar: index } })),
  ];

  return clampAndClip(lines, tail, width, rows);
};

/** The rendered frame alone — every caller that has no mouse to serve. */
export const frameWithHits = (
  state: DrovrState,
  view: ViewState,
  columns?: number,
  rows?: number,
): { text: string; hits: (LineHit | null)[] } => {
  const out = frameWithHitsUnrecorded(state, view, columns, rows);
  // Without `columns` the width came from process.stdout, so the input would not reproduce the output.
  if (columns === undefined) return out;
  return record('watch.frameWithHits', { state, view, columns, rows }, out);
};

export const frame = (
  state: DrovrState,
  view: ViewState,
  columns?: number,
  rows?: number,
): string => frameWithHits(state, view, columns, rows).text;

const cliPath = (): string => fileURLToPath(new URL('./cli.ts', import.meta.url));

const runTickNow = (): Action => {
  const child = spawn(process.execPath, [cliPath(), 'tick'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { message: 'tick launched', redraw: true };
};

/**
 * The TUI twin of `drovr start`: Craig's explicit override past every admission gate,
 * which is why it arms a y-confirmation first — a stray keypress must not spend a
 * cycle's worth of quota. It answers "I answered the asks, crack on" without waiting
 * out the blocked backoff or the next tick.
 */
const startCycle = (program: Program): Action => {
  const child = spawn(process.execPath, [cliPath(), 'start', program.name], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { message: `${program.name}: cycle launched`, redraw: true };
};

/**
 * An orca cycle is a real session Craig can talk to, so this interrupts it rather
 * than killing it — the runner gets to wind down and write its report. The headless
 * runner has no such affordance, so its process group is signalled instead.
 */
const stopCycle = async (program: Program): Promise<Action> => {
  if (program.runner === 'orca') {
    try {
      await interruptRunner(program.name);
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

/**
 * The tick's release on demand, by `leftoverAction`: an exited runner is closed, an idle
 * one sent `/exit` only once its cycle reported. No y-confirm for that reason. A runner
 * idle with no report may be mid-cycle over background work — relliq was, 2026-10-05 — so
 * a keystroke never ends it; `drovr release` is the typed override. Refused outright while
 * a cycle is in flight, since that runner is the cycle's.
 */
const releaseLeftover = async (program: Program): Promise<Action> => {
  if (program.runner !== 'orca') return { message: `${program.name} runs headless — no runner to release`, redraw: false };
  if (holder(paths().programLock(program.name)) !== null) {
    return { message: `${program.name} has a cycle running — its runner is released when it reports`, redraw: false };
  }
  try {
    const mine = readCycles(paths().cycles).filter((cycle) => cycle.program === program.name);
    if (await releaseIfSafe(program.name, lastCycleReported(mine))) {
      return { message: `released ${program.name}'s runner — the next tick can start a cycle`, redraw: true, fresh: true };
    }
    return {
      message:
        `left ${program.name}'s runner alone — it is busy, its cycle never reported, or it already ` +
        `ignored one /exit. Check its tab; "drovr release ${program.name}" overrides`,
      redraw: false,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { message: `could not release ${program.name}: ${detail}`, redraw: false };
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
  if (view.confirmStart) {
    view.confirmStart = false;
    if (key !== 'y') return { message: 'start cancelled', redraw: true };
    return selected === undefined
      ? { message: 'no program selected', redraw: false }
      : startCycle(selected);
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
  // The one key that bypasses the probe window, because it is the only one whose whole
  // purpose is "go and look again" — every other redraw is happy with probes up to an
  // interval old, which is what makes a keystroke cost nothing.
  if (key === 'r') return { message: 'refreshed', redraw: true, fresh: true };
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
    const verb = selected.runner === 'orca' ? 'interrupt' : 'stop';
    return { message: `${verb} ${selected.name}? y to confirm, any other key to cancel`, redraw: true };
  }
  if (key === 'l') return releaseLeftover(selected);
  if (key === 's') {
    const pid = holder(paths().programLock(selected.name));
    if (pid !== null) {
      return { message: `${selected.name} already has a cycle running (pid ${pid})`, redraw: false };
    }
    view.confirmStart = true;
    return {
      message: `start ${selected.name} now, past every gate? y to confirm, any other key to cancel`,
      redraw: true,
    };
  }
  return { message: '', redraw: false };
};

/**
 * One SGR mouse report: `ESC [ < button ; column ; row (M|m)`. SGR (?1006) rather than
 * the legacy X10 encoding because X10 caps coordinates at byte 223 and emits raw bytes
 * that are indistinguishable from text — SGR is printable, unambiguous, and unbounded.
 */
const MOUSE_EVENTS = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Wheel bursts arrive as one chunk of many reports; more than this many is a flick. */
const MOUSE_EVENTS_PER_CHUNK = 8;

/**
 * The one line of a failed subprocess worth a single row of the frame. execFile leads with
 * its own `Command failed: <argv>` — which only restates the call — while the child's next
 * line is the one that says what went wrong and is worth reading ("Proxy at localhost:3456
 * did not answer status within 5000ms"). Name the problem, not the call that hit it.
 */
const childReasonUnrecorded = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.find((line) => !line.startsWith('Command failed:')) ?? lines[0] ?? 'unknown error';
};

/** Runs until interrupted; the terminal is restored on every exit path. */
export const watch = async (intervalSeconds: number): Promise<void> => {
  const view: ViewState = { selected: 0, message: '', confirmStop: false, confirmStart: false, help: false, previewWarning: null };
  let lastState: DrovrState | null = null;
  // What the mouse is over: the hits of the frame actually on screen, and the width
  // and narrowness it was laid out at — a click resolves against what was drawn, never
  // against a layout recomputed for a terminal that may have resized since.
  let lastHits: (LineHit | null)[] = [];
  let lastWidth = 100;
  let lastNarrow = false;

  const restore = (): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    // Mouse reporting off first — a shell fed SGR reports pastes them as text.
    // Leave the alternate screen last, so the shell's own scrollback comes back intact.
    process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
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
   *
   * Takes the state rather than fetching it, so the one path that has no fresh state to
   * draw — a refresh that threw — can still repaint the last good one with its message.
   */
  const paint = (state: DrovrState): void => {
    const rows = Math.max(6, process.stdout.rows ?? 40);
    const columns = process.stdout.columns ?? 100;
    lastState = state;
    // frame() owns the clamp now, and clamps to the same rows - 1 this used to slice
    // to. Slicing here again would be a second budget to keep in step with the first,
    // and it is the one that dropped the keybar and the interrupt confirmation.
    const { text, hits } = frameWithHits(state, view, columns, rows);
    lastHits = hits;
    lastWidth = Math.max(24, Math.min(columns, 120));
    lastNarrow = lastWidth < 72;
    const painted = text.split('\n').map((line) => `${line}${ESC}K`).join('\r\n');
    process.stdout.write(`${ESC}H${painted}${ESC}0J`);
  };

  /**
   * readPreview's own failures are returned, not logged (orca.ts), specifically so
   * nothing here has to intercept a global to keep them off the alternate screen — the
   * warning is threaded straight into view.previewWarning via this call's own callback,
   * which is fine even with several draws' collectState calls genuinely overlapping:
   * each call closes over its own `view` write, there is no shared collector to leak
   * into or clobber. Reset before the call so a since-fixed preview stops complaining.
   */
  const runDraw = async (fresh: boolean): Promise<void> => {
    view.previewWarning = null;
    // The probes may be as old as one interval: a keystroke redraw then costs no
    // subprocess at all, while the interval's own draw always falls outside the window
    // (it fires an interval after the probe *started*) and refreshes. Everything the
    // frame reads from disk — mode, pause, priorities — is re-read regardless, so a key
    // that writes control.json still shows its effect in the very next frame.
    paint(await collectState((warning) => {
      view.previewWarning = warning;
    }, fresh ? 0 : Math.max(2, intervalSeconds) * 1000));
  };

  /**
   * A failed refresh must not end the session. collectState shells out to teamclaude and
   * orca, and both fail transiently — measured 2026-09-17, teamclaude's proxy missing its
   * own 5s status budget threw out of `readStatus` and took a live watch down with it,
   * which is a supervisor losing its display over someone else's hiccup. Keep the last
   * good frame, say what happened on the message line, and let the next draw recover.
   *
   * Before the first frame there is nothing to keep, so that one is still fatal: a watch
   * that cannot draw at all has nothing to say and no way to say it.
   */
  const drawFailed = (error: unknown): void => {
    if (lastState === null) return die(error);
    view.message = `could not refresh: ${childReason(error)}`;
    paint(lastState);
  };

  // draw() is called fire-and-forget from three independent places (the interval, the
  // stdin handler, resize) with no guarantee the previous call has settled — collectState
  // alone is several subprocess round trips. Chaining onto one promise makes every call
  // wait its turn, so two draws can never paint over each other and a stale one can never
  // land after a fresher one just because its I/O happened to finish later.
  let pending: Promise<void> = Promise.resolve();
  // `fresh` is wrapped rather than passed as `.then(runDraw, runDraw)`: that hands the
  // settled value through, so a rejected predecessor would arrive as a truthy Error and
  // silently force a probe on every draw after the first failure.
  const draw = (fresh = false): Promise<void> => {
    const next = pending.then(() => runDraw(fresh), () => runDraw(fresh));
    pending = next;
    return next;
  };

  // The alternate screen is what keeps frames out of the shell's scrollback.
  // ?1000 reports clicks and wheel, ?1006 makes the reports SGR-encoded (see
  // MOUSE_EVENTS). Terminals that support neither simply never send a report.
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
  process.on('SIGINT', leave);
  process.on('uncaughtException', die);
  process.stdout.on('resize', () => {
    draw().catch(drawFailed);
  });

  const onKey = (key: string): void => {
    if (key === CTRL_C || key === 'q') leave();
    try {
      const control = readControl(paths().control);
      const programs = byPriority(control.programs, Date.now(), control.deadlineHorizonDays);
      handle(key, view, programs, lastState)
        .then((action) => {
          view.message = action.message;
          if (action.redraw) draw(action.fresh === true).catch(drawFailed);
        })
        .catch(die);
    } catch (error) {
      view.message = error instanceof Error ? error.message : String(error);
      draw().catch(drawFailed);
    }
  };

  // An armed confirmation treats any keystroke but 'y' as a cancel; the mouse gets
  // the same semantics, so a stray click can never confirm an interrupt or spend a
  // cycle's worth of quota.
  const selectProgram = (index: number): void => {
    if (view.confirmStop) {
      view.confirmStop = false;
      view.message = 'stop cancelled';
    } else if (view.confirmStart) {
      view.confirmStart = false;
      view.message = 'start cancelled';
    } else {
      const last = (lastState?.programs.length ?? 1) - 1;
      view.selected = Math.max(0, Math.min(last, index));
      view.message = '';
    }
    draw().catch(drawFailed);
  };

  const onMouse = (button: number, column: number, row: number): void => {
    // Bit 6 marks a wheel report: 64 scrolls up, 65 down. Selection, like j/k.
    if ((button & 64) !== 0) {
      selectProgram(view.selected + ((button & 1) === 0 ? -1 : 1));
      return;
    }
    if ((button & 3) !== 0) return; // left button only; right and middle stay free
    const hit = lastHits[row - 1] ?? null;
    if (hit === null) return;
    if ('program' in hit) {
      selectProgram(hit.program);
      return;
    }
    if ('asks' in hit) {
      // The terminal would have opened this link itself before mouse reporting was on;
      // now the click arrives here instead, so select the program and open its page —
      // the same thing 'o' does. An armed confirmation still wins.
      if (view.confirmStop || view.confirmStart) {
        selectProgram(hit.asks);
        return;
      }
      view.selected = hit.asks;
      onKey('o');
      return;
    }
    const key = keybarKeyAt(lastWidth, lastNarrow, hit.keybar, column - 1);
    if (key !== null) onKey(key);
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      // Mouse reports can share a chunk with each other (a wheel flick) and, rarely,
      // with real keystrokes. Handle the reports, then whatever text remains.
      const events = [...chunk.matchAll(MOUSE_EVENTS)];
      if (events.length > 0) {
        for (const event of events.slice(0, MOUSE_EVENTS_PER_CHUNK)) {
          // Press reports only: 'm' is the release of a click already handled.
          if (event[4] === 'M') onMouse(Number(event[1]), Number(event[2]), Number(event[3]));
        }
        const rest = chunk.replace(MOUSE_EVENTS, '');
        if (rest.length > 0) onKey(rest);
        return;
      }
      onKey(chunk);
    });
  }

  // Unhandled here would propagate to main()'s own .catch in cli.ts, which never
  // calls restore() — the cursor would stay hidden and the alt screen never left.
  await draw().catch(drawFailed);
  // The interval itself keeps the event loop alive; unref-ing it would exit at once.
  setInterval(() => {
    draw().catch(drawFailed);
  }, Math.max(2, intervalSeconds) * 1000);
};

export const visibleLength = (text: string): number =>
  record('watch.visibleLength', { text }, visibleLengthUnrecorded(text));

export const wrapText = (text: string, width: number, maxLines: number): string[] =>
  record('watch.wrapText', { text, width, maxLines }, wrapTextUnrecorded(text, width, maxLines));

export const clip = (text: string, width: number): string =>
  record('watch.clip', { text, width }, clipUnrecorded(text, width));

export const untilLabel = (at: string | null, now: number): string =>
  record('watch.untilLabel', { at, now }, untilLabelUnrecorded(at, now));

export const keybarLines = (width: number, narrow: boolean): string[] =>
  record('watch.keybarLines', { width, narrow }, keybarLinesUnrecorded(width, narrow));

export const accountsLabel = (funding: number, usable: number): string =>
  record('watch.accountsLabel', { funding, usable }, accountsLabelUnrecorded(funding, usable));

export const childReason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return record('watch.childReason', { text }, childReasonUnrecorded(error));
};
