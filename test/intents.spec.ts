// test/intents.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INTENTS_PER_TICK, isIntent, parseIntent } from '../src/intents.ts';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const at = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

test('parseIntent reads the documented vocabulary', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=${at(30)}`, 'n-1', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'pause', hours: 3 });
});

test('parseIntent reads a per-program action', () => {
  const intent = parseIntent(`drovr-intent v1 disable joinery expires=${at(30)}`, 'n-2', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'enable', program: 'joinery', enabled: false });
});

test('parseIntent rejects an expired intent rather than applying it late', () => {
  const intent = parseIntent(`drovr-intent v1 pause 1h expires=${at(-5)}`, 'n-3', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /expired/);
});

test('parseIntent rejects an unknown action instead of guessing', () => {
  const intent = parseIntent(`drovr-intent v1 detonate expires=${at(30)}`, 'n-4', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unknown action/);
});

test('parseIntent ignores an ordinary human note', () => {
  const intent = parseIntent('can we bump joinery up the queue?', 'n-5', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /not an intent/);
});

test('interrupt is deliberately not an intent in v1', () => {
  const intent = parseIntent(`drovr-intent v1 interrupt sunnyt expires=${at(5)}`, 'n-6', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /not available/);
});

test('the per-tick cap is explicit', () => {
  assert.equal(MAX_INTENTS_PER_TICK, 20);
});

// Regression: embedded expires= hijack
test('Finding 1: rejects embedded expires= that hijacks the expiry stamp', () => {
  const hijack = parseIntent(
    `drovr-intent v1 disable sunnyt-expires=${at(30)} expires=${at(-5)}`,
    'n-hijack',
    NOW,
  );
  assert.match('rejected' in hijack ? hijack.rejected : '', /expired/);
});

test('Finding 1: rejects duplicate expires= stamps', () => {
  const dup = parseIntent(
    `drovr-intent v1 pause 3h expires=${at(10)} expires=${at(20)}`,
    'n-dup',
    NOW,
  );
  assert.match('rejected' in dup ? dup.rejected : '', /more than once/);
});

// Mode action coverage
test('mode parses valid values', () => {
  const intent = parseIntent(`drovr-intent v1 mode away expires=${at(30)}`, 'n-mode', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'mode', value: 'away' });
});

test('mode rejects invalid values', () => {
  const intent = parseIntent(`drovr-intent v1 mode turbo expires=${at(30)}`, 'n-bad-mode', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /mode needs one of/);
});

test('mode rejects missing argument', () => {
  const intent = parseIntent(`drovr-intent v1 mode expires=${at(30)}`, 'n-no-mode', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /mode needs a value/);
});

test('mode rejects trailing tokens', () => {
  const intent = parseIntent(`drovr-intent v1 mode low extra expires=${at(30)}`, 'n-mode-extra', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unexpected:/);
});

// Pause action coverage with bounds
test('pause accepts 1h boundary', () => {
  const intent = parseIntent(`drovr-intent v1 pause 1h expires=${at(30)}`, 'n-pause-1', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'pause', hours: 1 });
});

test('pause accepts 72h boundary', () => {
  const intent = parseIntent(`drovr-intent v1 pause 72h expires=${at(30)}`, 'n-pause-72', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'pause', hours: 72 });
});

test('pause rejects 0h', () => {
  const intent = parseIntent(`drovr-intent v1 pause 0h expires=${at(30)}`, 'n-pause-0', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /between 1h and 72h/);
});

test('pause rejects 73h', () => {
  const intent = parseIntent(`drovr-intent v1 pause 73h expires=${at(30)}`, 'n-pause-73', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /between 1h and 72h/);
});

test('pause rejects malformed duration', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3x expires=${at(30)}`, 'n-pause-bad', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /like 3h/);
});

