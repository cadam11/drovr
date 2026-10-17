import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCaller } from '../src/hey.ts';
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

test('Review Focus 5: publishStatus with no credentials file is a reason naming hey login, never a throw', async () => {
  const home = mkdtempSync(join(tmpdir(), 'drovr-home-'));
  const result = await publishStatus({ notifyTo: 'craig' }, { host: 'mac', at: '2026-10-16T18:40:00.000Z', payload: '{}' }, defaultCaller(home));
  assert.equal(result.sent, false);
  assert.match(result.reason ?? '', /not signed in: run hey login/);
});

test('Review Focus 5: textCraig and phonePrefs without a sign-in are a reason and a warning, each naming hey login', async () => {
  const home = mkdtempSync(join(tmpdir(), 'drovr-home-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const sent = await textCraig({ notifyTo: 'craig' }, 'something broke', 'drovr on mac');
    assert.equal(sent.sent, false);
    assert.match(sent.reason ?? '', /run hey login/);
    const prefs = await phonePrefs({ notifyTo: 'craig' });
    assert.equal(prefs.away, false);
    assert.match(prefs.warning ?? '', /run hey login/);
  } finally {
    process.env.HOME = previous;
  }
});

test('Review Focus 5: publishStatus builds its default caller inside the guard, so a malformed config is a reason too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'drovr-home-'));
  mkdirSync(join(home, '.config'), { recursive: true });
  writeFileSync(join(home, '.config', 'hey.json'), '{"endpoint": 5}');
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await publishStatus({ notifyTo: 'craig' }, { host: 'mac', at: '2026-10-16T18:40:00.000Z', payload: '{}' });
    assert.equal(result.sent, false);
    assert.match(result.reason ?? '', /hey\.json/);
  } finally {
    process.env.HOME = previous;
  }
});
