import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../src/help.ts';

test('add documents the asks file beside the aice page', () => {
  const add = COMMANDS.find((c) => c.name === 'add');
  assert.ok(add?.flags?.some((f) => f.flag === '--asks-file <path>'));
});
