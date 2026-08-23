import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPage } from '../src/asks.ts';

test('a prefixed page is split, since notes list resolves relative to a prefix', () => {
  // Passing the whole thing looks under <yourslug>/craig/... and reports an empty,
  // unshared page rather than failing — a silent wrong answer.
  assert.deepEqual(splitPage('craig/loop-asks.html'), { page: 'loop-asks.html', prefix: 'craig' });
});

test('a bare page keeps the caller default prefix', () => {
  assert.deepEqual(splitPage('asks.html'), { page: 'asks.html', prefix: null });
});

test('only the first segment is the prefix', () => {
  assert.deepEqual(splitPage('craig/programs/asks.html'), {
    page: 'programs/asks.html',
    prefix: 'craig',
  });
});
