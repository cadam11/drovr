import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adjustConcurrency,
  cycleMode,
  cyclePause,
  nudgePriority,
  nudgeReserve,
  pauseForHours,
  setEnabled,
  setMode,
  setReserve,
  toggleEnabled,
} from '../src/keys.ts';
import { orderCeilings, parseControl } from '../src/control.ts';

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-'));
  const path = join(dir, 'control.json');
  writeFileSync(
    path,
    JSON.stringify({
      mode: 'normal',
      pauseUntil: null,
      programs: [
        { name: 'sunnyt', cwd: '/s', priority: 0 },
        { name: 'joinery', cwd: '/j', priority: 2 },
      ],
    }),
  );
  return path;
};

const read = (path: string) => parseControl(JSON.parse(readFileSync(path, 'utf8')));

test('mode cycles through every setting and wraps', () => {
  const path = scratch();
  assert.equal(cycleMode(path, 'normal').message, 'mode → away');
  assert.equal(cycleMode(path, 'away').message, 'mode → off');
  assert.equal(cycleMode(path, 'off').message, 'mode → low');
  assert.equal(read(path).mode, 'low');
});

test('pause toggles rather than stacking', () => {
  const path = scratch();
  cyclePause(path, null);
  const paused = read(path).pauseUntil;
  assert.ok(paused !== null && Date.parse(paused) > Date.now());
  cyclePause(path, paused);
  assert.equal(read(path).pauseUntil, null);
});

test('an expired pause starts a fresh one instead of clearing', () => {
  const path = scratch();
  const stale = new Date(Date.now() - 60_000).toISOString();
  cyclePause(path, stale);
  const paused = read(path).pauseUntil;
  assert.ok(paused !== null && Date.parse(paused) > Date.now());
});

test('toggling enabled flips and persists', () => {
  const path = scratch();
  assert.match(toggleEnabled(path, 'sunnyt').message, /disabled/);
  assert.equal(read(path).programs[0]!.enabled, false);
  assert.match(toggleEnabled(path, 'sunnyt').message, /enabled/);
  assert.equal(read(path).programs[0]!.enabled, true);
});

test('priority is clamped so a held key cannot run away', () => {
  const path = scratch();
  for (let press = 0; press < 20; press += 1) nudgePriority(path, 'joinery', -1);
  assert.equal(read(path).programs[1]!.priority, -9);
});

test('concurrency stays within one and eight', () => {
  const path = scratch();
  for (let press = 0; press < 20; press += 1) adjustConcurrency(path, -1);
  assert.equal(read(path).maxConcurrentCycles, 1);
  for (let press = 0; press < 20; press += 1) adjustConcurrency(path, 1);
  assert.equal(read(path).maxConcurrentCycles, 8);
});

