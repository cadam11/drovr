import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAiceVersion, publishArgs } from '../src/publish-snapshot.ts';

test('publishArgs pins the only path aice accepts, with ttl and force', () => {
  const args = publishArgs('/tmp/snapshot.json');
  assert.deepEqual(args, [
    'exec', '/Users/cadam/code/drovr',
    'aice', 'publish', '/tmp/snapshot.json',
    '--as', 'assets/snapshot.json',
    '--ttl', '1d',
    '--force',
    '--agent', 'drovr',
  ]);
});

test('assertAiceVersion rejects a CLI without --ttl and names the fix', () => {
  assert.throws(() => assertAiceVersion('aice 0.11.0'), /aice update/);
  assert.throws(() => assertAiceVersion('aice 0.15.9'), /0\.16\.0/);
});

test('assertAiceVersion accepts the floor and anything above it', () => {
  assertAiceVersion('aice 0.16.0');
  assertAiceVersion('aice 0.21.3');
  assertAiceVersion('aice 1.0.0');
});

test('assertAiceVersion refuses to guess at unparseable output', () => {
  assert.throws(() => assertAiceVersion('command not found'), /could not read/i);
});
