import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptHandle,
  agentStateFrom,
  isSettled,
  leftoverAction,
  presentFrom,
  previewText,
  shellCommand,
  terminalAddress,
  terminalExited,
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
/**
 * `wait --for exit` on a terminal whose pty has ended (recorded 2026-09-15). `show` for the
 * same terminal still carried `agentIdentity: "claude"`, so this probe is the only honest
 * answer to "is anything there at all".
 */
const exited = {
  id: '43d5e42a',
  ok: true,
  result: {
    wait: { handle: 'term_2c1446bd', condition: 'exit', satisfied: true, status: 'exited', exitCode: 0, exitCause: { kind: 'unknown' } },
  },
};

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

test('an exited pty is gone even when show still names a claude in it — the idle probe would call it working', () => {
  assert.equal(terminalExited(exited), true);
  assert.equal(terminalExited(idleTimedOut), false);
  assert.equal(agentStateFrom(claudeShown, idleTimedOut, exited), 'gone');
});

test('an exit probe refused for any reason but timeout throws', () => {
  assert.throws(() => terminalExited(stale), /terminal_handle_stale/);
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

test('a show payload without agentIdentity is the bare shell orca means by it', () => {
  // `terminal show` omits the field for an agentless terminal where `terminal list` sends an
  // explicit null. Throwing on it refused every cycle: a terminal is a bare shell for the
  // seconds `teamclaude run` takes, which is exactly where `waitForClaude` looks.
  assert.equal(agentStateFrom(shown({}), idleSatisfied), 'gone');
});

test('a show payload with a non-string agentIdentity still throws', () => {
  assert.throws(() => agentStateFrom(shown({ agentIdentity: 7 }), idleSatisfied), /expected shape/);
});

// Recorded verbatim from `orca terminal show --json` on 2026-09-12 for sunnyt's remembered
// terminal after an Orca restart: no agent, `title: null`, nothing ever written to the pty.
const restoredShell = shown({
  ptyId: '9435b4e7-fed1-4676-8ca1-310a924e26ea::/Users/cadam/code/sunnyt@@623210ca',
  orphaned: false,
  tabId: 'c4c69d5f-607e-4da8-ade2-f85aa2e981c4',
  title: null,
  lastOutputAt: null,
  preview: '',
  agentWait: null,
});

test('a show payload with a null title is a terminal with no title, not a shape error', () => {
  // Rejecting it crashed nine sunnyt cycles in one day before any terminal was created —
  // each recorded as a crash for a program nothing was wrong with.
  assert.equal(agentStateFrom(restoredShell, idleSatisfied), 'gone');
});

test('a shape error names the field that failed, not a prefix of the payload', () => {
  // The payload prefix hid `title: null` past its 300-character cut for a whole day.
  assert.throws(() => agentStateFrom(shown({ agentIdentity: 7 }), idleSatisfied), /terminal\.agentIdentity/);
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

test('terminalAddress does not print a null title as a tab name', () => {
  assert.deepEqual(terminalAddress(restoredShell, 'term_4298d453'), { where: 'terminal term_4298d453', open: null });
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

/**
 * `presentFrom` is what state.ts and tick.ts actually needed all along, and the only
 * reason it exists separately is that the idle probe it skips costs its full 1500ms
 * ceiling on a working claude — paid on every watch frame for a distinction neither
 * caller reads. It must agree with `agentStateFrom` on every input about presence, or
 * decide()'s leftover gate and the frame beside it disagree about the same pane.
 */
test('presentFrom agrees with agentStateFrom about presence, without the idle probe', () => {
  const cases: [string, unknown, unknown][] = [
    ['a live claude, working or idle', claudeShown, undefined],
    ['a claude whose pty has exited', claudeShown, exited],
    ['a bare shell', shellShown, undefined],
    ['a stale handle', stale, undefined],
    ['a claude blocked on a human-only prompt', shown({ agentIdentity: 'claude', agentWait: { kind: 'permission' } }), undefined],
  ];
  for (const [what, show, exit] of cases) {
    // The idle probe is the input presentFrom does not take; agentStateFrom is asked
    // both ways precisely to show the answer never turned on it.
    for (const idle of [idleSatisfied, idleTimedOut]) {
      const expected = agentStateFrom(show, idle, exit ?? { ok: false, error: { code: 'timeout' } }) !== 'gone';
      assert.equal(presentFrom(show, exit), expected, what);
    }
  }
});

test('presentFrom counts a blocked runner as present — a held pane, not an empty one', () => {
  assert.equal(presentFrom(shown({ agentIdentity: 'claude', agentWait: { kind: 'permission' } })), true);
});

test('presentFrom still throws on a refusal that is not a timeout, rather than reading it as absent', () => {
  assert.throws(() => presentFrom(claudeShown, stale), /terminal_handle_stale/);
});

test('leftoverAction closes an exited runner whatever its cycle said', () => {
  for (const reported of [true, false]) {
    for (const exitSent of [true, false]) {
      assert.equal(leftoverAction({ state: 'gone', reported, exitSent }), 'close');
    }
  }
});

test('leftoverAction asks an idle runner to exit only when its cycle reported, and only once', () => {
  assert.equal(leftoverAction({ state: 'idle', reported: true, exitSent: false }), 'exit');
  // Idle is not done: a runner idles at its prompt while its background shells run.
  assert.equal(leftoverAction({ state: 'idle', reported: false, exitSent: false }), 'hold');
  // A second /exit would be typed into claude's "stop background tasks?" dialog.
  assert.equal(leftoverAction({ state: 'idle', reported: true, exitSent: true }), 'hold');
});

test('leftoverAction never touches a runner that is working or on a dialog', () => {
  for (const state of ['working', 'blocked'] as const) {
    assert.equal(leftoverAction({ state, reported: true, exitSent: false }), 'hold');
  }
});
