import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { frame } from '../src/watch.ts';
import { payload } from '../src/panel.ts';
import { control, healthy, NOW } from './fixtures.ts';

const fixture = (overrides: Record<string, unknown> = {}) => buildState({
  status: healthy(), control: control(overrides), cycles: [], now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
});

const view = { selected: 0, message: '', confirmStop: false, help: false };

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
test('both renderers agree on the verdict for every program, matched by name', () => {
  const state = fixture({
    programs: [
      { name: 'alpha', cwd: '/tmp/alpha' },
      { name: 'beta', cwd: '/tmp/beta', enabled: false },
      { name: 'gamma', cwd: '/tmp/gamma' },
    ],
  });
  const text = frame(state, view);
  const json = JSON.parse(payload(state));
  assert.equal(json.programs.length, 3);
  for (const program of json.programs) {
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
  const json = JSON.parse(payload(state));
  assert.equal(json.bindingBucket, state.bindingBucket);

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
