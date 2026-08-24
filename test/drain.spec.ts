import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseControl } from '../src/control.ts';
import { parseIntent, type Action } from '../src/intents.ts';
import { applyIntent } from '../src/tick.ts';

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-drain-'));
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

/** A note as Craig would leave it on the panel, stamped far enough out to be live. */
const intent = (body: string): Action => {
  const now = Date.now();
  const stamp = new Date(now + 600_000).toISOString();
  const parsed = parseIntent(`drovr-intent v1 ${body} expires=${stamp}`, 'n-1', now);
  assert.ok(!('rejected' in parsed), `parser refused "${body}"`);
  return parsed.action;
};

test('a mode intent reaches control.json through the same writer the TUI uses', () => {
  const path = scratch();
  assert.equal(applyIntent(path, intent('mode away')), 'mode → away');
  assert.equal(read(path).mode, 'away');
});

test('a pause intent lands the hours it named', () => {
  const path = scratch();
  assert.equal(applyIntent(path, intent('pause 6h')), 'paused 6h');
  const until = read(path).pauseUntil;
  assert.ok(until !== null);
  const hours = (Date.parse(until) - Date.now()) / 3_600_000;
  assert.ok(hours > 5.9 && hours < 6.1, `expected about 6h, got ${hours}`);
});

test('a reserve intent moves the ceiling of the mode in force', () => {
  const path = scratch();
  applyIntent(path, intent('reserve 0.1'));
  assert.equal(read(path).ceilings.normal!.weekly.toFixed(2), '0.45');
});

test('a concurrency intent moves the cap', () => {
  const path = scratch();
  applyIntent(path, intent('concurrency 3'));
  assert.equal(read(path).maxConcurrentCycles, 5);
});

test('enable and disable name the state rather than flipping it', () => {
  const path = scratch();
  applyIntent(path, intent('disable sunnyt'));
  assert.equal(read(path).programs[0]!.enabled, false);
  applyIntent(path, intent('disable sunnyt'));
  assert.equal(read(path).programs[0]!.enabled, false);
  applyIntent(path, intent('enable sunnyt'));
  assert.equal(read(path).programs[0]!.enabled, true);
});

test('a priority intent moves that program only', () => {
  const path = scratch();
  applyIntent(path, intent('priority joinery -3'));
  assert.equal(read(path).programs[1]!.priority, -1);
  assert.equal(read(path).programs[0]!.priority, 0);
});

test('an intent naming a program that is gone is refused, leaving the file untouched', () => {
  const path = scratch();
  const before = readFileSync(path, 'utf8');
  assert.throws(() => applyIntent(path, intent('priority ghost 1')), /no program named/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('an applied intent leaves the file valid for the next launchd tick', () => {
  const path = scratch();
  for (const body of ['mode low', 'pause 2h', 'reserve -0.1', 'concurrency 1', 'disable joinery']) {
    applyIntent(path, intent(body));
  }
  assert.doesNotThrow(() => read(path));
});
