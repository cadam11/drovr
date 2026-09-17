import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import {
  childReason,
  frame,
  frameWithHits,
  keybarLines,
  untilLabel,
  visibleLength,
} from '../src/watch.ts';
import { account, control, healthy, HOUR, NOW, status } from './fixtures.ts';

const fixture = (overrides: Record<string, unknown> = {}) => buildState({
  status: healthy(), control: control(overrides), cycles: [], now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(),
});

const view = { selected: 0, message: '', confirmStop: false, confirmStart: false, help: false };

test('frame renders from a DrovrState without touching the filesystem', () => {
  const text = frame(fixture(), view);
  assert.match(text, /drovr/);
  assert.match(text, /demo/);
});

/**
 * A single-program fixture cannot tell a correct pairing from a coincidence: any
 * verdict appearing anywhere in the frame would pass. Three programs, one of them
 * disabled (so it is guaranteed a different verdict, STOP, from whatever the others
 * get), forces the assertion to actually match a verdict against its own program's
 * row rather than finding it loose anywhere in the text.
 */
test('the frame carries the verdict DrovrState holds for every program, matched by name', () => {
  const state = fixture({
    programs: [
      { name: 'alpha', cwd: '/tmp/alpha' },
      { name: 'beta', cwd: '/tmp/beta', enabled: false },
      { name: 'gamma', cwd: '/tmp/gamma' },
    ],
  });
  const text = frame(state, view);
  assert.equal(state.programs.length, 3);
  for (const program of state.programs) {
    const pattern = new RegExp(`${program.name}[^\\n]*${program.verdict}`);
    assert.match(
      text,
      pattern,
      `expected ${program.name}'s own row to carry its verdict ${program.verdict}`,
    );
  }
});

/**
 * decide()/CLAUDE.md: the three quota buckets are not a hierarchy, and reporting
 * the soonest reset across all three (rather than which one actually binds) is
 * actively misleading. Before this, nothing in the TUI ever singled a bucket out —
 * every bucket's label is on screen on every frame regardless of which one binds,
 * so matching bindingBucket against the frame text passed unconditionally. This
 * checks the frame marks exactly the row DrovrState says is binding, and no other.
 */
test('the TUI marks which bucket binds capacity, and only that one', () => {
  const state = fixture();
  const text = frame(state, view);
  const allocationRows = text.split('\n').filter((line) => /you\s*\d+%/.test(line));
  assert.equal(allocationRows.length, 3, 'expected exactly one allocation row per bucket');

  const order: ('fable' | 'general' | 'session')[] = ['fable', 'general', 'session'];
  order.forEach((bucket, index) => {
    const marked = /binds/.test(allocationRows[index]!);
    assert.equal(
      marked,
      bucket === state.bindingBucket,
      `row for ${bucket} disagrees with bindingBucket=${state.bindingBucket}`,
    );
  });
});

test('frame is pure — the same state twice gives byte-identical output', () => {
  const state = fixture();
  assert.equal(frame(state, view), frame(state, view));
});

/**
 * The bars surface is the one that most needs the coupling explanation: a session bar
 * showing free green and marked ' binds' beside a zero verdict is exactly what got
 * misread as capacity. The first version prefixed the note onto the reason, which pushed
 * the verdict past the clip and left half a sentence — the explanation relocated rather
 * than closed. Both halves have to survive at the narrowest width watch draws bars at.
 */
const coupledState = () => buildState({
  status: status([
    account({ name: 'first@example.com', fable: 0.22, general: 0.2, session: 0.98 }),
    account({ name: 'second@example.com', fable: 0.07, general: 0.08, session: 0.66 }),
    account({ name: 'fourth@example.com', fable: 0.98, general: 0.9, session: 0.0 }),
  ]),
  control: control({
    seedCycleCost: { fable: 0.025, general: 0.02, session: 0.063 },
    programs: [{ name: 'demo', cwd: '/tmp/demo' }],
  }),
  cycles: [], now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(),
});

