// test/intents.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INTENTS_PER_TICK, parseIntent } from '../src/intents.ts';

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