test('pause rejects trailing tokens', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h extra expires=${at(30)}`, 'n-pause-extra', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unexpected:/);
});

// Reserve action coverage with bounds
test('reserve accepts positive delta', () => {
  const intent = parseIntent(`drovr-intent v1 reserve 0.1 expires=${at(30)}`, 'n-reserve-pos', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'reserve', delta: 0.1 });
});

test('reserve accepts negative delta', () => {
  const intent = parseIntent(`drovr-intent v1 reserve -0.05 expires=${at(30)}`, 'n-reserve-neg', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'reserve', delta: -0.05 });
});

test('reserve accepts boundaries', () => {
  const intent = parseIntent(`drovr-intent v1 reserve 0.95 expires=${at(30)}`, 'n-reserve-max', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'reserve', delta: 0.95 });
});

test('reserve rejects out of bounds', () => {
  const intent = parseIntent(`drovr-intent v1 reserve 0.96 expires=${at(30)}`, 'n-reserve-oob', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /between -0.95 and 0.95/);
});

test('reserve rejects non-numeric', () => {
  const intent = parseIntent(`drovr-intent v1 reserve abc expires=${at(30)}`, 'n-reserve-nan', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /signed number/);
});

test('reserve rejects trailing tokens', () => {
  const intent = parseIntent(`drovr-intent v1 reserve 0.5 extra expires=${at(30)}`, 'n-reserve-extra', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unexpected:/);
});

// Concurrency action coverage with bounds
test('concurrency accepts positive delta', () => {
  const intent = parseIntent(`drovr-intent v1 concurrency 1 expires=${at(30)}`, 'n-conc-pos', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'concurrency', delta: 1 });
});

test('concurrency accepts negative delta', () => {
  const intent = parseIntent(`drovr-intent v1 concurrency -1 expires=${at(30)}`, 'n-conc-neg', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'concurrency', delta: -1 });
});

test('concurrency accepts boundaries', () => {
  const intent = parseIntent(`drovr-intent v1 concurrency 7 expires=${at(30)}`, 'n-conc-max', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'concurrency', delta: 7 });
});

test('concurrency rejects out of bounds', () => {
  const intent = parseIntent(`drovr-intent v1 concurrency 8 expires=${at(30)}`, 'n-conc-oob', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /between -7 and 7/);
});

test('concurrency rejects non-numeric', () => {
  const intent = parseIntent(`drovr-intent v1 concurrency abc expires=${at(30)}`, 'n-conc-nan', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /signed number/);
});

// Enable action coverage
test('enable accepts program name', () => {
  const intent = parseIntent(`drovr-intent v1 enable sunnyt expires=${at(30)}`, 'n-enable', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'enable', program: 'sunnyt', enabled: true });
});

test('enable rejects missing program', () => {
  const intent = parseIntent(`drovr-intent v1 enable expires=${at(30)}`, 'n-enable-none', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /enable needs a program/);
});

test('enable rejects trailing tokens', () => {
  const intent = parseIntent(`drovr-intent v1 enable sunnyt extra expires=${at(30)}`, 'n-enable-extra', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unexpected:/);
});

// Disable action coverage
test('disable accepts program name', () => {
  const intent = parseIntent(`drovr-intent v1 disable sunnyt expires=${at(30)}`, 'n-disable', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'enable', program: 'sunnyt', enabled: false });
});

test('disable rejects missing program', () => {
  const intent = parseIntent(`drovr-intent v1 disable expires=${at(30)}`, 'n-disable-none', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /disable needs a program/);
});

test('disable rejects trailing tokens', () => {
  const intent = parseIntent(`drovr-intent v1 disable sunnyt extra expires=${at(30)}`, 'n-disable-extra', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unexpected:/);
});

// Priority action coverage with bounds
test('priority accepts program and positive delta', () => {
  const intent = parseIntent(`drovr-intent v1 priority sunnyt 2 expires=${at(30)}`, 'n-prio-pos', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'priority', program: 'sunnyt', delta: 2 });
});

test('priority accepts negative delta', () => {
  const intent = parseIntent(`drovr-intent v1 priority sunnyt -3 expires=${at(30)}`, 'n-prio-neg', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'priority', program: 'sunnyt', delta: -3 });
});

test('priority accepts boundaries', () => {
  const intent = parseIntent(`drovr-intent v1 priority sunnyt 9 expires=${at(30)}`, 'n-prio-max', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'priority', program: 'sunnyt', delta: 9 });
});

test('priority rejects out of bounds', () => {
  const intent = parseIntent(`drovr-intent v1 priority sunnyt 10 expires=${at(30)}`, 'n-prio-oob', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /between -9 and 9/);
});

test('priority rejects missing program', () => {
  const intent = parseIntent(`drovr-intent v1 priority expires=${at(30)}`, 'n-prio-no-prog', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /program name and a signed number/);
});

test('priority rejects missing delta', () => {
  const intent = parseIntent(`drovr-intent v1 priority sunnyt expires=${at(30)}`, 'n-prio-no-delta', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /program name and a signed number/);
});

test('priority rejects trailing tokens', () => {
  const intent = parseIntent(`drovr-intent v1 priority sunnyt 2 extra expires=${at(30)}`, 'n-prio-extra', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unexpected:/);
});

// Expires stamp validation (Finding 5)
test('expires= requires strict ISO 8601 format', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=2026/08/24`, 'n-iso', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /ISO 8601/);
});

