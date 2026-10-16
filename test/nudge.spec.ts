import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFrom, phonePrefs, textCraig } from '../src/nudge.ts';

test('a program alert is labelled by the program; a supervisor alert by drovr and the host', () => {
  assert.equal(alertFrom('sunnyt', 'mac'), 'sunnyt');
  assert.equal(alertFrom(null, 'mac'), 'drovr on mac');
});

test('a null notifyTo is a named reason on the result, not a silent drop', async () => {
  const result = await textCraig({ notifyTo: null }, 'something broke', 'drovr on mac');
  assert.equal(result.sent, false);
  assert.match(result.reason ?? '', /notifyTo/);
});

test('phonePrefs with no handle is not away and not a warning: there is no phone to ask', async () => {
  assert.deepEqual(await phonePrefs({ notifyTo: null }), { away: false, warning: null });
});
