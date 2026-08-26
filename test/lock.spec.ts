import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, heldBy, heldForMs, holder, release } from '../src/lock.ts';

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), 'drovr-lock-')), 'x.lock');

/** A pid that cannot be alive: process.kill reports ESRCH for it. */
const DEAD_PID = 2 ** 22;

test('an unheld lock is acquirable and reports no holder', () => {
  const path = lockPath();
  assert.equal(holder(path), null);
  assert.equal(heldBy(path), null);
  assert.equal(acquire(path), true);
  assert.equal(holder(path), process.pid);
});

test('acquire refuses while a live process holds it, and release frees it', () => {
  const path = lockPath();
  acquire(path);
  assert.equal(acquire(path), false, 'the same live holder does not get it twice');
  release(path);
  assert.equal(holder(path), null);
});

test('a lock held by a dead process is reclaimed', () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, at: Date.now() }), 'utf8');
  assert.equal(holder(path), null, 'a dead holder is not a holder');
  assert.equal(acquire(path), true);
});

test('release only removes a lock this process owns', () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: process.pid + 1, at: Date.now() }), 'utf8');
  release(path);
  assert.notEqual(readFileSync(path, 'utf8').trim(), '', "another process's lock is left alone");
});

/**
 * The age is what separates "busy" from "wedged", which is the whole reason the format
 * gained a timestamp: lock.ts will not reclaim a lock from a live holder, so reporting
 * how long it has been held is the only thing that makes the state visible.
 */
test('heldForMs reports how long the live holder has held it', () => {
  const path = lockPath();
  const at = Date.now() - 90_000;
  writeFileSync(path, JSON.stringify({ pid: process.pid, at }), 'utf8');
  const held = heldForMs(path, at + 90_000);
  assert.equal(held, 90_000);
});

test('heldForMs is null when nothing holds the lock', () => {
  const path = lockPath();
  assert.equal(heldForMs(path), null);
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, at: Date.now() - 90_000 }), 'utf8');
  assert.equal(heldForMs(path), null, 'a dead holder has no hold to measure');
});

/**
 * A lock written by the previous build is a bare pid, and it can still be on disk when
 * this one starts — the file drovr most wants to reason about is the one it did not write.
 * An unknown age must read as unknown, never as zero, or a legacy lock would look
 * freshly taken forever.
 */
test('a bare-pid lock from the previous format still identifies its holder', () => {
  const path = lockPath();
  writeFileSync(path, `${process.pid}\n`, 'utf8');
  assert.equal(holder(path), process.pid);
  assert.equal(acquire(path), false, 'a live legacy holder still blocks acquisition');
  assert.equal(heldForMs(path), null, 'its age is unknown, not zero');
});

test('a bare-pid lock from a dead process is reclaimed like any other', () => {
  const path = lockPath();
  writeFileSync(path, `${DEAD_PID}\n`, 'utf8');
  assert.equal(acquire(path), true);
  const age = heldForMs(path);
  // A bound, not an equality: asserting exactly 0 here passes or fails on whether a
  // millisecond ticked between the write and the read.
  assert.ok(age !== null && age < 1_000, `now held by us with a known age, got ${String(age)}`);
});

test('a garbage lock file is treated as unheld rather than throwing', () => {
  const path = lockPath();
  writeFileSync(path, 'not a pid and not json\n', 'utf8');
  assert.equal(holder(path), null);
  assert.equal(acquire(path), true);
});

test('acquire writes a timestamp, so the next reader can age it', () => {
  const path = lockPath();
  acquire(path);
  const held = heldBy(path);
  assert.equal(held?.pid, process.pid);
  assert.ok(held?.at !== null && typeof held?.at === 'number', 'at is recorded');
});
