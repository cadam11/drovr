import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clip, keybarLines, visibleLength } from '../src/watch.ts';

const RED = '\x1b[31m';
const OFF = '\x1b[0m';

test('escape sequences occupy no columns', () => {
  assert.equal(visibleLength(`${RED}abc${OFF}`), 3);
});

test('an OSC 8 hyperlink measures only its label', () => {
  assert.equal(visibleLength('\x1b]8;;https://example.com/very/long\x1b\\link\x1b]8;;\x1b\\'), 4);
});

test('short lines are left exactly alone', () => {
  const line = `${RED}hello${OFF}`;
  assert.equal(clip(line, 40), line);
});

test('a long line is cut to the width, counting only visible columns', () => {
  const clipped = clip(`${RED}${'x'.repeat(80)}${OFF}`, 20);
  assert.ok(visibleLength(clipped) <= 20);
  assert.ok(clipped.endsWith('…'));
});

test('clipping keeps colour codes so the frame cannot bleed', () => {
  assert.ok(clip(`${RED}${'x'.repeat(80)}`, 10).startsWith(RED));
});

test('the keybar wraps instead of clipping, so no key is hidden', () => {
  const wide = keybarLines(200, false);
  const narrow = keybarLines(40, true);
  assert.equal(wide.length, 1);
  assert.ok(narrow.length > 1);
  narrow.forEach((line) => assert.ok(visibleLength(line) <= 40));
});

test('narrow mode shows the key itself, not its description', () => {
  assert.ok(keybarLines(40, true).join(' ').includes('q'));
  assert.ok(!keybarLines(40, true).join(' ').includes('quit'));
});
