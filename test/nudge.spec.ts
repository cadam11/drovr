import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originationArgs } from '../src/nudge.ts';

test('an unset origination number adds no argument, so SNS picks one itself', () => {
  // Passing an empty --message-attributes is not the same as omitting it; SNS
  // choosing a number per send is a valid, working configuration.
  assert.deepEqual(originationArgs(null), []);
});

test('a set origination number is sent under the name SNS actually reads', () => {
  // AWS.MM.SMS.OriginationNumber, not SenderID — SenderID is ignored for US numbers
  // and is a different field entirely.
  assert.deepEqual(originationArgs('+12362058605'), [
    '--message-attributes',
    '{"AWS.MM.SMS.OriginationNumber":{"DataType":"String","StringValue":"+12362058605"}}',
  ]);
});