// 60 and 72 are the two narrow paths (narrow is width < 72), where the abbreviated
// bucket labels and the smaller bar used to leave no room for the ' binds' marker and
// no room for the coupling note's tail — the same sentence telling a different story
// depending on the window.
for (const width of [60, 72, 100, 120]) {
  test(`the whole WAIT reason survives a ${width}-column frame, verdict and coupling note both`, () => {
    const text = frame(coupledState(), view, width);
    // A wrapped reason is split across lines with an indent, so the sentence is matched
    // against a plain, whitespace-collapsed projection; widths are checked on the real lines.
    const flat = text
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\s+/g, ' ');
    assert.match(flat, /the pool has room for 0\.00 cycles/, 'the verdict half was clipped');
    // 1.00, not 1.50: this fixture binds on session, where reserveCycles does not apply
    // (see decide.ts requiredCycles — a 5h window refills, so it cannot cut a cycle off).
    assert.match(flat, /a start needs 1\.00/, 'the verdict half was truncated');
    // The coupling lives on the shared capacityNote line beside the bars now, printed
    // once however many programs there are — not on every program row.
    assert.match(flat, /no account has room in all three buckets/, 'the shared note was clipped');
    assert.match(flat, /karen\.adam/, 'the note lost its last account name');
    // The keybar is drawn last, so wrapped reasons eating the frame shows up here first.
    // Narrow frames abbreviate every key to its first token, so `q quit` becomes `q`.
    assert.match(flat, width < 72 ? /(^|\s)q(\s|$)/ : /q quit/, 'the keybar was pushed out of the frame');
    assert.match(flat, /binds/, 'no allocation row is marked as the one that binds');
    for (const line of text.split('\n')) {
      assert.ok(visibleLength(line) <= width, `line over ${width} columns: ${line}`);
    }
  });
}

/**
 * The clamp used to live in watch()'s runDraw, which sliced the frame to
 * `stdout.rows - 1` after frame() had already appended the message line, the preview
 * warning and the keybar — so the three things drawn last were the three the slice
 * took first. Measured at Craig's real configuration (3 programs, asks links, recent
 * cycles) the body alone is 28-33 rows at every width watch draws, so a 24-row
 * terminal lost all of them. Pressing `x` then armed view.confirmStop with no visible
 * prompt and the next keystroke either interrupted a live cycle or silently cancelled.
 *
 * This passes a rows budget so it exercises the path watch() actually takes. The
 * earlier tests call frame(state, view, width) with no rows and could never catch it.
 */
const finished = (program: string, hoursAgo: number) => ({
  v: 1 as const,
  kind: 'delivery' as const,
  program,
  startedAt: new Date(NOW - (hoursAgo + 1) * HOUR).toISOString(),
  endedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  exit: 'seam' as const,
  poolBefore: { fable: 1, general: 1, session: 1 },
  poolAfter: { fable: 0.9, general: 0.9, session: 0.9 },
  startupTokens: null,
  yield: null,
  asksRaised: 1,
  pauseUntil: null,
  sessionId: null,
  closing: null,
});

const craigsConfiguration = () => buildState({
  status: healthy(),
  control: control({
    programs: [
      { name: 'sunnyt', cwd: '/tmp/sunnyt' },
      { name: 'joinery', cwd: '/tmp/joinery' },
      { name: 'drovr', cwd: '/tmp/drovr' },
    ],
  }),
  cycles: [
    finished('sunnyt', 0), finished('joinery', 1), finished('drovr', 2),
    finished('sunnyt', 3), finished('joinery', 4),
  ],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(),
  locks: new Map(),
  asksUrls: new Map([
    ['sunnyt', 'https://sunnyt.aicex.app/craig/loop-asks.html'],
    ['joinery', 'https://joinery.aicex.app/craig/loop-asks.html'],
    ['drovr', 'https://drovr.aicex.app/craig/loop-asks.html'],
  ]),
});

const ROWS = 24;

