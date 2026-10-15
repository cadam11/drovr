import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readControl } from '../src/control.ts';

const controlWith = (program: Record<string, unknown>): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'drovr-host-')), 'control.json');
  writeFileSync(path, JSON.stringify({ programs: [{ name: 'relliq', cwd: '/Users/cadam/code/propra/relliq', ...program }] }));
  return path;
};

const host = { environment: 'a7a12606', ssh: 'ubuntu@relliq-devbox', cwd: '/home/ubuntu/code/propra/relliq' };

test('a program has no host unless one is set', () => {
  assert.equal(readControl(controlWith({})).programs[0]!.host, null);
});

test('a host fills in the box defaults: ~/.drovr, ~/.local/bin/claude, no wake', () => {
  assert.deepEqual(readControl(controlWith({ host })).programs[0]!.host, {
    ...host,
    drovrHome: '~/.drovr',
    claude: '~/.local/bin/claude',
    wake: null,
  });
});

test('a host keeps what it was given', () => {
  const full = { ...host, drovrHome: '/srv/drovr', claude: '/usr/local/bin/claude', wake: 'cd ~/code/propra/relliq && pnpm devbox:start' };
  assert.deepEqual(readControl(controlWith({ host: full })).programs[0]!.host, full);
});

test('a host missing its ssh target or environment is refused', () => {
  assert.throws(() => readControl(controlWith({ host: { environment: 'a7', cwd: '/x' } })), /control file is invalid/);
  assert.throws(() => readControl(controlWith({ host: { ssh: 'u@h', cwd: '/x' } })), /control file is invalid/);
});

test('a host cwd must be absolute: orca addresses the worktree by path', () => {
  assert.throws(() => readControl(controlWith({ host: { ...host, cwd: 'code/relliq' } })), /absolute path on the box/);
});

// --- orca: the environment rides along on every call for a remote terminal

import { envArgs, shellCommand, terminalAddress } from '../src/orca.ts';

test('envArgs is empty on the Mac and names the paired runtime for a host', () => {
  assert.deepEqual(envArgs(undefined), []);
  assert.deepEqual(envArgs('a7a12606'), ['--environment', 'a7a12606']);
});

test('shellCommand leaves a leading ~/ bare so the box expands it, and quotes the rest', () => {
  assert.equal(shellCommand(['~/.local/bin/claude', '--name', 'relliq program runner']), "~/.local/bin/claude --name 'relliq program runner'");
  assert.equal(shellCommand(['cat', '~/.drovr/programs/my prog/last-cycle.json']), "cat ~/'.drovr/programs/my prog/last-cycle.json'");
  assert.equal(shellCommand(['~alone']), "'~alone'");
});

test('terminalAddress opens a remote terminal in its environment', () => {
  const shown = { ok: true, result: { terminal: { handle: 'term_1', agentIdentity: 'claude', title: 'relliq cycles', worktreePath: '/home/ubuntu/code/propra/relliq' } } };
  assert.deepEqual(terminalAddress(shown, 'term_1', 'a7a12606'), {
    where: 'its "relliq cycles" tab in relliq',
    open: 'orca terminal switch --terminal term_1 --environment a7a12606',
  });
  assert.equal(terminalAddress(shown, 'term_1').open, 'orca terminal switch --terminal term_1');
});
