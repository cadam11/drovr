import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsLabel, clip, keybarKeyAt, keybarLines, visibleLength, wrapText } from '../src/watch.ts';

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

test('a click resolves to the key drawn at that column, never a neighbour', () => {
  // Layout math: two columns of indent, labels joined by three-column separators.
  // Row 0 wide: 'j/k select' spans 2..12 (unclickable by design — the mouse selects
  // by clicking rows), then a dead separator, then 'space enable' at 15..27.
  assert.equal(keybarKeyAt(200, false, 0, 3), null);
  assert.equal(keybarKeyAt(200, false, 0, 13), null);
  assert.equal(keybarKeyAt(200, false, 0, 14), null);
  assert.equal(keybarKeyAt(200, false, 0, 15), ' ');
  assert.equal(keybarKeyAt(200, false, 0, 26), ' ');
  assert.equal(keybarKeyAt(200, false, 0, 27), null);
  // Off the end of the row, and a row that does not exist.
  assert.equal(keybarKeyAt(200, false, 0, 199), null);
  assert.equal(keybarKeyAt(200, false, 9, 5), null);
});

test('every actionable key stays reachable by a click, even at narrow widths', () => {
  const found = new Set<string>();
  const rows = keybarLines(40, true).length;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < 40; column += 1) {
      const key = keybarKeyAt(40, true, row, column);
      if (key !== null) found.add(key);
    }
  }
  for (const key of [' ', 'm', 'p', 'r', 't', 'o', 'x', '?', 'q']) {
    assert.ok(found.has(key), `key ${JSON.stringify(key)} is not clickable anywhere`);
  }
});

test('the keybar wraps into at least one line at every golden width, and every line fits', () => {
  for (const [width, narrow] of [[120, false], [100, false], [80, false], [71, true], [60, true], [24, true], [24, false], [71, false], [120, true]] as const) {
    const lines = keybarLines(width, narrow);
    assert.ok(lines.length >= 1);
    lines.forEach((line, row) => {
      assert.ok(visibleLength(line) <= width, `${width}/${narrow} row ${row}: ${line}`);
      for (let column = 0; column < width; column += 1) keybarKeyAt(width, narrow, row, column);
    });
  }
});

test('wrapText breaks at spaces, caps its lines, and refuses a nonsense budget', () => {
  assert.deepEqual(wrapText('short', 20, 3), ['short']);
  assert.deepEqual(wrapText('one two three four five six', 10, 3), ['one two', 'three four', 'five six']);
  assert.deepEqual(wrapText('one two three four five six', 10, 2), ['one two', 'three four five six']);
  assert.deepEqual(wrapText('abcdefghijklmnop', 5, 4), ['abcde', 'fghij', 'klmno', 'p']);
  assert.throws(() => wrapText('x', 0, 1));
  assert.throws(() => wrapText('x', 1, 0));
});

test('accountsLabel names both numbers only when they differ', () => {
  assert.equal(accountsLabel(3, 3), '3 accounts');
  assert.equal(accountsLabel(1, 3), '1 of 3 accounts funding');
});

test('clip handles exact fit, a width of 1, and a trailing escape', () => {
  assert.equal(clip('abc', 3), 'abc');
  assert.ok(visibleLength(clip('abcd', 1)) <= 1);
  assert.ok(visibleLength(clip('abcdef\x1b[31', 4)) <= 4);
});
