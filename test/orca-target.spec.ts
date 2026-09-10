import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rememberedTerminal } from '../src/orca.ts';

/**
 * Real files rather than a mock: rememberedTerminal's whole job is reading the terminal
 * a previous cycle wrote to disk, and the bug this guards against was a lookup that
 * silently answered the wrong identity.
 */
const withHome = <T>(setup: (home: string) => void, run: () => T): T => {
  const home = mkdtempSync(join(tmpdir(), 'drovr-target-'));
  const previous = process.env.DROVR_HOME;
  process.env.DROVR_HOME = home;
  try {
    setup(home);
    return run();
  } finally {
    if (previous === undefined) delete process.env.DROVR_HOME;
    else process.env.DROVR_HOME = previous;
  }
};

const writeTerminal = (home: string, program: string, body: string): void => {
  mkdirSync(join(home, 'programs', program), { recursive: true });
  writeFileSync(join(home, 'programs', program, 'cycle-terminal.json'), body, 'utf8');
};

const record = { handle: 'term_a1b2', tabId: 'tab-1', worktreeId: 'repo-1::/Users/cadam/code/aice-x/aice' };

test('a remembered terminal is read back whole — handle, tab and worktree', () => {
  const remembered = withHome(
    (home) => writeTerminal(home, 'aice-x', JSON.stringify(record)),
    () => rememberedTerminal('aice-x'),
  );
  assert.deepEqual(remembered, record);
});

test('no file yet is null — correct before a program has ever run', () => {
  assert.equal(withHome(() => {}, () => rememberedTerminal('aice-x')), null);
});

test('an unreadable file is null rather than a throw inside the tick', () => {
  const remembered = withHome(
    (home) => writeTerminal(home, 'aice-x', '{ this is not json'),
    () => rememberedTerminal('aice-x'),
  );
  assert.equal(remembered, null);
});

test("herdr's old pane file shape is null, so a stale w3W:pT id is never sent to orca", () => {
  const remembered = withHome(
    (home) => writeTerminal(home, 'aice-x', JSON.stringify({ paneId: 'w3W:pT' })),
    () => rememberedTerminal('aice-x'),
  );
  assert.equal(remembered, null);
});
