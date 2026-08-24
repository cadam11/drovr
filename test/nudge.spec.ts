import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageIdOf, sendArgs } from '../src/nudge.ts';

test('with no origination number set, SNS is used and picks a number itself', () => {
  // This is the delivering configuration when drovr has no number of its own.
  assert.deepEqual(sendArgs('+15551234567', 'hi', null), [
    'sns',
    'publish',
    '--phone-number',
    '+15551234567',
    '--message',
    'hi',
  ]);
});

test('a configured origination number routes through End User Messaging, not SNS', () => {
  // SNS publish accepts an explicit origination identity and then fails at delivery
  // with "does not exist or does not belong to the account"; End User Messaging
  // sends from the same number fine. Measured 2026-08-24 against a live handset.
  assert.deepEqual(sendArgs('+15551234567', 'hi', '+15069068159'), [
    'pinpoint-sms-voice-v2',
    'send-text-message',
    '--destination-phone-number',
    '+15551234567',
    '--origination-identity',
    '+15069068159',
    '--message-body',
    'hi',
    '--message-type',
    'TRANSACTIONAL',
  ]);
});

test('neither transport is given --profile, since named profiles expire overnight', () => {
  for (const args of [sendArgs('+1', 'm', null), sendArgs('+1', 'm', '+2')]) {
    assert.equal(args.includes('--profile'), false);
  }
});

test('a MessageId is lifted from either API response', () => {
  assert.equal(messageIdOf('{"MessageId":"abc-123"}'), 'abc-123');
});

test('output that carries no MessageId yields null rather than a bogus id', () => {
  // The id is what finds the send in the delivery logs; inventing one would make a
  // verification lookup silently search for something that never existed.
  assert.equal(messageIdOf('not json'), null);
  assert.equal(messageIdOf('{"Other":1}'), null);
});
