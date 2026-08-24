import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSettled, parseAgentStatus } from '../src/herdr.ts';

/** Recorded verbatim from `herdr agent get drovr-sunnyt`, trimmed to the fields drovr reads. */
const agentGet = (status: string) => ({
  id: 'cli:agent:get',
  result: {
    agent: {
      agent: 'claude',
      agent_status: status,
      cwd: '/Users/cadam/code/sunnyt',
      name: 'drovr-sunnyt',
      pane_id: 'w6S:p2',
      tab_id: 'w6S:t2',
      workspace_id: 'w6S',
    },
    type: 'agent_info',
  },
});

test('an idle runner reads as idle, so its pane can be released for the next cycle', () => {
  // Reading `state` instead of `agent_status` parsed clean and answered "unknown"
  // for every agent, so a finished runner was never releasable and every tick deferred.
  assert.equal(parseAgentStatus(agentGet('idle')), 'idle');
});

test('every status herdr can report survives the round trip', () => {
  for (const status of ['idle', 'working', 'blocked', 'done', 'unknown']) {
    assert.equal(parseAgentStatus(agentGet(status)), status);
  }
});

test('a payload with no agent_status throws rather than answering unknown', () => {
  // "unknown" is a real herdr status, so defaulting to it on an unrecognised shape
  // is indistinguishable from a true answer — exactly how this bug stayed silent.
  assert.throws(
    () => parseAgentStatus({ id: 'cli:agent:get', result: { agent: { state: 'idle' } } }),
    /agent_status/,
  );
});

test('a working agent is never treated as settled, so /exit is not typed into its turn', () => {
  // Cycle 7 wrote its report and kept working for another ten minutes. `/exit` sent
  // into that turn was swallowed rather than executed, and the pane was held forever.
  assert.equal(isSettled('working'), false);
});

test('an agent blocked on a dialog is not settled either — it cannot act on /exit', () => {
  assert.equal(isSettled('blocked'), false);
});

test('a finished or vanished agent is settled and can be released', () => {
  for (const state of ['idle', 'done', 'gone'] as const) {
    assert.equal(isSettled(state), true, state);
  }
});
