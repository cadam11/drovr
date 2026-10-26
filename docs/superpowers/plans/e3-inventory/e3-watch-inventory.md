# E3 — `drovr watch` inventory (TS oracle → Go port)

Sources read: `src/watch.ts` (1001 lines, all of it), `src/state.ts` (`collectState`, `DrovrState`, `ProgramState`), `src/keys.ts`, `src/orca.ts` (`readPreview`, `interruptRunner`, `releaseLeftover`), `src/status-accounts.ts`, `src/allocation.ts` (types), `src/cli.ts:680`, `src/help.ts` (watch entry), `src/record.ts`, `test/layout.spec.ts`, `test/watch-state.spec.ts`, CLAUDE.md `watch.ts` trap rows. Go side checked: `internal/state` (Collector.Collect), `internal/keys`, `internal/orca` (Client.InterruptRunner / ReleaseLeftover), `internal/lock.Holder`, `internal/control.ByPriority`, `internal/jsnum`. **There is no Go `watch` command yet** (nothing in `internal/cli` mentions it).

Line numbers below are `src/watch.ts` unless stated.

---

## 0. Entry point

`src/cli.ts:680`:
```ts
if (command === 'watch') return watch(Number.parseInt(rest[0] ?? '15', 10));
```
- Default interval 15 s. No validation: `drovr watch abc` → `NaN`; `Math.max(2, NaN)` is `NaN`, so the probe window is `NaN*1000` (comparison `now - at < NaN` is false → always fresh) and `setInterval(fn, NaN)` fires at ~1 ms (Node clamps to 1). Go: decide whether to replicate or refuse; recommend refusing a non-integer (behaviour change → TS first per CLAUDE.md, or document as accepted divergence).
- No TTY check in cli.ts. Inside `watch`, raw mode / stdin listening only happen `if (process.stdin.isTTY)`; escape sequences and drawing happen regardless (so piping stdout still writes alt-screen sequences). help.ts says "Interactive and TTY-only … Not for agent use".
- help.ts entry (verbatim, must be kept in sync if Go owns help): usage `drovr watch [seconds]`, summary `live view with keyboard controls (default 15s refresh)`, writes `control.json, when a key is pressed`.

---

## 1. Terminal protocol

Constants (l.21-22):
```ts
const ESC = '\x1b[';
const CTRL_C = '\x03';
```

