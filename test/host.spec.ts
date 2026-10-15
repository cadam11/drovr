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
