import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { control, healthy, NOW } from './fixtures.ts';

const input = () => ({
  status: healthy(),
  control: control({ programs: [{ name: 'demo', cwd: '/tmp/demo' }] }),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 60_000 },
  previews: new Map(),
  locks: new Map(),
  asksUrls: new Map(),
  queuedIntents: [],
});

test('buildState stamps a versioned, ISO-timestamped envelope', () => {
  const state = buildState(input());
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.generatedAt, new Date(NOW).toISOString());
});

test('buildState reports the binding bucket, not the soonest reset', () => {
  const state = buildState(input());
  assert.ok(['fable', 'general', 'session'].includes(state.bindingBucket));
});

test('buildState rounds floats so the JSON carries no float noise', () => {
  const state = buildState(input());
  const digits = (value: number) => (String(value).split('.')[1] ?? '').length;
  assert.ok(digits(state.pool.fable) <= 4);
  assert.ok(digits(state.cyclesFundable) <= 2);
});

test('buildState allocation segments sum to the bucket total', () => {
  const state = buildState(input());
  for (const bucket of ['fable', 'general', 'session'] as const) {
    const a = state.allocation[bucket];
    const sum = a.yoursSpent + a.programsSpent + a.programsReserved
      + a.programsAvailable + a.yoursReserved;
    assert.ok(Math.abs(sum - a.total) < 0.01, `${bucket} segments ${sum} != total ${a.total}`);
  }
});

test('buildState carries one entry per configured program, with a verdict', () => {
  const state = buildState(input());
  assert.equal(state.programs.length, 1);
  assert.equal(state.programs[0]!.name, 'demo');
  assert.ok(['GO', 'WAIT', 'STOP', 'RUN'].includes(state.programs[0]!.verdict));
});

test('buildState marks the service overdue past three intervals', () => {
  const stale = { ...input(), service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 4 * 600_000 } };
  assert.equal(buildState(stale).service.overdue, true);
  assert.equal(buildState(input()).service.overdue, false);
});
