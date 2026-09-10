import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentNameFor, cycleAgentTarget } from '../src/herdr.ts';

/**
 * Real files rather than a mock: cycleAgentTarget's whole job is reading the pane
 * a previous cycle wrote to disk, and the bug it fixes was a lookup that silently
 * answered the wrong identity.
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

const writePane = (home: string, program: string, body: string): void => {
  mkdirSync(join(home, 'programs', program), { recursive: true });
  writeFileSync(join(home, 'programs', program, 'cycle-pane.json'), body, 'utf8');
};

test('a remembered pane wins over the agent name, because a restore keeps the pane and loses the name', () => {
  const target = withHome(
    (home) => writePane(home, 'aice-x', JSON.stringify({ paneId: 'w3W:pT' })),
    () => cycleAgentTarget('aice-x'),
  );
  assert.equal(target, 'w3W:pT');
  assert.notEqual(target, agentNameFor('aice-x'));
});

test('no pane file yet falls back to the name — correct before a program has ever run', () => {
  const target = withHome(() => {}, () => cycleAgentTarget('aice-x'));
  assert.equal(target, agentNameFor('aice-x'));
});

test('an unreadable pane file falls back to the name rather than throwing inside the tick', () => {
  const target = withHome(
    (home) => writePane(home, 'aice-x', '{ this is not json'),
    () => cycleAgentTarget('aice-x'),
  );
  assert.equal(target, agentNameFor('aice-x'));
});

test('a pane file of the wrong shape falls back to the name', () => {
  const target = withHome(
    (home) => writePane(home, 'aice-x', JSON.stringify({ pane: 'w3W:pT' })),
    () => cycleAgentTarget('aice-x'),
  );
  assert.equal(target, agentNameFor('aice-x'));
});
