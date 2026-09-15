import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closingFrom, CLOSING_MAX_CHARS } from '../src/transcript.ts';

const line = (record: unknown): string => JSON.stringify(record);
const assistant = (...content: unknown[]): string => line({ type: 'assistant', message: { role: 'assistant', content } });
const text = (value: string) => ({ type: 'text', text: value });

test('the closing message is the last assistant text block, not the last line', () => {
  const jsonl = [
    line({ type: 'user', message: { content: 'go' } }),
    assistant(text('first turn')),
    assistant({ type: 'tool_use', name: 'Bash', input: {} }),
    assistant(text('Cycle 5 closed at a clean seam.')),
    line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    line({ type: 'summary', summary: 'x' }),
  ].join('\n');
  assert.equal(closingFrom(jsonl), 'Cycle 5 closed at a clean seam.');
});

test('a transcript with no assistant text has no closing', () => {
  assert.equal(closingFrom(''), null);
  assert.equal(closingFrom(assistant({ type: 'tool_use', name: 'Bash', input: {} })), null);
  assert.equal(closingFrom(assistant(text('   '))), null);
});

test('it is a scrape: a malformed line is skipped, never thrown', () => {
  assert.equal(closingFrom(`${assistant(text('kept'))}\nnot json\n{"type":"assistant","message":7}`), 'kept');
});

test('a closing is capped so one verbose runner cannot bloat the ledger', () => {
  const long = 'x'.repeat(CLOSING_MAX_CHARS + 500);
  assert.equal(closingFrom(assistant(text(long)))?.length, CLOSING_MAX_CHARS);
});
