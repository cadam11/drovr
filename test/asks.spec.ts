import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPage } from '../src/asks.ts';

test('a prefixed page is split, since notes list resolves relative to a prefix', () => {
  // Passing the whole thing looks under <yourslug>/craig/... and reports an empty,
  // unshared page rather than failing — a silent wrong answer.
  assert.deepEqual(splitPage('craig/loop-asks.html'), { page: 'loop-asks.html', prefix: 'craig' });
});

test('a bare page keeps the caller default prefix', () => {
  assert.deepEqual(splitPage('asks.html'), { page: 'asks.html', prefix: null });
});

test('only the first segment is the prefix', () => {
  assert.deepEqual(splitPage('craig/programs/asks.html'), {
    page: 'programs/asks.html',
    prefix: 'craig',
  });
});

import { chmodSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAsks, readAsksFile } from '../src/asks.ts';

const dirWith = (name: string, text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'asks-'));
  writeFileSync(join(dir, name), text);
  return dir;
};

test('an asks file counts unchecked items as open and reports its mtime', async () => {
  const dir = dirWith('asks.md', '# Asks\n\n- [ ] Which region?\n  context here\n- [x] Keep the old name?\n  yes, keep it\n- [ ] Ship on Friday?\n');
  utimesSync(join(dir, 'asks.md'), new Date('2026-10-22T10:00:00Z'), new Date('2026-10-22T10:00:00Z'));
  assert.deepEqual(await readAsksFile(dir, 'asks.md'), {
    shared: true,
    latestAt: Date.parse('2026-10-22T10:00:00Z'),
    openThreads: 2,
  });
});

test('a file with only answered items has no open threads', async () => {
  const dir = dirWith('asks.md', '- [X] done\r\n- [x] also done\r\n');
  const state = await readAsksFile(dir, 'asks.md');
  assert.equal(state?.openThreads, 0);
});

test('a missing asks file reads as nothing, not an error', async () => {
  const dir = dirWith('other.md', '');
  assert.equal(await readAsksFile(dir, 'asks.md'), null);
});

test('an asks file outside the program directory is not followed', async () => {
  const dir = dirWith('asks.md', '- [ ] x\n');
  assert.equal(await readAsksFile(join(dir, 'sub'), '../asks.md'), null);
});

test('a bare item with nothing after the box still counts as open', async () => {
  const dir = dirWith('asks.md', '- [ ]\n- [ ] \n');
  assert.equal((await readAsksFile(dir, 'asks.md'))?.openThreads, 2);
});

test('an unreadable asks file is an error, not an empty answer', async () => {
  const dir = dirWith('asks.md', '- [ ] x\n');
  chmodSync(join(dir, 'asks.md'), 0o000);
  await assert.rejects(readAsksFile(dir, 'asks.md'), /EACCES|EPERM/);
});

test('a hosted program has no local asks file to read', async () => {
  const dir = dirWith('.drovr-asks.md', '- [ ] x\n');
  const program = { name: 'h', cwd: dir, aice: null, asksFile: '.drovr-asks.md', host: { environment: 'e', ssh: 'u@h', cwd: '/srv/h', drovrHome: null, claude: null, wake: null } };
  assert.equal(await readAsks(program as never, 1), null);
});
