import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptHandle,
  agentStateFrom,
  isSettled,
  previewText,
  shellCommand,
  terminalAddress,
  unwrap,
} from '../src/orca.ts';

/**
 * Recorded verbatim from `orca terminal show --json` (1.4.199), trimmed to the fields
 * drovr reads. Orca answers every failure as `ok: false` with exit code 0, so the
 * envelope — not the exit code — is the interface.
 */
const shown = (terminal: Record<string, unknown>) => ({
  id: '82729c72',
  ok: true,
  result: {
    terminal: {
      handle: 'term_844e8720-ac95-453c-bb73-7e2fd567479a',
      worktreePath: '/Users/cadam/code/sunnyt',
      title: '✳ Claude Code',
      connected: true,
      writable: true,
      preview: '❯',
      ...terminal,
    },
  },
});

const claudeShown = shown({ agentIdentity: 'claude', agentWait: null });
const shellShown = shown({ title: '~/code/sunnyt', agentIdentity: null, agentWait: null });
const stale = { id: 'ca3dceb8', ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } };
const idleSatisfied = {
  id: '175e9e23',
  ok: true,
  result: { wait: { handle: 'term_844e8720', condition: 'tui-idle', satisfied: true, status: 'running', exitCode: null } },
};
const idleTimedOut = { id: '175e9e24', ok: false, error: { code: 'timeout', message: 'timeout' } };

test('unwrap returns the result of an ok envelope', () => {
  assert.deepEqual(unwrap(idleSatisfied, 'orca terminal wait'), idleSatisfied.result);
});

test('unwrap throws the error code of a refused envelope — orca exits 0 either way', () => {
  assert.throws(() => unwrap(stale, 'orca terminal show'), /terminal_handle_stale/);
});

test('unwrap throws on a shape that is neither, rather than reading it as anything', () => {
  assert.throws(() => unwrap({ result: {} }, 'orca terminal show'), /orca terminal show/);
});

test('a stale handle is gone: the terminal no longer exists', () => {
  assert.equal(agentStateFrom(stale, idleTimedOut), 'gone');
});

test('a terminal holding a plain shell is gone — claude has exited and the shell is what remains', () => {
  assert.equal(agentStateFrom(shellShown, idleSatisfied), 'gone');
});

test('a claude parked on a human-only prompt is blocked, whatever the idle probe says', () => {
  const blocked = shown({ agentIdentity: 'claude', agentWait: { kind: 'permission', evidence: 'prompt-text' } });
  assert.equal(agentStateFrom(blocked, idleSatisfied), 'blocked');
});

test('a claude whose TUI settled within the probe is idle', () => {
  assert.equal(agentStateFrom(claudeShown, idleSatisfied), 'idle');
});

test('a claude whose TUI did not settle within the probe is working', () => {
  assert.equal(agentStateFrom(claudeShown, idleTimedOut), 'working');
});

test('an older host that never looked for a wait still answers idle or working', () => {
  const noWaitField = shown({ agentIdentity: 'claude' });
  assert.equal(agentStateFrom(noWaitField, idleTimedOut), 'working');
});

test('a show payload without agentIdentity throws rather than answering gone', () => {
  // Reading a missing field as "no agent" is the herdr agent_status bug again, in the
  // direction that frees a pane a runner is sitting in.
  assert.throws(() => agentStateFrom(shown({}), idleSatisfied), /agentIdentity/);
});

test('an idle probe refused for any reason but timeout throws', () => {
  const refused = { id: 'x', ok: false, error: { code: 'terminal_handle_stale', message: 'terminal_handle_stale' } };
  assert.throws(() => agentStateFrom(claudeShown, refused), /terminal_handle_stale/);
});

test('a working agent is never settled, so /exit is not typed into its turn', () => {
  assert.equal(isSettled('working'), false);
  assert.equal(isSettled('blocked'), false);
});

test('an idle or vanished agent is settled and can be released', () => {
  assert.equal(isSettled('idle'), true);
  assert.equal(isSettled('gone'), true);
});

test('previewText joins the tail of a terminal read, oldest first', () => {
  // Recorded from `orca terminal read --limit 5 --json`.
  const read = {
    id: 'a1eff3f9',
    ok: true,
    result: {
      terminal: {
        handle: 'term_844e8720',
        status: 'running',
        tail: ['❯', '──────', '  using Fable 5.1 | ctx:15% (148k)'],
        truncated: false,
        limited: true,
        oldestCursor: '0',
        nextCursor: '108',
        latestCursor: '108',
        returnedLineCount: 3,
        source: 'screen',
      },
    },
  };
  assert.equal(previewText(read), '❯\n──────\n  using Fable 5.1 | ctx:15% (148k)');
});

test('shellCommand quotes every argument a shell would otherwise split or expand', () => {
  assert.equal(
    shellCommand(['direnv', 'exec', '/Users/cadam/code/aice-x/aice', 'teamclaude', 'run', '--', '--name', "aice-x program runner's"]),
    `direnv exec /Users/cadam/code/aice-x/aice teamclaude run -- --name 'aice-x program runner'\\''s'`,
  );
});

test('terminalAddress names the tab and the command that opens it', () => {
  assert.deepEqual(terminalAddress(claudeShown, 'term_844e8720-ac95-453c-bb73-7e2fd567479a'), {
    where: 'its "✳ Claude Code" tab in sunnyt',
    open: 'orca terminal switch --terminal term_844e8720-ac95-453c-bb73-7e2fd567479a',
  });
});

test('terminalAddress falls back to the bare handle when orca cannot describe it', () => {
  assert.deepEqual(terminalAddress(stale, 'term_dead'), { where: 'terminal term_dead', open: null });
});

test('adoptHandle finds the restored terminal by tab id, because handles do not survive an Orca restart', () => {
  // Recorded from `orca terminal list --json`, trimmed. The tab survives a restart; the
  // handle is runtime-scoped and comes back different.
  const list = {
    id: '94745afa',
    ok: true,
    result: {
      terminals: [
        { handle: 'term_3998', tabId: 'tab-other', worktreePath: '/Users/cadam/code/sunnyt', agentIdentity: null },
        { handle: 'term_5b2e', tabId: 'tab-drovr', worktreePath: '/Users/cadam/code/sunnyt', agentIdentity: 'claude' },
      ],
    },
  };
  assert.equal(adoptHandle(list, 'tab-drovr'), 'term_5b2e');
  assert.equal(adoptHandle(list, 'tab-gone'), null);
});