### Enter (l.902), written once, before the first draw:
```ts
process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`);
```
Bytes: `\x1b[?1049h` (alt screen) `\x1b[?25l` (hide cursor) `\x1b[?1000h` (X11 mouse: press/release + wheel, no motion) `\x1b[?1006h` (SGR encoding). Order matters only cosmetically; replicate.

Then (l.903-907):
```ts
process.on('SIGINT', leave);
process.on('uncaughtException', die);
process.stdout.on('resize', () => { draw().catch(drawFailed); });
```
- `resize` is Node's SIGWINCH surface → one non-fresh draw.
- **SIGTERM is not handled** (default action kills the process; terminal NOT restored). SIGHUP likewise. No `unhandledRejection` handler. Go port: handling SIGTERM/SIGHUP with restore is a strict improvement; note it as a divergence if you add it.
- In raw mode Ctrl-C arrives as byte `\x03`, not SIGINT; `SIGINT` handler only matters before raw mode / non-TTY stdin.

Raw mode (l.973-992), only if `process.stdin.isTTY`:
```ts
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => { ... });
```

### Restore (l.808-813) — used by every exit path:
```ts
const restore = (): void => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  // Mouse reporting off first — a shell fed SGR reports pastes them as text.
  // Leave the alternate screen last, so the shell's own scrollback comes back intact.
  process.stdout.write(`${ESC}?1000l${ESC}?1006l${ESC}?25h${ESC}?1049l`);
};
```
Bytes: `\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l` — mouse off, SGR off, cursor shown, alt screen left (last).

Exit paths:
| path | code | exit |
|---|---|---|
| `q` or `\x03` keystroke (whole chunk equals it) | `leave()` | restore, `process.exit(0)` |
| SIGINT | `leave` | restore, exit 0 |
| uncaught exception | `die(error)` | restore, `console.error(message)`, exit 1 |
| first draw fails (no `lastState`) | `drawFailed` → `die` | restore, stderr message, exit 1 |
| a `handle()` promise rejects | `.catch(die)` (l.919) | restore, stderr, exit 1 |
| SIGTERM / SIGHUP | unhandled | killed, terminal left in alt screen/raw (bug-compatible or fix) |

`die` prints `error instanceof Error ? error.message : String(error)` to stderr AFTER restore (so it lands in the main screen).

Note `handle()` returning a rejected promise is rare: every keys.ts setter is sync and throws synchronously inside an `async` function, which becomes a rejection → `die`. E.g. `toggleEnabled` on a program renamed out of control.json throws `no program named "x"` → **watch exits 1**. Go port: same behaviour unless deliberately softened (the sync `try/catch` at l.911-923 only catches throws from `readControl`/`byPriority`, not from inside `handle`).

### Refresh interval & probe window
```ts
// l.863-865, runDraw
paint(await collectState((warning) => { view.previewWarning = warning; },
  fresh ? 0 : Math.max(2, intervalSeconds) * 1000));
// l.998-1000
setInterval(() => { draw().catch(drawFailed); }, Math.max(2, intervalSeconds) * 1000);
```
- Interval = `max(2, intervalSeconds)` seconds. Probe max age = same value in ms, or 0 when `fresh`.
- The interval draw is non-fresh but in practice always re-probes: it fires one interval after the previous probe *started*, so `now - at < maxAge` is false. Keystroke redraws reuse the probe (cost ≈ disk reads only).
- `fresh: true` only from `r` and from a successful `l` release.
- Go mapping: `collector.Collect(ctx, func(w string){ view.PreviewWarning = &w }, probeMaxAge)` where probeMaxAge = `0` or `time.Duration(max(2,interval))*time.Second`. Go `Collect` panics on a nil sink — watch always passes one.
- **`setInterval` is not `unref()`'d** (l.997 comment: "The interval itself keeps the event loop alive; unref-ing it would exit at once."). Go equivalent: `watch` must block (select loop on ticker/stdin/signals) until quit; it must not return after the first draw.

### Draw serialization (l.889-897)
```ts
let pending: Promise<void> = Promise.resolve();
const draw = (fresh = false): Promise<void> => {
  const next = pending.then(() => runDraw(fresh), () => runDraw(fresh));
  pending = next;
  return next;
};
```
Every draw (interval, key, resize, mouse) queues behind the previous one; a failed predecessor does not poison `fresh`. Draws never overlap and never paint out of order. Every caller does `draw(...).catch(drawFailed)`. Go: one goroutine owning drawing, fed by a channel of `{fresh bool}` requests (coalescing is NOT what TS does — TS runs every queued draw; coalescing would be a harmless divergence but note it).

`runDraw` resets `view.previewWarning = null` before each collect so a fixed preview stops complaining (warnings replayed from a reused probe re-set it).

### paint (l.833-846) — the per-frame write
```ts
const rows = Math.max(6, process.stdout.rows ?? 40);
const columns = process.stdout.columns ?? 100;
lastState = state;
const { text, hits } = frameWithHits(state, view, columns, rows);
lastHits = hits;
lastWidth = Math.max(24, Math.min(columns, 120));
lastNarrow = lastWidth < 72;
const painted = text.split('\n').map((line) => `${line}${ESC}K`).join('\r\n');
process.stdout.write(`${ESC}H${painted}${ESC}0J`);
```
Exact frame bytes: `\x1b[H` + lines each suffixed `\x1b[K` (erase to EOL) joined by `\r\n` + `\x1b[0J` (erase below). **No trailing newline.** No full-screen clear (flicker). Frame height ≤ rows-1 (clamp in frameWithHits).

---

## 2. `frameWithHits(state, view, columns?, rows?)` / `frame(...)`

```ts
export const frameWithHits = (state: DrovrState, view: ViewState, columns?: number, rows?: number)
  : { text: string; hits: (LineHit | null)[] }
export const frame = (state, view, columns?, rows?): string => frameWithHits(state, view, columns, rows).text;
```

Derived values:
```ts
const width = Math.max(24, Math.min(columns ?? process.stdout.columns ?? 100, 120));
if (view.help) return clampAndClip(helpLines().map(plain), [], width, rows);
const now = Date.parse(state.generatedAt);
const narrow = width < 72;
```
So width ∈ [24,120]; `narrow` iff width < 72. `now` comes from the state, never the clock → pure (except `toTimeString`, which depends on the process **local timezone** — see header line).

### Constants
| name | value |
|---|---|
| `ESC` | `'\x1b['` |
| `CTRL_C` | `'\x03'` |
| `VERDICT_COLOUR` | `{ GO: 32, WAIT: 33, STOP: 31, RUN: 36 }`, fallback `37` |
| `DETAIL_INDENT` | `6` |
| `REASON_BUDGET` | `200` |
| `MOUSE_EVENTS` | `/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g` |
| `MOUSE_EVENTS_PER_CHUNK` | `8` |
| width clamp | `[24, 120]`, fallback columns `100` |
| narrow threshold | `< 72` |
| paint rows | `Math.max(6, stdout.rows ?? 40)` |

### ANSI helpers (l.24-31), exact bytes
```ts
const dim = (text) => `${ESC}2m${text}${ESC}0m`;
const bold = (text) => `${ESC}1m${text}${ESC}0m`;
const paint = (code, text) => `${ESC}${code}m${text}${ESC}0m`;
const invert = (text) => `${ESC}7m${text}${ESC}0m`;
const osc8 = (url, text) => `\x1b]8;;${url}\x1b\\${paint(36, text)}\x1b]8;;\x1b\\`;
```
Note: every helper resets with `\x1b[0m` (not a targeted reset). Nesting e.g. `dim(\`... ${paint(...)} ...\`)` therefore ends the dim early at the inner reset — reproduce byte-for-byte, don't "fix".

### Layout top to bottom (normal frame; `view.help === false`)

Body (`lines`):

1. **Header** (l.517-520):
```ts
`${bold('drovr')}  ${dim(`mode ${state.mode}${state.modeFromPhone ? ' (phone)' : ''}`)}${held}  ` +
  dim(new Date(now).toTimeString().slice(0, 8))
```
where
```ts
const held = state.pauseUntil !== null && Date.parse(state.pauseUntil) > now
  ? paint(33, ` paused until ${state.pauseUntil.slice(11, 16)}`) : '';
```
- Clock: `toTimeString().slice(0,8)` = **local** `HH:MM:SS` (Go `time.UnixMilli(now).Local().Format("15:04:05")`). Recorded fixtures will bake in the recording machine's TZ — pin `TZ` when recording/replaying.
- `pauseUntil.slice(11,16)` = `HH:MM` taken literally from the ISO string (UTC as stored, not local). Go: `jsnum.Slice`/byte slice of the string, not a parsed time.
- hit: null.

2. **Service line** (l.521): `` `  ${paint(healthy ? 32 : 31, '●')} ${dim(serviceLine(state.service, now))}` `` with `healthy = state.service.loaded && !state.service.overdue`. hit null.

`serviceLine` (l.424-436), verbatim strings:
```ts
if (!service.loaded) return 'launchd agent is not loaded, so no tick will fire. Fix: drovr service install';
if (service.lastTickAt === null) {
  const every = service.intervalSeconds === null ? '' : ` (fires every ${service.intervalSeconds}s)`;
  return `loaded${every}, but no tick has recorded a decision yet`;
}
const minutes = Math.max(0, Math.round((now - Date.parse(service.lastTickAt)) / 60_000));
const ago = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m ago`;
const overdue = service.overdue ? ' — overdue, the agent may be stalled' : '';
return `loaded. Last tick recorded a decision ${ago}${overdue}`;
```
(`Math.round` = half toward +∞ → `jsnum.RoundHalfUp`.)

3. **Mode off** → exactly two lines: `''` and `paint(31, '  mode is off — press m to cycle modes')`. Otherwise:

3a. **Allocation block** (`allocationLines`, l.257-289), with `barWidth: Math.max(8, width - (narrow ? 22 : 28))`:
```ts
'',
`  ${bold('ALLOCATION')}  ${dim(`${accountsLabel(fundingAccounts, usableAccounts)} · weekly resets in ${resetIn}`)}`,
`  ${SEGMENTS.map((s) => `${paint(s.colour, s.char)} ${dim(s.label)}`).join('  ')}`,
'',
...rows,   // one per bucket, order fable, general, session
```
- `resetIn = hoursToWeeklyReset === null ? '—' : \`${Math.floor(hoursToWeeklyReset)}h\``
- `accountsLabel(funding, usable) = funding === usable ? \`${usable} accounts\` : \`${funding} of ${usable} accounts funding\`` (exported; numbers via JS `String(n)` → `jsnum.String`).
- bucket row:
```ts
const yours = alloc.yoursSpent + alloc.yoursReserved;
const binds = bucket.name === bindingBucket ? paint(31, ' binds') : '';
`  ${(narrow ? bucket.short : bucket.label).padEnd(narrow ? 4 : 11)}${bar(alloc, barWidth)} ` +
`${dim(`you ${percent(yours, alloc.total).padStart(4)}`)}${binds}`
```
`percent = (value, total) => \`${((value / total) * 100).toFixed(0)}%\`` → Go `jsnum.ToFixed(v,0)+"%"` (NOT strconv, which rounds half-even). total 0 → `NaN%`.
`BUCKETS`:
```ts
{ name: 'fable',   label: 'fable   7d', short: 'fab' },
{ name: 'general', label: 'general 7d', short: 'gen' },
{ name: 'session', label: 'session 5h', short: '5h'  },
```

3b. **Capacity note** (l.544-546): `wrapText(state.capacityNote, Math.max(8, width - 4), 3).map((line) => \`  ${dim(line)}\`)` — up to 3 lines. Empty note → one line `  \x1b[2m\x1b[0m`.

3c. **Accounts block** (`accountLines`, l.312-346): empty array if no accounts, else `['', header, ...rows]`.
```ts
const nameWidth = narrow ? 14 : Math.min(28, Math.max(...accounts.map((entry) => entry.name.length)));
const statusWidth = narrow ? 0 : 9;
const fixed = 4 + nameWidth + 1 + statusWidth + ACCOUNT_BUCKETS.length * 11;
const barWidth = Math.max(3, Math.floor((width - fixed) / ACCOUNT_BUCKETS.length));
const target = accounts.find((entry) => entry.fableTarget);
const header = `  ${bold('ACCOUNTS')}  ` +
  dim(target === undefined ? 'fable route has no target' : `fable route → ${target.name}`);
// row:
const marker = entry.fableTarget ? paint(32, '►') : entry.fableEligible === false ? paint(31, '✗') : ' ';
const name = clip(narrow ? entry.name.split('@')[0]! : entry.name, nameWidth).padEnd(nameWidth);
const status = narrow ? ''
  : entry.disabled ? dim('disabled'.padEnd(statusWidth))
  : paint(entry.status === 'active' ? 32 : 33, (entry.status ?? '?').padEnd(statusWidth));
const buckets = ACCOUNT_BUCKETS.map(({ key, label }) => {
  const bucket = entry.buckets[key];
  return `${dim(label)} ${usedBar(bucket.usedFraction, barWidth)} ${untilLabel(bucket.resetsAt, now).padEnd(6)}`;
}).join(' ');
return `  ${marker} ${name} ${status}${buckets}`;
```
`ACCOUNT_BUCKETS` order: `session '5h'`, `general 'wk'`, `fable 'F7'`.
Quirk: `clip(name, nameWidth)` on an over-long name returns a string ending `\x1b[0m…`; `.padEnd(nameWidth)` then pads by UTF-16 length *including* the escape bytes, so a clipped name is not padded (it is already longer). Replicate using JS-length semantics (see §2 "length semantics").

All of 3a/3b/3c are `plain` (hit null).

4. **Programs block** (l.556-566):
```ts
plain(''),
plain(`  ${bold('PROGRAMS')}  ${dim(`${state.cyclesInFlight}/${state.maxConcurrentCycles} in flight`)}`),
...programLines(...).flatMap(({ text, ask }, index) => [
  { text, hit: { program: index } },
  ...(ask === null ? [] : [{ text: ask, hit: { asks: index } }]),
]),
```
`programLines` (l.376-417):
```ts
const nameWidth = Math.max(8, ...programs.map((program) => program.name.length)) + 6;
// per program:
const detail = startedAt === null
  ? program.reason
  : `pid ${program.pid ?? '?'} · ${elapsed(startedAt, now)} · ${program.kind ?? '?'}`;
const label = `${program.name}${program.enabled ? '' : ' (off)'}`.padEnd(nameWidth);
const head =
  ` ${isSelected ? paint(36, '▸') : ' '}${dim(`p${String(program.priority).padStart(2)}`)} ` +
  `${isSelected ? invert(label) : label} ` +
  `${paint(VERDICT_COLOUR[program.verdict] ?? 37, program.verdict.padEnd(4))}`;
const inline = !narrow && visibleLength(head) + 2 + detail.length <= width;
const row = inline ? `${head}  ${dim(detail)}` : head;
const detailLines = inline ? []
  : wrapText(detail, Math.max(8, width - DETAIL_INDENT), detailLinesFor(width))
      .map((line) => `${' '.repeat(DETAIL_INDENT)}${dim(line)}`);
const ask = program.asksUrl === null ? null
  : `${' '.repeat(DETAIL_INDENT)}${osc8(program.asksUrl,
      narrow ? 'asks ›' : program.asksUrl.replace(/^https:\/\//, ''))}`;
return { text: [row, ...detailLines].join('\n'), ask };
```
- `elapsed(since, now)`: `minutes = max(0, round((now - Date.parse(since))/60000))`; `<60 → "${m}m"` else `"${floor(m/60)}h${pad2(m%60)}m"`.
- priority `String(n).padStart(2)` — `p 3`, `p-1`, `p10`. Priority may be fractional? (keys nudge ±1 from integer; JS `String(1.5)`="1.5" → use `jsnum.String`).
- The row text contains embedded `\n` (row + detail lines); all of them share hit `{program: i}`.
- `detailLinesFor(width) = Math.min(4, Math.max(2, Math.ceil(REASON_BUDGET / Math.max(8, width - DETAIL_INDENT))))` → width 24..72 → 4 lines, 73..105 → 3, 106..120 → 2 (e.g. 72: ceil(200/66)=4; 73: ceil(200/67)=3; 106: ceil(200/100)=2).
- **`ProgramState.preview` and `.context` are NOT rendered anywhere in watch.ts.** They are collected (state.ts) but the frame ignores them. The only preview-related thing on screen is `view.previewWarning` (see §8).

5. **Recent block** (l.568-579), only if `state.recentCycles.length > 0`, first 5:
```ts
plain(''), plain(`  ${bold('RECENT')}`),
...recent.map((cycle) => plain(dim(
  `  ${cycle.startedAt.slice(5, 16).replace('T', ' ')}  ${cycle.program.padEnd(10)}` +
  `${cycle.kind.padEnd(11)}${cycle.exit.padEnd(9)}asks=${cycle.asksRaised}`,
)))
```
(`startedAt.slice(5,16)` = `MM-DDTHH:MM` of the ISO string, `T`→space, i.e. UTC.)

Tail (`foot`, reserved — l.591-596):
```ts
const tail: Tagged[] = [
  plain(''),
  plain(view.message === '' ? '  ' : paint(36, `  ${view.message}`)),
  ...(view.previewWarning == null ? [] : [plain(paint(33, `  ${view.previewWarning}`))]),
  ...keybarLines(width, narrow).map((text, index) => ({ text, hit: { keybar: index } })),
];
return clampAndClip(lines, tail, width, rows);
```
Message line is always present (two spaces when empty). Preview warning only when non-null/undefined (`== null` covers both).

### Help frame (`view.help`) — `helpLines()` l.216-255, verbatim:
```ts
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
`  ${dim('Sized for 80×24+. Narrower shortens labels and bars; keys always show.')}`,
'',
`  ${dim('? or esc closes this')}`,
```
(Note: help omits `s start`; the percentages are hardcoded text, not read from ceilings.) Help frame: body = these lines, foot = `[]`, all hits null. No keybar, no message line.

### `clampAndClip(body, foot, width, rows?)` — the tail-reservation clamp (l.459-479), verbatim:
```ts
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
  text: kept.map((line) => clip(line.text, width)).join('\n'),
  hits: kept.map((line) => line.hit),
};
```
- Budget = `rows - 1` (min 1). Body is cut from the bottom; the foot is kept whole; if the foot alone exceeds the budget, the foot's top survives.
- `hits.length === text.split('\n').length` always; `hits[i]` is the hit of screen row i+1.

### `LineHit` (exported type) and `Tagged`
```ts
export type LineHit = { program: number } | { asks: number } | { keybar: number };
type Tagged = { text: string; hit: LineHit | null };
```
Go: `type LineHit struct{ Kind HitKind; Index int }` with kinds Program/Asks/Keybar, and `[]*LineHit` (nil = dead).

### visibleLength / clip / wrapText

```ts
export const visibleLength = (text: string): number =>
  text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
```
Strips OSC (`ESC ] … BEL` or `ESC ] … ESC \`) then CSI (`ESC [ [0-9;?]* letter`). **No wide-char handling**: result is the JS `.length` (UTF-16 code units). All glyphs used (`█▓▒░·►✗▸●…—→›×`) are BMP, 1 unit each. Go: count runes (`utf8.RuneCountInString`) after stripping; identical for BMP. (Astral chars, e.g. emoji in a program reason, count 2 in JS — only matters for exactness if such text appears; document as accepted or count UTF-16 units via `utf16.Encode`.)

```ts
export const clip = (text: string, width: number): string => {
  if (visibleLength(text) <= width) return text;
  let out = ''; let shown = 0;
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
```
- Over-width result: `width-1` visible chars + `\x1b[0m…` (exactly `width` visible).
- **Quirk to reproduce exactly**: an escape is copied verbatim up to the next literal `m` — correct for SGR (`\x1b[..m`), but for OSC 8 (`\x1b]8;;URL\x1b\\`) it swallows everything to the first `m` after the ESC, which may lie inside the URL (`.html`!) or in the visible label. Only reached when an asks line is wider than `width` (long URL at narrow-ish widths). Port byte-for-byte; a fixture covering an over-wide asks line is worth recording.
- Iteration is by UTF-16 unit in JS; Go iterate runes (equal for BMP).
- After the loop breaks, remaining escapes (e.g. the trailing reset / OSC close) are dropped; `\x1b[0m` is appended instead. An unclosed OSC 8 can therefore leak into following text in some terminals — bug-compatible.

```ts
export const wrapText = (text: string, width: number, maxLines: number): string[] => {
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
```
- Measures raw `.length` (operates on plain text; callers wrap before colouring).
- `lastIndexOf(' ', width)` searches at index ≤ width (inclusive) — so a space exactly at `width` is a valid break (line length = width). `space > 0` → a space at index 0 is ignored and a hard cut at `width` happens.
- `trimStart()` trims all JS whitespace (incl. `\n`, NBSP…); Go `strings.TrimLeftFunc(unicode.IsSpace)` is close (JS also trims U+FEFF; negligible).
- Last line absorbs the remainder (may exceed width; caller's `clip` truncates it).
- Loop bounded by `maxLines` (Go must assert the same preconditions — panic/err message verbatim if recorded).

### Length semantics summary for Go
JS `.length`, `padEnd`, `padStart`, `slice`, `lastIndexOf` all count UTF-16 units. Use rune-based helpers throughout; they agree for every string watch produces except astral-plane text in reasons/names. `padEnd` on a string containing escapes counts the escape bytes (they are characters) — e.g. `clip(name).padEnd(nameWidth)` and `label.padEnd(nameWidth)` (label has no escapes; fine).

### `untilLabel` (exported, l.127-135)
```ts
if (at === null) return '—';
const minutes = Math.round((Date.parse(at) - now) / 60_000);
if (minutes <= 0) return 'now';
if (minutes < 60) return `${minutes}m`;
const hours = Math.floor(minutes / 60);
if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
```
`Math.round` half-up → `jsnum.RoundHalfUp`. Unparseable `at` → NaN → falls through every `<` test → `NaNd NaNh`-style string (`"NaNdNaNh"`); Go: decide, likely unreachable since resetsAt is ISO from status-accounts.

---

## 3. Bars

### Allocation bar (pool, per bucket)
```ts
const SEGMENTS = [
  { key: 'yoursSpent',        char: '▓', colour: 35, label: 'you spent' },
  { key: 'programsSpent',     char: '█', colour: 32, label: 'programs spent' },
  { key: 'programsReserved',  char: '▒', colour: 36, label: 'in flight' },
  { key: 'programsAvailable', char: '░', colour: 90, label: 'free to programs' },
  { key: 'yoursReserved',     char: '·', colour: 35, label: 'held for you' },
];
/** Largest-remainder allocation so the bar is always exactly `width` cells. */
const barCells = (allocation: Allocation, width: number): number[] => {
  const exact = SEGMENTS.map((segment) => ((allocation[segment.key] as number) / allocation.total) * width);
  const floors = exact.map(Math.floor);
  const deficit = width - floors.reduce((total, value) => total + value, 0);
  const promoted = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, Math.max(0, deficit))
    .map((entry) => entry.index);
  return floors.map((value, index) => value + (promoted.includes(index) ? 1 : 0));
};
const bar = (allocation, width) => barCells(allocation, width)
  .map((cells, index) => paint(SEGMENTS[index]!.colour, SEGMENTS[index]!.char.repeat(cells))).join('');
```
- Every segment is always emitted as `\x1b[<c>m<chars>\x1b[0m` even with 0 cells (empty paint).
- Ties in remainder: JS `Array.prototype.sort` is stable → lower index first. Go: `sort.SliceStable` descending.
- `total === 0` → all NaN → `repeat(NaN)` = `''` → five empty paints (bar has 0 visible cells). Negative segment would throw RangeError in `repeat` — allocation.ts guarantees ≥ 0; Go should assert.
- Width: `barWidth = Math.max(8, width - (narrow ? 22 : 28))`.

### Used bar (per account bucket)
```ts
const usedBar = (fraction: number | null, width: number): string => {
  if (fraction === null) return dim('?'.repeat(width));
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  const colour = clamped >= 0.8 ? 31 : clamped >= 0.5 ? 33 : 32;
  return paint(colour, '█'.repeat(filled)) + paint(90, '░'.repeat(width - filled));
};
```
Red ≥0.8, yellow ≥0.5, else green; remainder `░` in 90 (bright black). Round half-up.

Colour codes used anywhere: 1 bold, 2 dim, 7 inverse, 31 red, 32 green, 33 yellow, 35 magenta, 36 cyan, 37 white (verdict fallback), 90 grey. All 16-colour SGR; no 256/truecolour.

---

## 4. Keybar

```ts
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
export const keybarLines = (width: number, narrow: boolean): string[] =>
  keybarLayout(width, narrow).map((row) => `  ${row.map((entry) => entry.shown).join(dim(' · '))}`);
export const keybarKeyAt = (width, narrow, row, column): string | null => {
  const entries = keybarLayout(width, narrow)[row] ?? [];
  return entries.find((entry) => column >= entry.start && column < entry.end)?.key ?? null;
};
```
- Separator `dim(' · ')` = `\x1b[2m · \x1b[0m` (3 visible columns). Indent 2. `start`/`end` are 0-based visible columns, `end` exclusive. `cost` always includes a separator even for a row's last entry; wrap test is `used + cost > width - 4`.
- Narrow shows the first space-separated token: `j/k`, `space`, `[`, `m`, `p`, `+/-`, `<`, `r`, `t`, `o`, `s`, `x`, `l`, `?`, `q`.
- The keybar is **static** — the same entries whatever the state (no change while a confirmation is armed; the confirmation lives on the message line). Not clamped per-line: wrapped instead; `clampAndClip` still clips each line to width (keybar lines never exceed width by construction).
- Not clickable: `j/k`, `[ ]`, `+/-`, `< >` (key null). Clickable: space, m, p, r, t, o, s, x, l, ?, q.
- Hit-testing: `frame` tags keybar line i with `{keybar: i}`; a click calls `keybarKeyAt(lastWidth, lastNarrow, hit.keybar, column - 1)` — width/narrow from the last *painted* frame (`lastWidth = Math.max(24, Math.min(columns, 120))`, `lastNarrow = lastWidth < 72`), never recomputed.

Golden rendered keybar (escapes stripped), from running the TS:
```
120 wide:  "  j/k select · space enable · [ ] priority · m mode · p pause · +/- cap · < > reserve · r refresh · t tick · o asks"
           "  s start · x interrupt · l release · ? help · q quit"
100 wide:  "  j/k select · space enable · [ ] priority · m mode · p pause · +/- cap · < > reserve"
           "  r refresh · t tick · o asks · s start · x interrupt · l release · ? help · q quit"
80 wide:   "  j/k select · space enable · [ ] priority · m mode · p pause · +/- cap"
           "  < > reserve · r refresh · t tick · o asks · s start · x interrupt"
           "  l release · ? help · q quit"
71 narrow: "  j/k · space · [ · m · p · +/- · < · r · t · o · s · x · l · ?"
           "  q"
60 narrow: "  j/k · space · [ · m · p · +/- · < · r · t · o · s · x"
           "  l · ? · q"
24 narrow: "  j/k · space · [" / "  m · p · +/- · <" / "  r · t · o · s · x" / "  l · ? · q"
```

---

## 5. Keystroke handling

### Dispatch (`onKey`, l.909-924)
```ts
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
```
- `key` is the **whole stdin chunk** (minus mouse reports). A key matches only if the chunk equals it exactly; a pasted `"jj"` or `"qx"` matches nothing → `{message:'', redraw:false}`. `q` quits even while a confirmation is armed (checked before `handle`) and even in help.
- `programs` is re-read from control.json every key and sorted by `byPriority(…, Date.now(), …)`; `view.selected` indexes this list. The frame indexes `state.programs`, which buildState also orders with `byPriority` (state.ts:151, at the state's `now`) — the two are assumed aligned.
- `view.message` is set to the action's message **even when `redraw` is false**; it then shows on the next draw (interval/resize/other key).
- readControl/byPriority throwing → message = error text, non-fresh redraw.
- `handle` rejection → `die` (exit 1).

`Action` (keys.ts): `{ message: string; redraw: boolean; quit?: boolean; fresh?: boolean }` (`quit` unused by watch).

### `handle(key, view, programs, state)` (l.688-773), in exact order
```ts
const control = paths().control;
const selected = programs[view.selected];
const settings = readControl(control);
```
1. **Armed stop** (`view.confirmStop`): clear it; if `key !== 'y'` → `{ message: 'stop cancelled', redraw: true }`; else `selected === undefined` → `{ message: 'no program selected', redraw: false }`, else `stopCycle(selected)`.
2. **Armed start** (`view.confirmStart`): clear it; `key !== 'y'` → `{ message: 'start cancelled', redraw: true }`; else undefined → `'no program selected'` (redraw false), else `startCycle(selected)`.
   (So ANY key other than `y` — including arrows, `?`, `r` — cancels and is consumed; `q`/Ctrl-C quit before reaching here.)
3. `j` or `\x1b[B` (down): `view.selected = Math.min(programs.length - 1, view.selected + 1)` → `{message:'', redraw:true}`. Quirk: with 0 programs this sets selected to **-1**.
4. `k` or `\x1b[A` (up): `view.selected = Math.max(0, view.selected - 1)` → `{message:'', redraw:true}`.
   (j/k work while help is open — they are checked before the help gate.)
5. `?`, or `\x1b` (bare ESC) **while help is open**: toggle `view.help` → `{message:'', redraw:true}`.
6. If `view.help`: `{message:'', redraw:false}` (every other key ignored).
7. `r` → `{ message: 'refreshed', redraw: true, fresh: true }`.
8. `m` → `cycleMode(control, settings.mode)` → message `mode → ${next}`; MODES `['off','low','normal','away']`, wraps.
9. `p` → `cyclePause(control, settings.pauseUntil)` → `pause cleared` if a future pause exists, else sets now+1h → `paused 1h`.
10. `P` → `extendPause(control, settings.pauseUntil)` → next of 1h/3h/8h/24h strictly greater than (remaining + 60 s), else 24h → `paused ${label}`.
11. `<` or `,`:
```ts
const weekly = settings.ceilings[settings.mode]?.weekly ?? 0.55;
return setReserve(control, settings.mode, 1 - weekly - 0.05);
```
12. `>` or `.`: same with `1 - weekly + 0.05`.
    setReserve message: `` `${mode}: ${pct(reserve)} held for you — programs up to ${pct(weekly)} weekly, ${pct(session)} per 5h` `` (pct = Math.round ×100). Note: in mode `off`, `settings.ceilings.off` is undefined → weekly 0.55 and setReserve writes an `off` ceiling (unlike `nudgeReserve`, which refuses). Bug-compatible; Go `keys.SetReserve(path, mode, fraction)` exists.
13. `+` or `=` → `adjustConcurrency(control, 1)`; `-` or `_` → `adjustConcurrency(control, -1)` → `concurrency cap → ${cap}` (clamped 1..8, default 2).
14. `t` → `runTickNow()` → `{ message: 'tick launched', redraw: true }` (see §10).
15. If `selected === undefined` → `{ message: 'no programs configured', redraw: false }`.
16. `o`:
```ts
const url = state?.programs.find((program) => program.name === selected.name)?.asksUrl ?? null;
if (url === null) return { message: `${selected.name} has no asks page configured`, redraw: false };
spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
return { message: `opened ${url}`, redraw: true };
```
    (macOS `open`; URL from `lastState`, so may be one frame stale; `file://` URLs for asksFile programs too. Spawn errors (ENOENT) are not handled — an `'error'` event on the child would be an uncaught exception → `die`.)
17. `' '` or `e` → `toggleEnabled(control, selected.name)` → `${name} enabled|disabled`.
18. `[` → `nudgePriority(control, name, -1)`; `]` → `nudgePriority(..., 1)` → `${name} priority → ${priority}` (clamped -9..9).
19. `x` → arm stop:
```ts
view.confirmStop = true;
const verb = selected.runner === 'orca' ? 'interrupt' : 'stop';
return { message: `${verb} ${selected.name}? y to confirm, any other key to cancel`, redraw: true };
```
20. `l` → `releaseLeftover(selected)` (below).
21. `s`:
```ts
const pid = holder(paths().programLock(selected.name));
if (pid !== null) return { message: `${selected.name} already has a cycle running (pid ${pid})`, redraw: false };
view.confirmStart = true;
return { message: `start ${selected.name} now, past every gate? y to confirm, any other key to cancel`, redraw: true };
```
22. anything else → `{ message: '', redraw: false }`.

(Keys documented in help but absent: none. `e` is an undocumented alias for space. `y` alone, unarmed, does nothing.)

### `stopCycle(program)` (l.637-657) — after `x` then `y`
```ts
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
```
- orca: `interruptRunner` = resolve runner terminal (throws `${program} has no runner terminal` if none) then `orca terminal send --terminal <handle> --interrupt [--environment …] --json`, 20 s timeout (`ORCA_TIMEOUT_MS = 20_000`). Go: `orca.Client.InterruptRunner(ctx, program)` (a read-only client refuses — watch needs a writable one).
- headless: SIGTERM to the **process group** `-pid` of the program-lock holder (Go `syscall.Kill(-pid, syscall.SIGTERM)`; `lock.Holder`).

### `releaseLeftover(program)` (l.666-686) — `l`
```ts
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
```
`releaseIfSafe` = orca.ts `releaseLeftover(program, reported)` → Go `orca.Client.ReleaseLeftover(ctx, program, reported)`; `lastCycleReported` from ledger (Go ledger has it). No y-confirm.

### What cancels an armed confirmation
- Any keystroke chunk other than exactly `y` (consumed, message `stop cancelled` / `start cancelled`, redraw).
- Any left-click on a program row or asks link, or any wheel event (via `selectProgram`, same messages, selection NOT changed).
- A left-click on a keybar key → that key goes through `onKey` → `handle` → cancels (unless the key is `q`, which quits).
- Clicks on dead space (hit null) or right/middle clicks do **nothing** — the confirmation stays armed.
- `q` / Ctrl-C quit regardless.
- Only one of `confirmStop`/`confirmStart` can be armed at a time in practice (arming happens only in the unarmed branch).

---

## 6. Mouse

Enabled with `?1000h` (press + release + wheel, no motion) and `?1006h` (SGR). Parsing per stdin chunk (l.977-991):
```ts
const MOUSE_EVENTS = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MOUSE_EVENTS_PER_CHUNK = 8;
process.stdin.on('data', (chunk: string) => {
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
```
- Byte layout: `ESC [ < Cb ; Cx ; Cy M|m`; Cx column and Cy row are **1-based**. `M` press, `m` release (ignored).
- At most 8 reports per chunk are acted on (wheel flick cap); ALL reports are stripped from the chunk; leftover text (if any) goes to `onKey` as one key string.
- Chunk boundaries: a report split across two reads is not reassembled (the halves fall to `onKey` as garbage keys → no-op). Go reader should ideally buffer partial sequences; TS does not.

`onMouse(button, column, row)` (l.944-971):
```ts
if ((button & 64) !== 0) {                     // wheel: 64 up, 65 down
  selectProgram(view.selected + ((button & 1) === 0 ? -1 : 1));
  return;
}
if ((button & 3) !== 0) return;                // left button only; right and middle stay free
const hit = lastHits[row - 1] ?? null;
if (hit === null) return;
if ('program' in hit) { selectProgram(hit.program); return; }
if ('asks' in hit) {
  if (view.confirmStop || view.confirmStart) { selectProgram(hit.asks); return; }
  view.selected = hit.asks;
  onKey('o');
  return;
}
const key = keybarKeyAt(lastWidth, lastNarrow, hit.keybar, column - 1);
if (key !== null) onKey(key);
```
- Modifier bits (4 shift, 8 alt, 16 ctrl) are not masked: shift-left (4) still has `&3 == 0` → treated as left click. Wheel ignores modifiers too.
- Rows past the frame (`row-1 >= lastHits.length`) → undefined → null → ignored.

`selectProgram(index)` (l.929-942):
```ts
if (view.confirmStop) { view.confirmStop = false; view.message = 'stop cancelled'; }
else if (view.confirmStart) { view.confirmStart = false; view.message = 'start cancelled'; }
else {
  const last = (lastState?.programs.length ?? 1) - 1;
  view.selected = Math.max(0, Math.min(last, index));
  view.message = '';
}
draw().catch(drawFailed);
```
(Clamp against `lastState.programs`; selection works in help view too since it doesn't consult `view.help` — the help frame has no program hits, but the wheel does change selection under help.)

Asks link: rendered as OSC 8 `\x1b]8;;<url>\x1b\\` + cyan label + `\x1b]8;;\x1b\\`, label `asks ›` when narrow else URL minus `https://`. Because mouse reporting is on, the terminal does not open it; the click selects the program and runs `onKey('o')` → `spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()` with url from `lastState` → message `opened ${url}`.

---

## 7. View state

```ts
type ViewState = {
  selected: number;
  message: string;
  confirmStop: boolean;
  confirmStart: boolean;
  help: boolean;
  previewWarning?: string | null;   // optional: tests omit it; watch() always sets it
};
// initial (l.799):
{ selected: 0, message: '', confirmStop: false, confirmStart: false, help: false, previewWarning: null }
```
Closure state in `watch()` beside it: `lastState: DrovrState | null = null`, `lastHits: (LineHit|null)[] = []`, `lastWidth = 100`, `lastNarrow = false`, `pending` promise.

Selection model: an index into the priority-ordered program list. Not keyed by name — if programs are added/reordered between frames the highlight stays on the same index (may move to another program). Clamped by j/k (against `programs.length` from control.json) and by mouse (against `lastState.programs.length`). Never re-clamped when the list shrinks: a `selected` past the end → `programs[selected]` undefined → `no programs configured` for program keys, and no row shows `▸`.

---

## 8. Preview panel

**There is no preview panel in the frame.** `ProgramState.preview` (string[] | null) and `ProgramState.context` are filled by `collectState` but `watch.ts` never reads them. What watch shows is only the warning:

- `collectState` (state.ts:342-345) calls `readPreview(program.name)` only on a fresh probe, only for programs with a ledger in-flight cycle (`running`), concurrently via `Promise.all`.
- `readPreview` (orca.ts:712-726):
```ts
const terminal = await runnerTerminal(program);
if (terminal === null) return { preview: null, warning: `preview unavailable for ${program}: no runner terminal` };
const read = await orcaRaw(['terminal', 'read', '--terminal', terminal.handle, '--limit', '40', ...envArgs(terminal.environment)]);
return { preview: parsePreview(previewText(read)), warning: null };
// catch:
const [firstLine] = explainSpawn('orca', error).message.split('\n');
return { preview: null, warning: `preview unavailable for ${program}: ${firstLine ?? ''}` };
```
  `orcaRaw` appends `--json`, timeout `ORCA_TIMEOUT_MS = 20_000`, maxBuffer 8 MiB.
- Warnings go through `warn` → `onWarning`; watch's sink sets `view.previewWarning = warning` (last one wins when several programs warn — only one warning line is ever shown). Runner-state warnings (`could not read ${name}'s runner state: …`) and the phone-prefs warning flow through the same sink and so also land in `previewWarning`.
- A reused probe replays its stored warnings into the sink, so the line persists between probes.
- Rendered as tail line `paint(33, \`  ${view.previewWarning}\`)` directly below the message line, above the keybar.
- Go: `internal/state.Collector.Collect` already does the probing; `internal/preview.Parse(raw, maxLines)` exists but watch does not need it directly.

---

## 9. `drawFailed`

```ts
const drawFailed = (error: unknown): void => {
  if (lastState === null) return die(error);
  view.message = `could not refresh: ${childReason(error)}`;
  paint(lastState);
};
export const childReason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.find((line) => !line.startsWith('Command failed:')) ?? lines[0] ?? 'unknown error';
};
```
- First frame failing is fatal (restore, stderr, exit 1). Later failures repaint the last good `DrovrState` with the current `view` and message `could not refresh: <reason>`; the next draw retries. `paint` itself (sync) failing inside drawFailed would throw out of a `.catch` handler → unhandled rejection (Node default: crash without restore).
- Go: `childReason(err)` over `err.Error()`; Go's exec errors don't start with `Command failed:` but `exec.runBounded` may wrap similarly — check what `internal/exec` produces and keep the "first line that isn't the call echo" rule.

---

## 10. Detach

```ts
const cliPath = (): string => fileURLToPath(new URL('./cli.ts', import.meta.url));
const runTickNow = (): Action => {
  const child = spawn(process.execPath, [cliPath(), 'tick'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { message: 'tick launched', redraw: true };
};
const startCycle = (program: Program): Action => {
  const child = spawn(process.execPath, [cliPath(), 'start', program.name], { detached: true, stdio: 'ignore' });
  child.unref();
  return { message: `${program.name}: cycle launched`, redraw: true };
};
```
- Raw `child_process.spawn`, **not** `runBounded` and not `launchDetached` (tick.ts). Detached (new process group/session), stdio ignored → **no log path**; output is discarded. Fire-and-forget: no wait, no exit code, spawn errors unhandled (would surface as uncaught → die).
- `drovr tick` here is the normal (live) tick — it takes the tick lock like any launchd firing; `drovr start <name>` is the override path that bypasses admission and re-attaches/launches via the worker.
- Go: `exec.Command(os.Executable(), "tick")` / `("start", name)` with `SysProcAttr{Setsid: true}`, stdin/stdout/stderr nil (→ /dev/null), `Start()` then `Process.Release()`. Check whether the Go port already has a `launchDetached` equivalent in `internal/tick`/`internal/cycle` and whether it logs to a file — TS watch does not log; logging to the tick log would be a harmless improvement but a divergence.
- `o`: `spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()` — macOS-only.

---

## 11. Exported / pure functions and record hooks

`grep record( src/watch.ts` → **none**. watch.ts imports nothing from `record.ts`; no fixtures exist for it in `testdata/recorded/`. To fixture-record, hooks must be added in the TS first (per CLAUDE.md: behaviour lands in TS, then `scripts/record-fixtures.sh`, then Go). Candidates:

| export | signature | pure? | tested by |
|---|---|---|---|
| `visibleLength` | `(text: string) => number` | yes | layout.spec: SGR occupies 0 cols (`\x1b[31mabc\x1b[0m` → 3); OSC 8 measures only its label (→ 4) |
| `wrapText` | `(text, width, maxLines) => string[]` | yes (throws on width<1 / maxLines<1) | indirectly (watch-state reason survival) |
| `clip` | `(text, width) => string` | yes | layout.spec: short line returned identical; 80 x's at 20 → visible ≤ 20 and ends `…`; keeps leading `\x1b[31m` |
| `untilLabel` | `(at: string\|null, now: number) => string` | yes | watch-state: 59m, 4h49m, 66h→`2d18h`, past → `now`, null → `—` |
| `accountsLabel` | `(funding, usable) => string` | yes | not directly |
| `keybarLines` | `(width, narrow) => string[]` | yes | layout.spec: 200-wide = 1 line; 40 narrow > 1 line, each ≤ 40 visible; narrow contains `q` not `quit` |
| `keybarKeyAt` | `(width, narrow, row, column) => string\|null` | yes | layout.spec: (200,false,row0): col 3→null, 13→null, 14→null, 15→' ', 26→' ', 27→null, 199→null; row 9→null. At 40 narrow every one of `' ','m','p','r','t','o','x','?','q'` reachable |
| `LineHit` | type | — | — |
| `frameWithHits` | `(state, view, columns?, rows?) => {text, hits}` | pure iff `columns` supplied (else reads `process.stdout.columns`) **and** given a fixed TZ (header clock uses local time) | watch-state: hits.length == lines; alpha row `{program:0}`, beta `{program:1}`, asks URL line `{asks:0}`, `hits[0] === null`, last hit `{keybar: keybarLines(100,false).length-1}` |
| `frame` | `(state, view, columns?, rows?) => string` | same | watch-state: renders `drovr`/`demo`; each program row matches `name[^\n]*VERDICT`; exactly 3 lines match `/you\s*\d+%/`, only the bindingBucket one contains `binds`; byte-identical twice; coupled-state at 60/72/100/120: flat text contains `the pool has room for 0\.00 cycles`, `a start needs 1\.00`, `no account has room in all three buckets`, `second`, keybar (`q quit` or narrow ` q `), `binds`, every line ≤ width; 24-row clamp at 60/80/100/120 with Craig's config (3 programs, asks URLs, 5 recent): unclamped > 24 lines, clamped ≤ 23, contains `y to confirm`, `could not read sunnyt`, keybar, every line ≤ width; help at 80x24 overflows unclamped and clamps to ≤ 23, ≤ 80 wide; coupling note appears exactly once with 3 programs, `a start needs` 3 times; account rows (lines matching `/5h .*wk .*F7 /` after SGR strip) = 3, each containing its name, `2h00m`, `3d12h`; markers: target `►`, ineligible `✗`, third neither |
| `childReason` | `(error: unknown) => string` | yes | watch-state: skips `Command failed:` line → `Proxy at localhost:3456 did not answer status within 5000ms.`; only-preamble → preamble; string `'orca is not on PATH'` → itself; `new Error('')` → `unknown error` |
| `watch` | `(intervalSeconds) => Promise<void>` | no (I/O) | none |

Non-exported pure helpers: `dim/bold/paint/invert/osc8`, `barCells`, `bar`, `percent`, `elapsed`, `keybarLayout`, `helpLines`, `allocationLines`, `usedBar`, `accountLines`, `detailLinesFor`, `programLines`, `serviceLine`, `clampAndClip`. Impure: `runTickNow`, `startCycle`, `stopCycle`, `releaseLeftover`, `handle` (reads control.json, lock files, ledger; mutates `view`; spawns).

Test fixtures used: `test/fixtures.ts` (`account, control, healthy, HOUR, NOW, status`) + `buildState` — the Go port has `internal/fixtures` and `state.Build`, so the frame tests can be ported as Go tests over `state.Build` output without recording, but byte-exact equivalence needs either recorded `frame` outputs or a conformance diff. Recommendation: add `record('watch.frameWithHits', {state, view, columns, rows}, out)` (with `TZ=UTC` pinned in `record-fixtures.sh`) plus `record` in `wrapText`, `clip`, `keybarLayout`/`keybarKeyAt`, `untilLabel`, `childReason` (string inputs only — error objects don't serialize; record `{message}`).

---

## 12. stdout rows/columns dependence and fallbacks

| where | expression | fallback |
|---|---|---|
| `paint` rows | `Math.max(6, process.stdout.rows ?? 40)` | 40; never below 6 |
| `paint` columns | `process.stdout.columns ?? 100` | 100 |
| `frameWithHits` width | `Math.max(24, Math.min(columns ?? process.stdout.columns ?? 100, 120))` | 100, clamped 24..120 |
| `lastWidth` | `Math.max(24, Math.min(columns, 120))` | initial 100 |
| `lastNarrow` | `lastWidth < 72` | initial false |
| clamp budget | `Math.max(1, rows - 1)`; rows undefined → no clamp | |
| resize | `stdout.on('resize')` → draw (non-fresh) | |

Width affects: narrow labels (<72), bar widths, account name/status widths, inline-vs-wrapped reasons, detail line cap (4/3/2), keybar wrap, clip of every line. Rows affects only the clamp (tail reserved).

---

## Go porting notes

**Needs `golang.org/x/term`:** `term.MakeRaw(int(os.Stdin.Fd()))` / `term.Restore(fd, oldState)` (TS: `setRawMode(true/false)` only when stdin is a TTY → `term.IsTerminal(fd)`); `term.GetSize(int(os.Stdout.Fd()))` for columns/rows with fallbacks 100/40 on error. SIGWINCH via `signal.Notify(ch, syscall.SIGWINCH)` → non-fresh draw. SIGINT → leave (exit 0). Restore must run on every exit path: wrap in a single `restore()` called from quit, signal, fatal draw, and a top-level `defer`+`recover` (the `uncaughtException` analogue). Consider also SIGTERM/SIGHUP → restore (TS doesn't; note as deliberate divergence).

**stdin reader goroutine** reads chunks (`os.Stdin.Read(buf)`), and per chunk must reproduce TS semantics:
- Extract SGR mouse reports `\x1b\[<(\d+);(\d+);(\d+)([Mm])` (same regexp in Go `regexp`), act on the first 8 presses (`M`), ignore releases (`m`), strip all reports, pass any remainder as one key string.
- Otherwise the whole chunk is the key: `"\x03"`/`"q"` quit; `"\x1b[A"` up, `"\x1b[B"` down; bare `"\x1b"` closes help; single printable chars as in §5. Multi-char chunks match nothing (pastes are no-ops). TS does not reassemble split escape sequences; a Go reader may (improvement) but keep whole-chunk-equality for keys so `"jj"` stays a no-op, or knowingly diverge.
- Keystroke/mouse handlers mutate view state; all draws go through one serializing draw goroutine/channel (`{fresh bool}`), mirroring the `pending` promise chain. View state must be owned by one goroutine (send events to the loop rather than mutating from the reader) to avoid races the single-threaded TS never had.
- Ticker `time.NewTicker(max(2,interval) s)` — the loop blocks until quit (the not-unref'd-interval rule).

**Proposed `internal/watch` decomposition** (pure first, I/O last):
- `ansi.go` (pure): `dim/bold/paint/invert/osc8`, `VisibleLength` (OSC then CSI strip, rune count), `Clip` (byte-compatible incl. the scan-to-`m` quirk), `WrapText`. 
- `frame.go` (pure): `ViewState`, `LineHit`, `FrameWithHits(state, view, columns, rows int) (string, []*LineHit)`, `Frame`, `clampAndClip`, `helpLines`, `allocationLines`/`bar`/`barCells`/`usedBar`, `accountLines`, `programLines`, `serviceLine`, `UntilLabel`, `AccountsLabel`, `elapsed`, `percent` (via `jsnum.ToFixed`, `jsnum.RoundHalfUp`, `jsnum.String`), constants table. Take a `*time.Location` (or format the header clock outside) so tests pin TZ.
- `keybar.go` (pure): `keys` table, `keybarLayout`, `KeybarLines`, `KeybarKeyAt`.
- `input.go` (pure parsing): `ParseChunk(chunk string) (mouse []MouseEvent, rest string)` with the 8-press cap; `ChildReason`; and `handle` split into a pure `decideKey(key, view, programs, state) → intent` (e.g. `SetMode`, `ArmStop`, `Spawn{argv}`, `Interrupt{program}`, `Message{...}`) plus an impure executor — so the confirmation/cancel matrix is unit-testable without control.json.
- `run.go` (I/O): `Watch(ctx, interval)` — terminal enter/restore bytes, raw mode, signals, ticker, stdin goroutine, draw serializer, `paint` (`\x1b[H` + lines`\x1b[K` joined `\r\n` + `\x1b[0J`), `drawFailed`, executor calling `keys.*` setters, `orca.Client.InterruptRunner` / `ReleaseLeftover` (writable client), `lock.Holder`, `syscall.Kill(-pid, SIGTERM)`, detached `os.Executable() tick|start <name>`, `open <url>`, and `state.Collector.Collect(ctx, sink, probeMaxAge)`.
- Wire `drovr watch [seconds]` in `internal/cli` + help registry entry (copy verbatim from `src/help.ts`).

Open points for the plan author: (1) record hooks don't exist yet — decide TS-first `record()` additions vs. hand-ported tests over `state.Build`; (2) pin `TZ` for any recorded frame; (3) whether to keep bug-compatible quirks (NaN interval, selected = -1 with no programs, SIGTERM leaves terminal dirty, `<`/`>` in `off` mode writes an `off` ceiling, setter throws kill watch via `die`, clip's OSC-8 scan) or fix them TS-first.
