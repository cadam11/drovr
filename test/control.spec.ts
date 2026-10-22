import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseControl } from '../src/control.ts';

test('a program may name an asks file beside, or instead of, an aice page', () => {
  const control = parseControl({ programs: [{ name: 'p', cwd: '/tmp/p', asksFile: '.drovr/asks.md' }] });
  assert.equal(control.programs[0].asksFile, '.drovr/asks.md');
  assert.equal(control.programs[0].aice, null);
});

test('an older control file with no asksFile reads it as null', () => {
  const control = parseControl({ programs: [{ name: 'p', cwd: '/tmp/p', aice: null }] });
  assert.equal(control.programs[0].asksFile, null);
});
