import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTickFailure, failedTickText, recordTickFailure, releaseOverrunningTick } from '../src/tick.ts';
import { acquire, holder } from '../src/lock.ts';

const home = (control: unknown): { lock: string; control: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-tick-'));
  const controlPath = join(dir, 'control.json');
  writeFileSync(controlPath, JSON.stringify(control), 'utf8');
  return { lock: join(dir, 'tick.lock'), control: controlPath };
};

/**
 * The one thing the watchdog must do. Everything else it does — the log line, the text,
 * the exit code — is a courtesy; a lock that stays held is admission stopping silently,
 * which is the failure this whole path exists to end.
 */
test('an overrunning tick releases its own lock', async () => {
  const paths = home({ mode: 'normal', notifyTo: null, programs: [] });
  assert.equal(acquire(paths.lock), true);
  assert.equal(holder(paths.lock), process.pid);

  await releaseOverrunningTick(paths.lock, paths.control, 8 * 60_000);

  assert.equal(existsSync(paths.lock), false, 'the lock file is gone');
  assert.equal(holder(paths.lock), null, 'so the next firing can take it');
});

test('a sub-minute budget is reported in seconds rather than rounded to a wrong minute', async () => {
  const paths = home({ mode: 'normal', notifyTo: null, programs: [] });
  acquire(paths.lock);
  const message = await releaseOverrunningTick(paths.lock, paths.control, 30_000);
  assert.match(message, /overran 30s/, 'Math.round(0.5) would have claimed 1m');
});

test('the reported message names the budget and the pid a reader would have to kill', async () => {
  const paths = home({ mode: 'normal', notifyTo: null, programs: [] });
  acquire(paths.lock);
  const message = await releaseOverrunningTick(paths.lock, paths.control, 3 * 60_000);
  assert.match(message, /overran 3m/);
  assert.match(message, new RegExp(`pid ${process.pid}`));
  assert.match(message, /lock is released/);
});

/**
 * The release runs before anything that can throw, because an earlier draft read the
 * phone number out of control.json first — so a malformed control file would have thrown
 * inside the timer and left the lock held, which is exactly the state being fixed.
 */
test('an unreadable control file does not stop the lock being freed', async () => {
  const paths = home({ mode: 'normal', programs: [] });
  writeFileSync(paths.control, '{ not json', 'utf8');
  acquire(paths.lock);

  await releaseOverrunningTick(paths.lock, paths.control, 8 * 60_000);

  assert.equal(holder(paths.lock), null, 'the lock is freed regardless of the control file');
});

test('a missing control file does not stop the lock being freed', async () => {
  const paths = home({ mode: 'normal', programs: [] });
  acquire(paths.lock);
  await releaseOverrunningTick(paths.lock, join(paths.control, 'gone.json'), 8 * 60_000);
  assert.equal(holder(paths.lock), null);
});

/** Releasing a lock that is already gone is not an error — the watchdog can race a finish. */
test('releasing an already-free lock is quiet', async () => {
  const paths = home({ mode: 'normal', notifyTo: null, programs: [] });
  await releaseOverrunningTick(paths.lock, paths.control, 8 * 60_000);
  assert.equal(holder(paths.lock), null);
});

/**
 * The failure alert's whole job is to be sent once. Measured 2026-09-14: five consecutive
 * passes died and drovr decided nothing for an hour — but launchd fires every ten minutes,
 * so alerting per tick would have been six texts an hour for as long as it lasted.
 */
const marker = (): string => join(mkdtempSync(join(tmpdir(), 'drovr-fail-')), 'tick-failure.json');

test('only the failure that begins an episode alerts; the rest are silent', () => {
  const path = marker();
  const boom = new Error('teamclaude status did not match expected shape: [');
  assert.equal(recordTickFailure(path, Date.parse('2026-09-14T17:38:50Z'), boom), true);
  assert.equal(recordTickFailure(path, Date.parse('2026-09-14T17:48:50Z'), boom), false);
  assert.equal(recordTickFailure(path, Date.parse('2026-09-14T17:58:50Z'), boom), false);
});

test('a completed pass ends the episode, so the next outage alerts again', () => {
  const path = marker();
  assert.equal(recordTickFailure(path, Date.now(), new Error('first outage')), true);
  clearTickFailure(path);
  assert.equal(existsSync(path), false);
  assert.equal(recordTickFailure(path, Date.now(), new Error('second outage')), true);
});

test('clearing an episode that never started is not an error — most passes clear nothing', () => {
  assert.doesNotThrow(() => clearTickFailure(marker()));
});

test('the marker records when the episode began and why, for the pass that finds it', () => {
  const path = marker();
  recordTickFailure(path, Date.parse('2026-09-14T17:38:50Z'), new Error('teamclaude status did not match'));
  const noted = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(noted.at, '2026-09-14T17:38:50.000Z');
  assert.match(noted.reason, /teamclaude status did not match/);
});

/**
 * A lock screen shows one line. The status-shape failure that caused the outage carries a
 * multi-line JSON body, which would bury the one command that shows the rest.
 */
test('the text is one line and names the command that shows the rest', () => {
  const shapeError = new Error(
    'teamclaude status did not match expected shape: [\n  {\n    "code": "invalid_type",\n' +
      '    "path": [ "accounts", 2, "pausedUntil" ]\n  }\n]',
  );
  const text = failedTickText(shapeError);
  assert.equal(text.includes('\n'), false);
  assert.match(text, /no program can start/);
  assert.match(text, /teamclaude status did not match expected shape/);
  assert.match(text, /tail -40 ~\/\.drovr\/logs\/tick\.err/);
  assert.equal(text.includes('"code"'), false);
});

test('the text survives an error whose message is enormous, or not an Error at all', () => {
  assert.ok(failedTickText(new Error('x'.repeat(5_000))).length < 260);
  assert.match(failedTickText('teamclaude is not on PATH'), /teamclaude is not on PATH/);
});
