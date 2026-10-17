import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandOf,
  functionName,
  invokeResult,
  MessageGone,
  parseArgs,
  parseChoices,
  parseDuration,
  parsePrefsArgs,
  parseProfileArgs,
  parseStatusArgs,
  describeStatusRow,
  putStatus,
  readStatuses,
  readConfig,
  readMessage,
  readPrefs,
  send,
  setProfile,
  UsageError,
  waitForReply,
  wantsHelp,
  type Invoke,
} from '../src/hey.ts';
import type { MessageRow } from '../lambda/hey/handler.ts';

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
    choices: null,
    multi: false,
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
  const response = await send(invoke, { to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: null, choices: null, multi: false });
  assert.equal(response.id, '01A');
  assert.deepEqual(sent[0], { action: 'send', to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't' });
  assert.equal((await readMessage(invoke, 'sub', '01A')).text, 't');
  await assert.rejects(() =>
    send(async () => ({ nope: true }), { to: 'c', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: null, choices: null, multi: false }),
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

test('commandOf: a known first word is the command, anything else is a send', () => {
  assert.deepEqual(commandOf(['profile', '--from', 'sunnyt']), { command: 'profile', rest: ['--from', 'sunnyt'] });
  assert.deepEqual(commandOf(['prefs']), { command: 'prefs', rest: [] });
  assert.deepEqual(commandOf(['help', 'profile']), { command: 'help', rest: ['profile'] });
  assert.deepEqual(commandOf(['send', 'hi']), { command: 'send', rest: ['hi'] });
  assert.deepEqual(commandOf(['hi there']), { command: 'send', rest: ['hi there'] });
  assert.deepEqual(commandOf(['--wait', '5m', 'hi']), { command: 'send', rest: ['--wait', '5m', 'hi'] });
  assert.deepEqual(commandOf([]), { command: 'send', rest: [] });
});

test('choices: two to four, trimmed, non-empty, at most 24 chars, distinct', () => {
  assert.deepEqual(parseChoices(' yes , no'), ['yes', 'no']);
  assert.deepEqual(parseChoices('merge,hold,ask,skip'), ['merge', 'hold', 'ask', 'skip']);
  for (const bad of ['yes', 'a,b,c,d,e', 'yes,,no', 'yes, ', `ok,${'x'.repeat(25)}`, 'same,same', '']) {
    assert.throws(() => parseChoices(bad), UsageError, bad);
  }
});

test('args: --choices rides with --wait and is refused without it', () => {
  const parsed = parseArgs(['--wait', '5m', '--choices', 'yes,no', 'merge it?'], defaults);
  assert.deepEqual(parsed.choices, ['yes', 'no']);
  assert.equal(parseArgs(['hi'], defaults).choices, null);
  assert.throws(() => parseArgs(['--choices', 'yes,no', 'merge it?'], defaults), /--choices needs --wait/);
});

test('send carries choices only when given, and reads quiet with a default for an older lambda', async () => {
  const sent: Record<string, unknown>[] = [];
  const invoke: Invoke = async (payload) => {
    sent.push(payload);
    return { id: '01A', pk: 'sub', createdAt: 'c', waitUntil: 'w', pushed: true, quiet: true };
  };
  const input = { to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: 300, choices: ['yes', 'no'], multi: false };
  const response = await send(invoke, input);
  assert.equal(response.quiet, true);
  assert.deepEqual(sent[0], { action: 'send', to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: 300, choices: ['yes', 'no'] });
  await send(invoke, { ...input, choices: null });
  assert.equal('choices' in sent[1]!, false);
  const older = await send(async () => ({ id: '01A', pk: 'sub', createdAt: 'c', waitUntil: null, pushed: false, reason: 'no devices registered' }), { ...input, waitSeconds: null, choices: null });
  assert.equal(older.quiet, false);
});

test('readPrefs asks the prefs action and refuses a shape with unknown keys', async () => {
  const asked: Record<string, unknown>[] = [];
  const prefs = await readPrefs(async (payload) => {
    asked.push(payload);
    return { quietHours: null, away: true };
  }, 'craig');
  assert.deepEqual(prefs, { quietHours: null, away: true });
  assert.deepEqual(asked[0], { action: 'prefs', to: 'craig' });
  await assert.rejects(() => readPrefs(async () => ({ quietHours: null, away: true, theme: 'dark' }), 'craig'));
});

test('setProfile sends only the fields given and parses the profile back', async () => {
  const sent: Record<string, unknown>[] = [];
  const profile = await setProfile(async (payload) => {
    sent.push(payload);
    return { from: 'sunnyt', icon: '🦾', summary: null, color: null, updatedAt: '2026-10-16T00:00:00.000Z' };
  }, { to: 'craig', from: 'sunnyt', icon: '🦾' });
  assert.deepEqual(sent[0], { action: 'profile', to: 'craig', from: 'sunnyt', icon: '🦾' });
  assert.equal(profile.icon, '🦾');
  assert.equal(profile.summary, null);
});

test('profile args: --from is required, the three fields are optional, --to defaults', () => {
  assert.deepEqual(parseProfileArgs(['--from', 'sunnyt', '--icon', '🦾', '--summary', 'Ticket loop', '--color', '#737373'], { to: 'craig' }), {
    to: 'craig',
    from: 'sunnyt',
    icon: '🦾',
    summary: 'Ticket loop',
    color: '#737373',
  });
  assert.deepEqual(parseProfileArgs(['--from', 'sunnyt'], { to: 'craig' }), { to: 'craig', from: 'sunnyt' });
  assert.deepEqual(parseProfileArgs(['--from', 'sunnyt', '--color', ''], { to: 'craig' }), { to: 'craig', from: 'sunnyt', color: '' });
  assert.throws(() => parseProfileArgs(['--icon', '🦾'], { to: 'craig' }), /--from/);
  assert.throws(() => parseProfileArgs(['--from', 'sunnyt'], { to: null }), /--to or HEY_TO/);
  assert.throws(() => parseProfileArgs(['--from', 'sunnyt', 'stray'], { to: 'craig' }), UsageError);
  assert.throws(() => parseProfileArgs(['--from', 'sunnyt', '--bogus', 'x'], { to: 'craig' }), /unknown flag/);
});

test('prefs args: --to or the default, nothing else', () => {
  assert.deepEqual(parsePrefsArgs([], { to: 'craig' }), { to: 'craig' });
  assert.deepEqual(parsePrefsArgs(['--to', 'ann'], { to: 'craig' }), { to: 'ann' });
  assert.throws(() => parsePrefsArgs([], { to: null }), /--to or HEY_TO/);
  assert.throws(() => parsePrefsArgs(['extra'], { to: 'craig' }), UsageError);
});

test('readMessage turns the lambda\'s not_found into MessageGone; any other failure stays as it was', async () => {
  await assert.rejects(() => readMessage(async () => { throw new Error('no message 01A'); }, 'sub', '01A'), MessageGone);
  await assert.rejects(() => readMessage(async () => { throw new Error('Task timed out'); }, 'sub', '01A'), /Task timed out/);
});

test('wait: a message deleted on the phone ends the wait as deleted, not failed, however many polls remain', async () => {
  const { nowMs, sleep } = clock(0);
  let polls = 0;
  const read = async (): Promise<MessageRow> => {
    polls += 1;
    if (polls < 3) return row;
    throw new MessageGone('01A');
  };
  const outcome = await waitForReply({ read, sleep, nowMs, waitUntilMs: 600_000, onPollError: () => { throw new Error('not a poll error'); } });
  assert.deepEqual(outcome, { status: 'deleted' });
  assert.equal(polls, 3);
});

test('args: --multi rides with --choices and is refused without it; send carries it only when set', async () => {
  const parsed = parseArgs(['--wait', '5m', '--choices', 'a,b,c', '--multi', 'pick two'], defaults);
  assert.equal(parsed.multi, true);
  assert.equal(parseArgs(['--wait', '5m', '--choices', 'a,b', 'x'], defaults).multi, false);
  assert.throws(() => parseArgs(['--wait', '5m', '--multi', 'x'], defaults), /--multi needs --choices/);
  const sent: Record<string, unknown>[] = [];
  const invoke: Invoke = async (payload) => {
    sent.push(payload);
    return { id: '01A', pk: 'sub', createdAt: 'c', waitUntil: 'w', pushed: true, quiet: false };
  };
  const input = { to: 'craig', from: 'f', host: 'h', cwd: 'c', text: 't', waitSeconds: 300, choices: ['a', 'b'], multi: true };
  await send(invoke, input);
  assert.equal(sent[0]!.multi, true);
  await send(invoke, { ...input, multi: false });
  assert.equal('multi' in sent[1]!, false);
});

test('putStatus sends the status action and validates the ack; readStatuses validates the rows', async () => {
  const sent: Record<string, unknown>[] = [];
  const ack = { pk: 'sub', sk: 'status#drovr@mac', at: '2026-10-16T18:40:00.000Z', expiresAt: 1_760_000_000 };
  const statusRow = { ...ack, host: 'mac', payload: '{"mode":"normal"}' };
  const invoke: Invoke = async (payload) => {
    sent.push(payload);
    return payload.action === 'status' ? ack : [statusRow];
  };
  const input = { to: 'craig', host: 'mac', at: '2026-10-16T18:40:00.000Z', payload: '{"mode":"normal"}' };
  assert.deepEqual(await putStatus(invoke, input), ack);
  assert.deepEqual(sent[0], { action: 'status', ...input });
  assert.deepEqual(await readStatuses(invoke, 'craig'), [statusRow]);
  assert.deepEqual(sent[1], { action: 'readStatus', to: 'craig' });
  await assert.rejects(() => putStatus(async () => ({ ok: true }), input));
  await assert.rejects(() => readStatuses(async () => [{ sk: 'msg#x' }], 'craig'));
});

test('hey status: --to and --json, the HEY_TO default, and no stray words', () => {
  assert.deepEqual(parseStatusArgs(['--to', 'craig', '--json'], { to: null }), { to: 'craig', json: true });
  assert.deepEqual(parseStatusArgs([], { to: 'craig' }), { to: 'craig', json: false });
  assert.throws(() => parseStatusArgs([], { to: null }), UsageError);
  assert.throws(() => parseStatusArgs(['extra'], { to: 'craig' }), UsageError);
  assert.throws(() => parseStatusArgs(['--wait', '1m'], { to: 'craig' }), UsageError);
});

test('describeStatusRow is one line: host, age, mode, fundable, binding, program count', () => {
  const payload = JSON.stringify({
    mode: 'normal',
    capacity: { cyclesFundable: 1.3456, bindingBucket: 'session' },
    programs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
  });
  const row = { pk: 'sub', sk: 'status#drovr@mac', host: 'mac', at: '2026-10-16T18:40:00.000Z', payload, expiresAt: 1 };
  const line = describeStatusRow(row, Date.parse('2026-10-16T18:43:30.000Z'));
  assert.equal(line, 'drovr@mac  2026-10-16T18:40:00.000Z (3m ago)  normal · 1.35 cycles fundable · session binding · 3 programs');
  const off = { ...row, payload: JSON.stringify({ mode: 'off', capacity: null, programs: [] }) };
  assert.equal(describeStatusRow(off, Date.parse('2026-10-16T18:40:10.000Z')), 'drovr@mac  2026-10-16T18:40:00.000Z (0m ago)  off · no capacity figure · 0 programs');
});
