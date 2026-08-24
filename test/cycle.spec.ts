import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stallAction } from '../src/cycle.ts';

const MIN = 60_000;
const base = { hasReport: false, nudgesSent: 0, nudgeAfterMs: 10 * MIN, maxNudges: 3 };

test('a working runner is left alone however long it has been going', () => {
  assert.equal(stallAction({ ...base, state: 'working', idleForMs: 9 * 60 * MIN }), 'wait');
});

test('an idle runner is given the full grace period before anything is sent', () => {
  // Craig interrupting a cycle to talk to it is ordinary. Nudging on the first idle
  // poll would talk over him mid-conversation.
  assert.equal(stallAction({ ...base, state: 'idle', idleForMs: 9 * MIN }), 'wait');
});

test('an idle runner past the grace period with no report is nudged', () => {
  // aice-x lost its opening turn to a 529 and sat idle for eight hours; sunnyt
  // answered Craig and never resumed. Both are this case.
  assert.equal(stallAction({ ...base, state: 'idle', idleForMs: 10 * MIN }), 'nudge');
});

test('a runner that already reported is never nudged, however long it idles', () => {
  // It idles at the prompt by design once its report is written — that is the
  // release path, not a stall.
  assert.equal(
    stallAction({ ...base, hasReport: true, state: 'idle', idleForMs: 9 * 60 * MIN }),
    'wait',
  );
});

test('nudging is bounded — a runner that ignores every nudge is given up on', () => {
  assert.equal(stallAction({ ...base, state: 'idle', idleForMs: 10 * MIN, nudgesSent: 3 }), 'give-up');
});

test('the last nudge is still spent before giving up', () => {
  assert.equal(stallAction({ ...base, state: 'idle', idleForMs: 10 * MIN, nudgesSent: 2 }), 'nudge');
});

test('a runner blocked on a dialog is not nudged — a prompt cannot answer a dialog', () => {
  // `blocked` needs Craig to answer something in the pane. Prompting past it just
  // queues text behind the dialog and reports progress that did not happen.
  assert.equal(stallAction({ ...base, state: 'blocked', idleForMs: 60 * MIN }), 'wait');
});
