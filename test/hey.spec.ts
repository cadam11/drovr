import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  functionName,
  invokeResult,
  parseArgs,
  parseDuration,
  readConfig,
  readMessage,
  send,
  UsageError,
  waitForReply,
  wantsHelp,
  type Invoke,
} from '../src/hey.ts';

const defaults = { to: 'craig', from: null, host: 'mac', cwd: '/Users/cadam/code/drovr' };

test('durations are seconds, minutes or hours, between one second and a day', () => {
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('24h'), 86_400);
  for (const bad of ['0s', '-5m', '25h', '30', 'soon', '1.5h', '']) {
    assert.throws(() => parseDuration(bad), UsageError, bad);
  }
});

test('args: text, --to, --from, --wait, --json, and the defaults', () => {
  const parsed = parseArgs(['--wait', '30m', '--json', 'merge it?'], defaults);
  assert.deepEqual(parsed, {
    to: 'craig',
    from: 'mac:/Users/cadam/code/drovr',
    host: 'mac',
    cwd: '/Users/cadam/code/drovr',
    text: 'merge it?',
    waitSeconds: 1800,
    json: true,
  });
  assert.equal(parseArgs(['--to', 'ann', '--from', 'relliq', '--host', 'devbox', '--cwd', 'relliq', 'hi'], defaults).from, 'relliq');
  assert.equal(parseArgs(['hi'], { ...defaults, from: 'drovr on mac' }).from, 'drovr on mac');
  assert.equal(parseArgs(['hi'], defaults).waitSeconds, null);
});

test('args: blank text, missing text, missing --to, an unknown flag and a bad --wait are usage errors', () => {
  for (const argv of [[''], ['   '], [], ['--wait', '5m'], ['--bogus', 'hi'], ['--wait', 'x', 'hi'], ['one', 'two']]) {
    assert.throws(() => parseArgs(argv, defaults), UsageError, JSON.stringify(argv));
  }
  assert.throws(() => parseArgs(['hi'], { ...defaults, to: null }), /--to or HEY_TO/);
});

test('config: a missing file is empty, a malformed one is an error, a good one supplies defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hey-'));
  assert.deepEqual(readConfig(join(dir, 'missing.json')), { to: null, from: null });
  writeFileSync(join(dir, 'good.json'), '{"to":"craig"}');
  assert.deepEqual(readConfig(join(dir, 'good.json')), { to: 'craig', from: null });
  writeFileSync(join(dir, 'bad.json'), '{"to":5}');
  assert.throws(() => readConfig(join(dir, 'bad.json')), /bad.json/);
  writeFileSync(join(dir, 'broken.json'), '{to: craig}');
  assert.throws(() => readConfig(join(dir, 'broken.json')), /broken.json is not JSON/);
});

test('--help anywhere asks for usage instead of a send', () => {
  assert.equal(wantsHelp(['--help']), true);
  assert.equal(wantsHelp(['-h']), true);
  assert.equal(wantsHelp(['--to', 'craig', 'hi', '--help']), true);
  assert.equal(wantsHelp(['hi']), false);
});

const row = { pk: 'sub', sk: 'msg#01A', createdAt: 'c', from: 'f', host: 'h', cwd: 'c', text: 't', expiresAt: 1 };

test('send and readMessage validate what the lambda returns', async () => {
  const sent: Record<string, unknown>[] = [];
  const invoke: Invoke = async (payload) => {
    sent.push(payload);
    return payload.action === 'send'
      ? { id: '01A', pk: 'sub', createdAt: 'c', waitUntil: null, pushed: false, reason: 'no devices registered' }
      : row;
  };
  const response = await send(invoke, { to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: null });
  assert.equal(response.id, '01A');
  assert.deepEqual(sent[0], { action: 'send', to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't' });
  assert.equal((await readMessage(invoke, 'sub', '01A')).text, 't');
  await assert.rejects(() =>
    send(async () => ({ nope: true }), { to: 'c', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: null }),
  );
});

const clock = (start: number) => {
  let now = start;
  return {
    nowMs: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

test('wait: the reply ends the wait, even when it is an empty string', async () => {
  const { nowMs, sleep } = clock(0);
  let polls = 0;
  const read = async () => {
    polls += 1;
    return polls < 3 ? row : { ...row, reply: '', repliedAt: 'r' };
  };
  const outcome = await waitForReply({ read, sleep, nowMs, waitUntilMs: 60_000, onPollError: () => {} });
  assert.deepEqual(outcome, { status: 'replied', reply: '', repliedAt: 'r' });
  assert.equal(polls, 3);
});

test('wait: the window lapsing is unanswered, and the poll count is bounded by it', async () => {
  const { nowMs, sleep } = clock(0);
  let polls = 0;
  const read = async () => {
    polls += 1;
    return row;
  };
  const outcome = await waitForReply({ read, sleep, nowMs, waitUntilMs: 30_000, onPollError: () => {} });
  assert.deepEqual(outcome, { status: 'unanswered' });
  assert.ok(polls <= 8, `polled ${polls} times in a 30s window`);
});

test('wait: five consecutive failed polls end the wait as failed, and a success resets the count', async () => {
  const { nowMs, sleep } = clock(0);
  const errors: string[] = [];
  let polls = 0;
  const flaky = async () => {
    polls += 1;
    if (polls === 3) return row;
    throw new Error(`boom ${polls}`);
  };
  const outcome = await waitForReply({ read: flaky, sleep, nowMs, waitUntilMs: 600_000, onPollError: (reason) => errors.push(reason) });
  assert.deepEqual(outcome, { status: 'failed', reason: 'boom 8' });
  assert.equal(polls, 8);
  assert.equal(errors.length, 6);
});

const bytes = (text: string) => new TextEncoder().encode(text);

test('invokeResult: a clean payload is parsed, a FunctionError carries the lambda message', () => {
  assert.deepEqual(invokeResult(undefined, bytes('{"id":"01A"}')), { id: '01A' });
  assert.throws(
    () => invokeResult('Unhandled', bytes('{"errorType":"HeyError","errorMessage":"no user with the handle \\"x\\""}')),
    /no user with the handle "x"/,
  );
});

test('invokeResult: a FunctionError with a payload that is not JSON still names the failure', () => {
  assert.throws(() => invokeResult('Unhandled', bytes('Task timed out after 10.00 seconds')), /Task timed out/);
  assert.throws(() => invokeResult(undefined, undefined), /empty/);
});

test('functionName is the bare name at home and the full ARN when HEY_FUNCTION names one (cross-account sender)', () => {
  assert.equal(functionName({}), 'hey');
  assert.equal(functionName({ HEY_FUNCTION: 'arn:aws:lambda:ca-central-1:000000000000:function:hey' }), 'arn:aws:lambda:ca-central-1:000000000000:function:hey');
});
