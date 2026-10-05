import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findResponse, logGroups, unverified, verifyDelivery } from '../src/delivery.ts';

const event = (messageId: string, response: string) =>
  JSON.stringify({
    notification: { messageId, timestamp: '2026-08-24 14:43:32.175' },
    delivery: { destination: '+15551234567', providerResponse: response },
  });

test('log group names are derived from the account and region that sent', () => {
  assert.deepEqual(logGroups('000000000000', 'us-east-1'), {
    ok: 'sns/us-east-1/000000000000/DirectPublishToPhoneNumber',
    failed: 'sns/us-east-1/000000000000/DirectPublishToPhoneNumber/Failure',
  });
});

test('this send is found among other traffic to the same log group', () => {
  const messages = [event('other-1', 'Message has been accepted by phone'), event('mine', 'boom')];
  assert.equal(findResponse(messages, 'mine'), 'boom');
});

test('another send is never mistaken for this one', () => {
  // sunnyt publishes to the same log group. Reading its record as drovr's would
  // report a delivery that never happened.
  assert.equal(findResponse([event('someone-else', 'accepted')], 'mine'), null);
});

test('unparseable log lines are skipped rather than aborting the search', () => {
  assert.equal(findResponse(['not json', '{}', event('mine', 'ok')], 'mine'), 'ok');
});

test('a send that never happened is unknown, never delivered', () => {
  const verdict = unverified('nothing was sent');
  assert.equal(verdict.state, 'unknown');
});

test('an End User Messaging send reports unknown and names what would fix it', async () => {
  // Its events go to a configuration set drovr does not have, so drovr cannot see
  // them. Saying "delivered" here would be a guess dressed as a fact.
  const verdict = await verifyDelivery(
    { sent: true, messageId: 'abc', via: 'end-user-messaging' },
    1_000,
  );
  assert.equal(verdict.state, 'unknown');
  assert.match(verdict.reason, /create-configuration-set/);
  assert.match(verdict.reason, /create-event-destination/);
});

test('a send with no MessageId cannot be verified and says so', async () => {
  const verdict = await verifyDelivery({ sent: true, messageId: null, via: 'sns' }, 1_000);
  assert.equal(verdict.state, 'unknown');
  assert.match(verdict.reason, /no MessageId/);
});

test('a Slack send is delivered on the spot, with or without a ts', async () => {
  // Slack's ok means the message is stored in the DM; there is no later event to wait for.
  const verdict = await verifyDelivery({ sent: true, messageId: null, via: 'slack' }, 1_000);
  assert.equal(verdict.state, 'delivered');
});

test('a Slack send that fell back and failed is not reported as delivered', async () => {
  const verdict = await verifyDelivery({ sent: false, messageId: null, via: 'slack' }, 1_000);
  assert.equal(verdict.state, 'unknown');
});