for (const width of [60, 80, 100, 120]) {
  test(`the x confirmation, the preview warning and the keys survive ${width}x${ROWS}`, () => {
    const confirming = {
      selected: 0,
      message: 'interrupt sunnyt? y to confirm, any other key to cancel',
      confirmStop: true,
      confirmStart: false,
      help: false,
      previewWarning: 'could not read sunnyt: agent not found',
    };
    const state = craigsConfiguration();
    assert.ok(
      frame(state, confirming, width).split('\n').length > ROWS,
      `fixture no longer overflows ${ROWS} rows, so this proves nothing`,
    );

    const lines = frame(state, confirming, width, ROWS).split('\n');
    assert.ok(lines.length <= ROWS - 1, `frame returned ${lines.length} lines for ${ROWS} rows`);
    const flat = lines.join(' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, ' ');
    assert.match(flat, /y to confirm/, 'the interrupt confirmation was clipped off the frame');
    assert.match(flat, /could not read sunnyt/, 'the preview warning was clipped off the frame');
    assert.match(
      flat,
      width < 72 ? /(^|\s)q(\s|$)/ : /q quit/,
      'the keybar was clipped off the frame',
    );
    for (const line of lines) {
      assert.ok(visibleLength(line) <= width, `line over ${width} columns: ${line}`);
    }
  });
}

/**
 * The help overlay used to early-return `helpLines().join('\n')` before frame()'s own
 * rows clamp and width clip existed, and runDraw's clamp moved into frame() without
 * that early return being updated to go through it — so `?` on a short terminal
 * scrolled the alternate screen exactly the way this file's other clamp test exists to
 * prevent for the normal frame. The `unclamped` assertion below is load-bearing: it
 * proves the help fixture genuinely overflows 23 rows, so a regression that deletes
 * the clamp cannot pass this test vacuously.
 */
test('the help screen is clamped and clipped like every other frame', () => {
  const helpView = { selected: 0, message: '', confirmStop: false, confirmStart: false, help: true };
  const width = 80;

  const unclamped = frame(fixture(), helpView, width).split('\n');
  assert.ok(
    unclamped.length > ROWS - 1,
    `help fixture no longer overflows ${ROWS - 1} rows, so this proves nothing`,
  );

  const lines = frame(fixture(), helpView, width, ROWS).split('\n');
  assert.ok(lines.length <= ROWS - 1, `help frame returned ${lines.length} lines for ${ROWS} rows`);
  for (const line of lines) {
    assert.ok(visibleLength(line) <= width, `help line over ${width} columns: ${line}`);
  }
});

/**
 * The reason/note split exists for exactly this: the pool-level context (binding
 * bucket, recovery, the coupling warning) is one fact shared by every program, and
 * it used to be rewritten near-identically on every program row. It now lives on
 * one line beside the bars it explains — however many programs are held by it.
 */
test('the pool context is printed once, however many programs share it', () => {
  const state = buildState({
    status: status([
      account({ name: 'first@example.com', fable: 0.22, general: 0.2, session: 0.98 }),
      account({ name: 'second@example.com', fable: 0.07, general: 0.08, session: 0.66 }),
      account({ name: 'fourth@example.com', fable: 0.98, general: 0.9, session: 0.0 }),
    ]),
    control: control({
      seedCycleCost: { fable: 0.025, general: 0.02, session: 0.063 },
      programs: [
        { name: 'demo', cwd: '/tmp/demo' },
        { name: 'other', cwd: '/tmp/other' },
        { name: 'third', cwd: '/tmp/third' },
      ],
    }),
    cycles: [], now: NOW,
    service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
    previews: new Map(), locks: new Map(), asksUrls: new Map(),
  });
  const flat = frame(state, view, 120)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\s+/g, ' ');
  const marker = 'no account has room in all three buckets';
  assert.equal(flat.split(marker).length - 1, 1, 'the coupling note must appear exactly once');
  // Every held program still says what it, alone, needs.
  assert.equal(flat.split('a start needs').length - 1, 3);
});

/**
 * The hit map is what the mouse resolves against, so it has to describe the frame
 * actually on screen: program blocks (wrapped details included) tagged with their
 * program, keybar rows tagged for key lookup, and everything else dead space.
 */
test('mouse hits: program rows carry their program, chrome carries nothing', () => {
  const state = buildState({
    status: healthy(),
    control: control({
      programs: [
        { name: 'alpha', cwd: '/tmp/alpha' },
        { name: 'beta', cwd: '/tmp/beta' },
      ],
    }),
    cycles: [], now: NOW,
    service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
    previews: new Map(), locks: new Map(),
    asksUrls: new Map([['alpha', 'https://drovr.example/asks.html']]),
  });
  const { text, hits } = frameWithHits(state, view, 100);
  const lines = text.split('\n');
  assert.equal(hits.length, lines.length, 'one hit entry per rendered line');
  assert.deepEqual(hits[lines.findIndex((line) => line.includes('alpha'))], { program: 0 });
  assert.deepEqual(hits[lines.findIndex((line) => line.includes('beta'))], { program: 1 });
  // The ask link is its own target: with mouse reporting on, the terminal no longer
  // opens OSC 8 links on a plain click, so a click here has to open the page itself.
  assert.deepEqual(
    hits[lines.findIndex((line) => line.includes('drovr.example/asks.html'))],
    { asks: 0 },
  );
  assert.equal(hits[0], null, 'the header is not clickable');
  assert.deepEqual(hits.at(-1), { keybar: keybarLines(100, false).length - 1 });
});

