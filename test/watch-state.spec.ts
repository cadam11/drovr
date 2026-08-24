import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { frame } from '../src/watch.ts';
import { payload } from '../src/panel.ts';
import { control, healthy, NOW } from './fixtures.ts';

const fixture = () => buildState({
  status: healthy(), control: control(), cycles: [], now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
});

const view = { selected: 0, message: '', confirmStop: false, help: false };

test('frame renders from a DrovrState without touching the filesystem', () => {
  const text = frame(fixture(), view);
  assert.match(text, /drovr/);
  assert.match(text, /demo/);
});

test('both renderers agree on the verdict for every program', () => {
  const state = fixture();
  const text = frame(state, view);
  const json = JSON.parse(payload(state));
  for (const program of json.programs) {
    assert.match(text, new RegExp(program.verdict), `TUI is missing ${program.verdict}`);
  }
});

test('both renderers agree on the binding bucket', () => {
  const state = fixture();
  const json = JSON.parse(payload(state));
  assert.equal(json.bindingBucket, state.bindingBucket);
  assert.match(frame(state, view), new RegExp(state.bindingBucket));
});

test('frame is pure — the same state twice gives byte-identical output', () => {
  const state = fixture();
  assert.equal(frame(state, view), frame(state, view));
});
