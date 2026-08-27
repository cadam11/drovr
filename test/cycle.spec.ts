import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stallAction } from '../src/cycle.ts';

const MIN = 60_000;
const base = {
  hasReport: false,
  nudgesSent: 0,
  nudgeAfterMs: 10 * MIN,
  maxNudges: 3,
  blockedForMs: 0,
  blockedAlertAfterMs: 20 * MIN,
  alerted: false,
};

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
  // queues text behind the dialog and reports progress that did not happen. It is asked
  // about instead, once, past blockedAlertAfterMs — see the alert tests below.
  assert.equal(
    stallAction({ ...base, state: 'blocked', idleForMs: 60 * MIN, alerted: true }),
    'wait',
  );
});

/**
 * A blocked runner is waiting on a dialog only Craig can clear — a permission prompt, a
 * trust question. It must never be nudged, because a prompt queues up behind the dialog
 * rather than clearing it. But "never nudged" was implemented as "never anything": every
 * non-idle state fell through to `wait`, so the one state that *requires* a human was the
 * one state drovr never reported.
 *
 * Measured 2026-08-27: sunnyt sat at a bash-permission prompt for most of a 12.8h run.
 * drovr saw `blocked`, logged it to a file nobody reads, held the pane and a concurrency
 * slot for the full maxCycleHours, then recorded the cycle as a crash. Craig found out by
 * looking. Meanwhile an unanswered *ask* — a softer, asynchronous question — texts him
 * after 240 minutes.
 */
const blocked = (overrides: Partial<Parameters<typeof stallAction>[0]> = {}) =>
  stallAction({
    state: 'blocked',
    hasReport: false,
    idleForMs: 0,
    nudgesSent: 0,
    nudgeAfterMs: 600_000,
    maxNudges: 3,
    blockedForMs: 0,
    blockedAlertAfterMs: 1_200_000,
    alerted: false,
    ...overrides,
  });

test('a runner blocked past the threshold asks for a human', () => {
  assert.equal(blocked({ blockedForMs: 1_200_000 }), 'alert');
});

test('a runner only just blocked is left alone', () => {
  assert.equal(blocked({ blockedForMs: 60_000 }), 'wait');
});

test('a blocked runner is alerted once, not every poll', () => {
  assert.equal(blocked({ blockedForMs: 4 * 3_600_000, alerted: true }), 'wait');
});

test('a blocked runner is never nudged, however long it sits there', () => {
  // The nudge budget is untouched and the idle clock is irrelevant: a prompt sent into a
  // dialog queues up behind it, so nudging is the one thing that must not happen here.
  for (const blockedForMs of [0, 1_200_000, 12 * 3_600_000]) {
    assert.notEqual(blocked({ blockedForMs }), 'nudge');
    assert.notEqual(blocked({ blockedForMs }), 'give-up');
  }
});

test('a blocked runner that has written its report is finished, not blocked', () => {
  assert.equal(blocked({ blockedForMs: 4 * 3_600_000, hasReport: true }), 'wait');
});

test('alerting is only for blocked — an idle runner is still nudged', () => {
  assert.equal(
    stallAction({
      state: 'idle',
      hasReport: false,
      idleForMs: 900_000,
      nudgesSent: 0,
      nudgeAfterMs: 600_000,
      maxNudges: 3,
      blockedForMs: 0,
      blockedAlertAfterMs: 1_200_000,
      alerted: false,
    }),
    'nudge',
  );
});
