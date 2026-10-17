import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFrom, phonePrefs, publishStatus, textCraig } from '../src/nudge.ts';

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

test('publishStatus with a null notifyTo is a named reason on the result, and quiet', async () => {
  const result = await publishStatus({ notifyTo: null }, { host: 'mac', at: '2026-10-16T18:40:00.000Z', payload: '{}' });
  assert.deepEqual(result, { sent: false, reason: 'notifyTo is null in control.json' });
});

test('a failed publish is a reason on the result, never a throw', async () => {
  const result = await publishStatus(
    { notifyTo: 'craig' },
    { host: 'mac', at: '2026-10-16T18:40:00.000Z', payload: '{}' },
    async () => {
      throw new Error('The security token included in the request is expired');
    },
  );
  assert.equal(result.sent, false);
  assert.match(result.reason ?? '', /security token/);
});

test('a successful publish reports sent', async () => {
  const result = await publishStatus(
    { notifyTo: 'craig' },
    { host: 'mac', at: '2026-10-16T18:40:00.000Z', payload: '{}' },
    async () => ({ pk: 'sub', sk: 'status#drovr@mac', at: '2026-10-16T18:40:00.000Z', expiresAt: 1 }),
  );
  assert.deepEqual(result, { sent: true, reason: null });
});