test('editing an unknown program is refused, leaving the file untouched', () => {
  const path = scratch();
  const before = readFileSync(path, 'utf8');
  assert.throws(() => toggleEnabled(path, 'nope'), /no program named/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('every write leaves the file valid for the next launchd tick', () => {
  const path = scratch();
  cycleMode(path, 'normal');
  nudgePriority(path, 'sunnyt', 1);
  toggleEnabled(path, 'joinery');
  adjustConcurrency(path, 1);
  assert.doesNotThrow(() => read(path));
});

test('reserve is the inverse of the ceiling programs may spend to', () => {
  const path = scratch();
  setReserve(path, 'normal', 0.6);
  assert.equal(read(path).ceilings.normal!.weekly.toFixed(2), '0.40');
});

test('the 5h ceiling keeps its ratio, so a tighter reserve cannot widen bursts', () => {
  const path = scratch();
  // Defaults are weekly 0.55 / session 0.40, a ratio of ~0.727.
  setReserve(path, 'normal', 0.6);
  const after = read(path).ceilings.normal!;
  assert.equal((after.session / after.weekly).toFixed(2), '0.73');
  assert.ok(after.session < 0.4);
});

test('reserve is clamped, so a held key cannot hand programs everything', () => {
  const path = scratch();
  setReserve(path, 'normal', -5);
  assert.equal(read(path).ceilings.normal!.weekly.toFixed(2), '0.95');
  setReserve(path, 'normal', 5);
  assert.equal(read(path).ceilings.normal!.weekly.toFixed(2), '0.05');
});

test('reserve applies per mode, leaving the others alone', () => {
  const path = scratch();
  setReserve(path, 'away', 0.1);
  const ceilings = read(path).ceilings;
  assert.equal(ceilings.away!.weekly.toFixed(2), '0.90');
  assert.equal(ceilings.normal!.weekly.toFixed(2), '0.55');
});

test('setMode names a target rather than stepping to the next one', () => {
  const path = scratch();
  assert.equal(setMode(path, 'away').message, 'mode → away');
  assert.equal(read(path).mode, 'away');
  assert.equal(setMode(path, 'away').message, 'mode → away');
  assert.equal(read(path).mode, 'away');
});

test('an unknown mode is refused, leaving the file untouched', () => {
  const path = scratch();
  const before = readFileSync(path, 'utf8');
  assert.throws(() => setMode(path, 'turbo'), /unknown mode/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('pauseForHours pauses for the hours asked for, not the next step up', () => {
  const path = scratch();
  pauseForHours(path, 5);
  const until = read(path).pauseUntil;
  assert.ok(until !== null);
  const hours = (Date.parse(until) - Date.now()) / 3_600_000;
  assert.ok(hours > 4.9 && hours < 5.1, `expected about 5h, got ${hours}`);
});

test('setEnabled sets the state named, so a repeat is not a flip back', () => {
  const path = scratch();
  assert.match(setEnabled(path, 'sunnyt', false).message, /disabled/);
  assert.equal(read(path).programs[0]!.enabled, false);
  setEnabled(path, 'sunnyt', false);
  assert.equal(read(path).programs[0]!.enabled, false);
  setEnabled(path, 'sunnyt', true);
  assert.equal(read(path).programs[0]!.enabled, true);
});

test('setEnabled on an unknown program is refused, leaving the file untouched', () => {
  const path = scratch();
  const before = readFileSync(path, 'utf8');
  assert.throws(() => setEnabled(path, 'nope', false), /no program named/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('nudgeReserve moves the reserve by the delta, against the mode in force', () => {
  const path = scratch();
  // normal defaults to a weekly ceiling of 0.55, so the reserve starts at 0.45.
  nudgeReserve(path, 0.1);
  assert.equal(read(path).ceilings.normal!.weekly.toFixed(2), '0.45');
  nudgeReserve(path, -0.2);
  assert.equal(read(path).ceilings.normal!.weekly.toFixed(2), '0.65');
});

test('nudgeReserve is refused while the mode is off, rather than writing a dead ceiling', () => {
  const path = scratch();
  setMode(path, 'off');
  const before = readFileSync(path, 'utf8');
  assert.throws(() => nudgeReserve(path, 0.1), /mode is off/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

/**
 * These setters are the only writers of these fields, so their bounds are the only
 * bounds there are. Checked in both directions: the widest accepted value and the
 * first refused one.
 */
test('pause: the setter accepts 1h-72h and refuses either side', () => {
  const path = scratch();
  assert.doesNotThrow(() => pauseForHours(path, 1));
  assert.doesNotThrow(() => pauseForHours(path, 72));
  assert.throws(() => pauseForHours(path, 0), /out of range/);
  assert.throws(() => pauseForHours(path, 73), /out of range/);
});

test('reserve: the setter accepts +/-0.95 and refuses either side', () => {
  const path = scratch();
  assert.doesNotThrow(() => nudgeReserve(path, 0.95));
  assert.doesNotThrow(() => nudgeReserve(path, -0.95));
  assert.throws(() => nudgeReserve(path, 0.96), /out of range/);
  assert.throws(() => nudgeReserve(path, -0.96), /out of range/);
});

test('mode: the setter accepts every known mode and refuses the rest', () => {
  const path = scratch();
  for (const mode of ['off', 'low', 'normal', 'away']) {
    assert.doesNotThrow(() => setMode(path, mode));
  }
  assert.throws(() => setMode(path, 'turbo'), /unknown mode/);
});

test('concurrency and priority: the widest delta still lands in range', () => {
  const path = scratch();
  adjustConcurrency(path, 7);
  assert.equal(read(path).maxConcurrentCycles, 8);
  adjustConcurrency(path, -7);
  assert.equal(read(path).maxConcurrentCycles, 1);
  nudgePriority(path, 'sunnyt', 9);
  assert.equal(read(path).programs[0]!.priority, 9);
  nudgePriority(path, 'sunnyt', -9);
  assert.equal(read(path).programs[0]!.priority, 0);
});

test('a control write is staged and renamed, so no reader can see a half-written file', () => {
  const path = scratch();
  const dir = join(path, '..');
  setMode(path, 'away');
  const strays = readdirSync(dir).filter((entry) => entry.endsWith('.tmp'));
  assert.deepEqual(strays, [], `staging files left behind: ${strays.join(', ')}`);
  assert.equal(read(path).mode, 'away');
});

test('a write refused before it starts leaves no staging file and no change', () => {
  const path = scratch();
  const dir = join(path, '..');
  const before = readFileSync(path, 'utf8');
  assert.throws(() => setEnabled(path, 'nope', false), /no program named/);
  assert.deepEqual(readdirSync(dir).filter((entry) => entry.endsWith('.tmp')), []);
  assert.equal(readFileSync(path, 'utf8'), before);
});

/**
 * The rename is the step that can fail with a staging file already on disk, so the
 * cleanup path only runs if the failure happens there. macOS's immutable flag makes
 * the destination unreplaceable while leaving it readable, which is exactly that
 * shape: the read succeeds, the staging write succeeds, the rename gets EPERM.
 */
test('a write that fails at the rename cleans up its staging file', () => {
  const path = scratch();
  const dir = join(path, '..');
  const before = readFileSync(path, 'utf8');
  execFileSync('chflags', ['uchg', path]);

  try {
    assert.throws(() => setMode(path, 'away'), /EPERM/);
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry.endsWith('.tmp')),
      [],
      'the staging file survived a failed rename',
    );
    assert.equal(readFileSync(path, 'utf8'), before, 'the control file was damaged');
  } finally {
    execFileSync('chflags', ['nouchg', path]);
  }
});

const CEILINGS = () => ({
  low: { weekly: 0.65, session: 0.65 },
  normal: { weekly: 0.55, session: 0.4 },
  away: { weekly: 0.85, session: 0.6 },
});

test('ceilings come back ordered low <= normal <= away, so the names mean something', () => {
  // Measured live 2026-08-25: repeated reserve edits had left low at session 0.65
  // against away's 0.60, making `drovr mode low` — what you reach for when nervous —
  // the most permissive setting of the three.
  const out = orderCeilings(CEILINGS(), 'normal');
  assert.ok(out.low!.session <= out.normal!.session);
  assert.ok(out.normal!.session <= out.away!.session);
  assert.ok(out.low!.weekly <= out.normal!.weekly);
  assert.ok(out.normal!.weekly <= out.away!.weekly);
});

test('the mode just edited is authoritative — the others move around it', () => {
  // Overriding the number Craig just set would make the control file argue with him.
  const out = orderCeilings({ ...CEILINGS(), low: { weekly: 0.2, session: 0.2 } }, 'low');
  assert.deepEqual(out.low, { weekly: 0.2, session: 0.2 });
});

test('raising a tight mode past a looser one lifts the looser one, not itself', () => {
  const out = orderCeilings({ ...CEILINGS(), low: { weekly: 0.9, session: 0.9 } }, 'low');
  assert.deepEqual(out.low, { weekly: 0.9, session: 0.9 });
  assert.equal(out.normal!.session, 0.9);
  assert.equal(out.away!.session, 0.9);
});

test('lowering a loose mode below a tighter one pulls the tighter one down with it', () => {
  const out = orderCeilings({ ...CEILINGS(), away: { weekly: 0.3, session: 0.3 } }, 'away');
  assert.deepEqual(out.away, { weekly: 0.3, session: 0.3 });
  assert.ok(out.normal!.session <= 0.3);
  assert.ok(out.low!.session <= 0.3);
});

test('an unranked mode leaves every ceiling untouched, since off spends nothing', () => {
  const input = CEILINGS();
  assert.deepEqual(orderCeilings(input, 'off'), input);
});
