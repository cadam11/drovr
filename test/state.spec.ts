import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { account, control, healthy, NOW, status } from './fixtures.ts';

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

/**
 * One account, deliberately thin on session headroom, funds one cycle's worth
 * of the tightest bucket but not two once the first is projected as running.
 * This is the sequential-admission projection restored per plan ruling 1
 * (mirroring src/watch.ts's programLines) — without it, both programs would
 * see the raw pool independently and both report GO.
 */
const scarcePool = () =>
  status([account({ name: 'a', fable: 0.2, general: 0.1, session: 0.0 })]);

const scarceInput = (programs: { name: string; cwd: string; priority: number }[]) => ({
  status: scarcePool(),
  control: control({ programs }),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 60_000 },
  previews: new Map(),
  locks: new Map(),
  asksUrls: new Map(),
  queuedIntents: [],
});

test('buildState admits only as many programs as the pool can fund, in priority order', () => {
  const state = buildState(scarceInput([
    { name: 'alpha', cwd: '/tmp/alpha', priority: 0 },
    { name: 'beta', cwd: '/tmp/beta', priority: 1 },
  ]));

  const alpha = state.programs.find((program) => program.name === 'alpha');
  const beta = state.programs.find((program) => program.name === 'beta');
  assert.equal(alpha?.verdict, 'GO');
  assert.notEqual(beta?.verdict, 'GO');
});

test('buildState changes which program wins scarce capacity when priority is reordered', () => {
  const promoted = buildState(scarceInput([
    { name: 'alpha', cwd: '/tmp/alpha', priority: 1 },
    { name: 'beta', cwd: '/tmp/beta', priority: 0 },
  ]));

  const alpha = promoted.programs.find((program) => program.name === 'alpha');
  const beta = promoted.programs.find((program) => program.name === 'beta');
  assert.equal(beta?.verdict, 'GO');
  assert.notEqual(alpha?.verdict, 'GO');
});
