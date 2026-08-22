import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adjustConcurrency, cycleMode, cyclePause, nudgePriority, toggleEnabled } from '../src/keys.ts';
import { parseControl } from '../src/control.ts';

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