test('expires= rejects loose format that Date.parse accepts', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=2026-08-24`, 'n-loose', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /ISO 8601/);
});

test('expires= accepts valid ISO with milliseconds', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=${at(30)}`, 'n-iso-ms', NOW);
  assert.ok('action' in intent);
});

test('expires= present but empty is distinguished from absent', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=`, 'n-empty-exp', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /present but empty/);
});

// Finding 8: ISO format widened to accept valid timezone offsets
test('expires= accepts +00:00 offset (UTC via offset)', () => {
  const futureWithOffset = new Date(NOW + 30 * 60_000).toISOString().replace('Z', '+00:00');
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=${futureWithOffset}`, 'n-offset-plus', NOW);
  assert.ok('action' in intent);
});

test('expires= accepts +00:00 offset with milliseconds', () => {
  const futureWithOffset = new Date(NOW + 30 * 60_000).toISOString().replace('Z', '+00:00');
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=${futureWithOffset}`, 'n-offset-ms', NOW);
  assert.ok('action' in intent);
});

test('expires= accepts -04:00 offset (EDT example)', () => {
  const futureEDT = new Date(NOW + 30 * 60_000).toISOString().replace('Z', '-04:00');
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=${futureEDT}`, 'n-offset-minus', NOW);
  assert.ok('action' in intent);
});

test('expires= still rejects offset-less local time (ambiguous)', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=2026-08-24T12:00:00`, 'n-no-tz', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /ISO 8601/);
});

test('expires= still rejects date-only form (ambiguous local time)', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=2026-08-24`, 'n-date-only', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /ISO 8601/);
});

test('an expires= stamp more than 24h out is refused, so a reopened thread cannot replay forever', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  const stamp = new Date(now + 86_400_000 + 1000).toISOString();
  const parsed = parseIntent(`drovr-intent v1 pause 3h expires=${stamp}`, 'n-1', now);
  assert.deepEqual(parsed, { rejected: 'expires= is more than 24h out; an intent must be short-lived' });
});

test('an expires= stamp exactly 24h out is still accepted', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  const stamp = new Date(now + 86_400_000).toISOString();
  const parsed = parseIntent(`drovr-intent v1 pause 3h expires=${stamp}`, 'n-1', now);
  assert.ok(!('rejected' in parsed));
});

/**
 * The drainer filters on isIntent before it takes its batch and parses afterwards.
 * If the two ever disagreed, one direction would drop real intents and the other
 * would resolve Craig's own comments, so they are pinned together here.
 */
test('isIntent agrees with the parser about what is even an intent', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  const stamp = new Date(now + 600_000).toISOString();
  const samples = [
    `drovr-intent v1 pause 3h expires=${stamp}`,
    '  drovr-intent v1 mode away expires=nonsense  ',
    'drovr-intent v1',
    'drovr-intent v2 pause 3h',
    'can we bump sunnyt up the queue?',
    '',
    'see drovr-intent v1 for the format',
  ];
  for (const text of samples) {
    const parsedAsComment = 'rejected' in parseIntent(text, 'n-1', now)
      && (parseIntent(text, 'n-1', now) as { rejected: string }).rejected === 'not an intent';
    assert.equal(isIntent(text), !parsedAsComment, `disagreed on ${JSON.stringify(text)}`);
  }
});

test('a note that merely mentions the prefix mid-sentence is conversation, not an intent', () => {
  assert.equal(isIntent('see drovr-intent v1 for the format'), false);
  assert.deepEqual(
    parseIntent('see drovr-intent v1 for the format', 'n-1', Date.now()),
    { rejected: 'not an intent' },
  );
});
