import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanAction } from '../src/tick.ts';

test('a cycle whose watcher died is re-watched while its runner is still there', () => {
  // The runner is an interactive session that outlives its watcher. Closing this as a crash
  // latched a healthy program and lost its report (measured 2026-09-12).
  assert.equal(orphanAction(true), 'reattach');
});

test('a cycle with neither watcher nor runner is closed as abandoned, never crashed', () => {
  assert.equal(orphanAction(false), 'close');
});

test('an orphaned cycle is left open while orca cannot say whether its runner is alive', () => {
  assert.equal(orphanAction(undefined), 'skip');
});
