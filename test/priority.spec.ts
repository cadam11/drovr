import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byPriority, effectivePriority, parseControl } from '../src/control.ts';
import { NOW } from './fixtures.ts';

const DAY = 86_400_000;

const programs = () =>
  parseControl({
    programs: [
      { name: 'joinery', cwd: '/j', priority: 2 },
      { name: 'aice-x', cwd: '/a', priority: 0 },
      { name: 'sunnyt', cwd: '/s', priority: 0, deadline: '2026-09-01' },
    ],
  }).programs;

const named = (now: number) => byPriority(programs(), now, 21).map((program) => program.name);

test('peers order alphabetically until something breaks the tie', () => {
  const far = NOW - 200 * DAY;
  assert.deepEqual(named(far), ['aice-x', 'sunnyt', 'joinery']);
});

test('a deadline inside the horizon promotes the program one step', () => {
  // 2026-08-22 is 10 days out from 2026-09-01, inside the 21-day horizon.
  assert.deepEqual(named(NOW), ['sunnyt', 'aice-x', 'joinery']);
});

test('an overdue deadline keeps the promotion rather than losing it', () => {
  assert.deepEqual(named(NOW + 30 * DAY), ['sunnyt', 'aice-x', 'joinery']);
});

test('a program without a deadline is never promoted', () => {
  const [joinery] = programs().filter((program) => program.name === 'joinery');
  assert.equal(effectivePriority(joinery!, NOW, 21), 2);
});

test('an unparseable deadline is surfaced, not silently ignored', () => {
  const [broken] = parseControl({
    programs: [{ name: 'broken', cwd: '/b', deadline: 'september' }],
  }).programs;
  assert.throws(() => effectivePriority(broken!, NOW, 21), /invalid deadline/);
});

test('ordering is deterministic when priorities tie', () => {
  const tied = parseControl({
    programs: [
      { name: 'zebra', cwd: '/z' },
      { name: 'alpha', cwd: '/a' },
    ],
  }).programs;
  assert.deepEqual(byPriority(tied, NOW, 21).map((program) => program.name), ['alpha', 'zebra']);
});
