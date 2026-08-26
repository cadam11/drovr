import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseOverrunningTick } from '../src/tick.ts';
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
  const paths = home({ mode: 'normal', phoneNumber: null, programs: [] });
  assert.equal(acquire(paths.lock), true);
  assert.equal(holder(paths.lock), process.pid);

  await releaseOverrunningTick(paths.lock, paths.control, 8 * 60_000);

  assert.equal(existsSync(paths.lock), false, 'the lock file is gone');
  assert.equal(holder(paths.lock), null, 'so the next firing can take it');
});

test('a sub-minute budget is reported in seconds rather than rounded to a wrong minute', async () => {
  const paths = home({ mode: 'normal', phoneNumber: null, programs: [] });
  acquire(paths.lock);
  const message = await releaseOverrunningTick(paths.lock, paths.control, 30_000);
  assert.match(message, /overran 30s/, 'Math.round(0.5) would have claimed 1m');
});

test('the reported message names the budget and the pid a reader would have to kill', async () => {
  const paths = home({ mode: 'normal', phoneNumber: null, programs: [] });
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
  const paths = home({ mode: 'normal', phoneNumber: null, programs: [] });
  await releaseOverrunningTick(paths.lock, paths.control, 8 * 60_000);
  assert.equal(holder(paths.lock), null);
});
