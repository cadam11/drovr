// test/panel.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { CADENCE, payload, payloadHash, shouldPublish } from '../src/panel.ts';
import { control, healthy, NOW } from './fixtures.ts';

const state = () => buildState({
  status: healthy(),
  control: control(),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
});

test('payload is parseable JSON carrying the version and ISO stamp', () => {
  const parsed = JSON.parse(payload(state()));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.generatedAt, new Date(NOW).toISOString());
});

test('payload never emits epoch millis where a timestamp is meant', () => {
  const json = payload(state());
  assert.equal(/"(generatedAt|lastTickAt|resetsAt)":\s*\d{10,}/.test(json), false);
});

test('payloadHash ignores generatedAt so an unchanged pool does not republish', () => {
  const a = payload(state());
  const later = buildState({
    status: healthy(), control: control(), cycles: [], now: NOW + 60_000,
    service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
    previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
  });
  assert.equal(payloadHash(a), payloadHash(payload(later)));
});

test('shouldPublish skips an unchanged payload under the heartbeat', () => {
  assert.equal(shouldPublish({
    previousHash: 'abc', nextHash: 'abc', cycleRunning: true,
    lastPublishedAt: NOW - 10_000, now: NOW,
  }), false);
});

test('shouldPublish emits a heartbeat past 60s even with an unchanged hash', () => {
  const base = { previousHash: 'abc', nextHash: 'abc', cycleRunning: false, now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - (CADENCE.heartbeatSeconds - 1) * 1000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - CADENCE.heartbeatSeconds * 1000 }), true);
});

test('shouldPublish honours the active cadence while a cycle runs', () => {
  const base = { previousHash: 'a', nextHash: 'b', cycleRunning: true, now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 5_000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 25_000 }), true);
});

test('shouldPublish backs off to the quiet cadence when nothing is in flight', () => {
  const base = { previousHash: 'a', nextHash: 'b', cycleRunning: false, now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 60_000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - (CADENCE.quietSeconds + 1) * 1000 }), true);
});

test('shouldPublish always publishes when nothing has been published yet', () => {
  assert.equal(shouldPublish({
    previousHash: null, nextHash: 'b', cycleRunning: false, lastPublishedAt: null, now: NOW,
  }), true);
});
