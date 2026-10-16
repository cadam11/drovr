import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFrom } from '../src/nudge.ts';

test('a program alert is labelled by the program; a supervisor alert by drovr and the host', () => {
  assert.equal(alertFrom('sunnyt', 'mac'), 'sunnyt');
  assert.equal(alertFrom(null, 'mac'), 'drovr on mac');
});
