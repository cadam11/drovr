import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseWaitArgs, resumeWait, UsageError, waitReport, type Call } from '../src/hey.ts';

const ID = '01JA2B3C4D5E6F7G8H9JKMNPQR';
const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const WINDOW_END = '2026-10-18T11:00:00.000Z';
const clock = (iso: string): string => iso.slice(11, 16);

const row = (fields: Partial<{ waitUntil: string | null; reply: string | null; repliedAt: string | null }> = {}) => ({
  id: ID, from: 'hadrian', text: 'merge it?', createdAt: '2026-10-18T09:59:00.000Z', waitUntil: WINDOW_END, reply: null, repliedAt: null, ...fields,
});

/** A fake shim and clock: `answer(nth)` plays the read tool on its nth call; sleep advances time. */
const harness = (answer: (nth: number) => unknown) => {
  let now = T0;
  let reads = 0;
  const call: Call = async (tool, args) => {
    assert.equal(tool, 'read');
    assert.deepEqual(args, { id: ID });
    reads += 1;
    const answered = answer(reads);
    if (answered instanceof Error) throw answered;
    return answered;
  };
  const deps = { call, id: ID, sleep: async (ms: number) => void (now += ms), nowMs: () => now, onPollError: () => {} };
  return { deps, reads: () => reads };
};

const report = (resumed: Awaited<ReturnType<typeof resumeWait>>, json = false) => waitReport({ id: ID, to: 'craig', json, clock, ...resumed });

test('a reply on the second poll is printed on stdout, exit 0', async () => {
  const h = harness((nth) => (nth < 2 ? row() : row({ reply: 'yes', repliedAt: '2026-10-18T10:00:05.000Z' })));
  const resumed = await resumeWait({ ...h.deps, sliceSeconds: null });
  assert.equal(h.reads(), 2);
  assert.deepEqual(report(resumed), { code: 0, stdout: 'yes', stderr: null });
  assert.deepEqual(JSON.parse(report(resumed, true).stdout!), {
    id: ID, to: 'craig', from: 'hadrian', sentAt: '2026-10-18T09:59:00.000Z', waitUntil: WINDOW_END, quiet: null, reply: 'yes', repliedAt: '2026-10-18T10:00:05.000Z', status: 'replied',
  });
});

test('the window closing with no reply is "no reply by", exit 2', async () => {
  const h = harness(() => row({ waitUntil: '2026-10-18T10:00:20.000Z' }));
  const resumed = await resumeWait({ ...h.deps, sliceSeconds: null });
  assert.deepEqual(report(resumed), { code: 2, stdout: null, stderr: 'no reply by 10:00' });
  assert.equal(JSON.parse(report(resumed, true).stdout!).status, 'unanswered');
});

test('a window already past is one call and "no reply by", exit 2', async () => {
  const h = harness(() => row({ waitUntil: '2026-10-18T09:30:00.000Z' }));
  const resumed = await resumeWait({ ...h.deps, sliceSeconds: 600 });
  assert.equal(h.reads(), 1);
  assert.deepEqual(report(resumed), { code: 2, stdout: null, stderr: 'no reply by 09:30' });
});

test('a slice ending while the message still listens is "still waiting on", exit 2, bounded by the slice', async () => {
  const h = harness(() => row());
  const resumed = await resumeWait({ ...h.deps, sliceSeconds: 60 });
  assert.ok(h.reads() <= 14, `reads ${h.reads()}`);
  assert.deepEqual(report(resumed), { code: 2, stdout: null, stderr: `still waiting on ${ID} until 11:00` });
  assert.equal(JSON.parse(report(resumed, true).stdout!).status, 'listening');
});

test('a message sent without --wait is not listening, exit 2', async () => {
  const h = harness(() => row({ waitUntil: null }));
  const resumed = await resumeWait({ ...h.deps, sliceSeconds: null });
  assert.equal(h.reads(), 1);
  assert.deepEqual(report(resumed), { code: 2, stdout: null, stderr: `message ${ID} was sent without --wait; no reply is coming` });
});

test('a deleted message prints the deleted line, exit 2', async () => {
  const h = harness(() => new Error(`no message ${ID}`));
  const resumed = await resumeWait({ ...h.deps, sliceSeconds: null });
  assert.deepEqual(report(resumed), { code: 2, stdout: null, stderr: `message ${ID} was deleted on the phone; no reply is coming` });
  assert.equal(JSON.parse(report(resumed, true).stdout!).from, null);
});

test('a tool error on the first read throws: exit 1, one line', async () => {
  const h = harness(() => new Error('not signed in: run hey login'));
  await assert.rejects(() => resumeWait({ ...h.deps, sliceSeconds: null }), /not signed in/);
});

test('parseWaitArgs takes one id, --wait and --json; a bad id is a usage error', () => {
  assert.deepEqual(parseWaitArgs([ID]), { id: ID, sliceSeconds: null, json: false });
  assert.deepEqual(parseWaitArgs(['--wait', '9m', ID, '--json']), { id: ID, sliceSeconds: 540, json: true });
  assert.throws(() => parseWaitArgs([]), UsageError);
  assert.throws(() => parseWaitArgs([ID, ID]), UsageError);
  assert.throws(() => parseWaitArgs(['abc']), /"abc" is not a message id/);
  assert.throws(() => parseWaitArgs([ID, '--wait']), /--wait needs a value/);
  assert.throws(() => parseWaitArgs([ID, '--to', 'x']), /unknown flag --to/);
});

test('send --detach sets the window and returns at once; it needs --wait', () => {
  const defaults = { to: 'craig', from: null, host: 'h', cwd: '/w' };
  assert.equal(parseArgs(['--wait', '1h', '--detach', 'merge it?'], defaults).detach, true);
  assert.equal(parseArgs(['--wait', '1h', 'merge it?'], defaults).detach, false);
  assert.throws(() => parseArgs(['--detach', 'merge it?'], defaults), /--detach needs --wait/);
});
