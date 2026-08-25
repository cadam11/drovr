// test/panel.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    previousHash: 'abc', nextHash: 'abc',
    lastPublishedAt: NOW - 10_000, now: NOW,
  }), false);
});

test('shouldPublish emits a heartbeat past 40s even with an unchanged hash', () => {
  const base = { previousHash: 'abc', nextHash: 'abc', now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - (CADENCE.heartbeatSeconds - 1) * 1000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - CADENCE.heartbeatSeconds * 1000 }), true);
});

// The heartbeat check must sit ABOVE the hash comparison. This is the regression
// test for C1: a nested heartbeat only fires when the hash is unchanged, but real
// payloads (account.lastUsedAt, sessions, the session bucket) almost never hash
// identically, so that branch was dead and the 300s-old quiet cadence it replaced
// governed the panel's staleness banner regardless of agent health.
test('shouldPublish rate-limits a genuine change to activeSeconds, not the deleted quiet cadence', () => {
  const base = { previousHash: 'a', nextHash: 'b', now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 5_000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 25_000 }), true);
});

test('shouldPublish publishes a real change once enough time has passed, even while idle', () => {
  assert.equal(shouldPublish({
    previousHash: 'a', nextHash: 'b', lastPublishedAt: NOW - 41_000, now: NOW,
  }), true);
});

test('shouldPublish always publishes when nothing has been published yet', () => {
  assert.equal(shouldPublish({
    previousHash: null, nextHash: 'b', lastPublishedAt: null, now: NOW,
  }), true);
});

/**
 * panel/index.html is a third renderer, and the only one outside both tsc and this
 * suite — every divergence found on this branch was of the shape "watch.ts guards it,
 * panel/index.html doesn't". The schema version is the one part of that page with a
 * checkable numeric contract, so it gets checked here: if DrovrState.schemaVersion is
 * bumped without republishing the page, the page's own guard turns every poll into a
 * "reload" banner, and this is what says so before the publish rather than after.
 */
test('the published panel reads the same schemaVersion the payload carries', () => {
  const page = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
  const declared = /const SCHEMA_VERSION = (\d+);/.exec(page);
  assert.ok(declared !== null, 'panel/index.html no longer declares SCHEMA_VERSION');
  assert.equal(
    Number(declared[1]),
    JSON.parse(payload(state())).schemaVersion,
    'panel/index.html and DrovrState disagree on the schema version — republish the page',
  );
});