/**
 * The teamclaude dashboard and drovr watch used to be two screens for one question. The
 * frame now carries teamclaude's per-account view: every account, its three buckets with
 * their own reset countdowns, and which account the fable route will serve next.
 */
const routed = () => buildState({
  status: status(
    [
      account({ name: 'first@example.com', fable: 0.41, general: 0.49, session: 0.98 }),
      account({ name: 'second@example.com', fable: 0.05, general: 0.05, session: 0.1 }),
      account({ name: 'fourth@example.com', fable: 0.0, general: 0.0, session: 0.0 }),
    ],
    ['first@example.com'],
    'second@example.com',
  ),
  control: control(), cycles: [], now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(),
});

/** Account rows are the only lines carrying all three bucket labels; colour codes are stripped so a marker is one character. */
const accountRows = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((line) => /5h .*wk .*F7 /.test(line));

test('the state knows which account the fable route targets and which it refuses', () => {
  const state = routed();
  const by = (name: string) => state.accounts.find((entry) => entry.name === name)!;
  assert.equal(by('second@example.com').fableTarget, true);
  assert.equal(by('first@example.com').fableTarget, false);
  assert.equal(by('first@example.com').fableEligible, false);
  assert.equal(by('second@example.com').fableEligible, true);
  // No fable route declared at all is "no restriction known", not "nothing eligible".
  assert.equal(fixture().accounts[0]!.fableEligible, null);
});

test('the frame lists every account with its three buckets and their reset countdowns', () => {
  const state = routed();
  const rows = accountRows(frame(state, view, 120));
  assert.equal(rows.length, 3, 'one row per account');
  for (const entry of state.accounts) {
    const row = rows.find((line) => line.includes(entry.name))!;
    assert.ok(row, `no row for ${entry.name}`);
    assert.match(row, /5h .*wk .*F7 /, 'each row carries the session, weekly and fable buckets');
    // The fixture puts every session reset 2h out and every weekly reset 84h out.
    assert.match(row, /2h00m/);
    assert.match(row, /3d12h/);
  }
});

test('the frame marks the fable route target and the account the route refuses, and no others', () => {
  const rows = accountRows(frame(routed(), view, 120));
  const marker = (name: string) => rows.find((line) => line.includes(name))!.trimStart()[0];
  assert.equal(marker('second@example.com'), '►');
  assert.equal(marker('first@example.com'), '✗');
  assert.notEqual(marker('fourth@example.com'), '►');
  assert.notEqual(marker('fourth@example.com'), '✗');
});

test('untilLabel counts down to a reset the way teamclaude does', () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  assert.equal(untilLabel(at(59 * 60_000), NOW), '59m');
  assert.equal(untilLabel(at(4 * HOUR + 49 * 60_000), NOW), '4h49m');
  assert.equal(untilLabel(at(66 * HOUR), NOW), '2d18h');
  assert.equal(untilLabel(at(-HOUR), NOW), 'now');
  assert.equal(untilLabel(null, NOW), '—');
});

/**
 * The message line is one row, so which line of a multi-line subprocess failure it shows
 * is the whole of what the reader gets. execFile's own preamble only restates the call.
 */
test('childReason names what the child said, not the call that hit it', () => {
  const execFileError = new Error(
    'Command failed: teamclaude status --json\n' +
      'Proxy at localhost:3456 did not answer status within 5000ms.\n' +
      'The process may be overloaded or its event loop may be stalled.\n',
  );
  assert.equal(childReason(execFileError), 'Proxy at localhost:3456 did not answer status within 5000ms.');
});

test('childReason falls back to the preamble when the child said nothing else', () => {
  assert.equal(childReason(new Error('Command failed: orca terminal show')), 'Command failed: orca terminal show');
});

test('childReason survives a thrown non-Error and an empty message', () => {
  assert.equal(childReason('orca is not on PATH'), 'orca is not on PATH');
  assert.equal(childReason(new Error('')), 'unknown error');
});
