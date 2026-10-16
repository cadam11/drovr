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

// --- cycle: the report comes back over ssh, the box is woken, the launch names the binary

import { isMissingFile, launchArgv, remoteReportPath, reportFromPoll, tailscaleCheckLink, wakeDecision } from '../src/cycle.ts';

const fullHost = { ...host, drovrHome: '~/.drovr', claude: '~/.local/bin/claude', wake: null };
const program = (over: Record<string, unknown>) =>
  readControl(controlWith(over)).programs[0]!;

test('the remote report path is a shell word the box expands, not a path resolved here', () => {
  assert.equal(shellCommand(['cat', remoteReportPath(fullHost, 'relliq')]), 'cat ~/.drovr/programs/relliq/last-cycle.json');
  assert.equal(
    shellCommand(['cat', remoteReportPath({ ...fullHost, drovrHome: '/srv/drovr' }, 'relliq')]),
    'cat /srv/drovr/programs/relliq/last-cycle.json',
  );
});

test('only cat\'s own "No such file" means not yet; anything else ssh says is a failure', () => {
  assert.equal(isMissingFile('cat: /home/ubuntu/.drovr/programs/relliq/last-cycle.json: No such file or directory\n'), true);
  assert.equal(isMissingFile('ssh: connect to host relliq-devbox port 22: Operation timed out\r\n'), false);
  assert.equal(isMissingFile(''), false);
});

test('reportFromPoll reads absent and torn as not yet, and a wrong-shaped report as broken', () => {
  assert.equal(reportFromPoll(null, 'x'), null);
  assert.equal(reportFromPoll('{"exit": "sea', 'x'), null);
  assert.equal(reportFromPoll('{"exit":"seam"}', 'x')?.exit, 'seam');
  assert.throws(() => reportFromPoll('{"exit":"done"}', 'x'), /not a valid cycle report/);
});

test('wakeDecision: reachable proceeds, unreachable wakes when it can, else fails', () => {
  assert.equal(wakeDecision(true, null), 'proceed');
  assert.equal(wakeDecision(true, 'pnpm devbox:start'), 'proceed');
  assert.equal(wakeDecision(false, 'pnpm devbox:start'), 'run-wake');
  assert.equal(wakeDecision(false, null), 'fail');
});

test('the launch goes through teamclaude on the Mac and straight to the binary on a host', () => {
  const claude = ['--model', 'fable', '--name', 'relliq program runner', '--session-id', 'sid'];
  assert.deepEqual(launchArgv(program({}), 'relliq program runner', 'sid'), [
    'direnv', 'exec', '/Users/cadam/code/propra/relliq', 'teamclaude', 'run', '--', ...claude,
  ]);
  assert.deepEqual(launchArgv(program({ host }), 'relliq program runner', 'sid'), [
    'direnv', 'exec', '/home/ubuntu/code/propra/relliq', '~/.local/bin/claude', ...claude,
  ]);
  assert.deepEqual(launchArgv(program({ host, useDirenv: false }), 'relliq program runner', 'sid'), [
    '~/.local/bin/claude', ...claude,
  ]);
});

test('tailscaleCheckLink: lifts the check link out of a hung probe, else null', () => {
  const reason =
    'ssh ubuntu@box true did not return within 20s and was killed; it had printed: ' +
    '# Tailscale SSH requires an additional check. # To authenticate, visit: https://login.tailscale.com/a/l1e8671de330fd4';
  assert.equal(tailscaleCheckLink(reason), 'https://login.tailscale.com/a/l1e8671de330fd4');
  assert.equal(tailscaleCheckLink('ssh ubuntu@box true did not return within 20s and was killed'), null);
  assert.equal(tailscaleCheckLink(null), null);
});
