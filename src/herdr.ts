import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Program } from './control.ts';
import { explainSpawn } from './exec.ts';
import { parsePreview, type Preview } from './preview.ts';

const run = promisify(execFile);

const workspaceShape = z.object({
  workspace_id: z.string(),
  label: z.string().optional(),
  worktree: z.object({ checkout_path: z.string() }).partial().optional(),
});

const workspaceListShape = z.object({
  result: z.object({ workspaces: z.array(workspaceShape) }),
});

const tabCreateShape = z.object({
  result: z.object({
    tab: z.object({ tab_id: z.string() }),
    root_pane: z.object({ pane_id: z.string() }),
  }),
});

const workspaceCreateShape = z.object({
  result: z.object({ workspace: z.object({ workspace_id: z.string() }) }),
});

/** herdr's own vocabulary, as listed by `herdr agent wait --until`. */
const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** `gone` is drovr's own addition: the agent target no longer exists at all. */
export type AgentState = AgentStatus | 'gone';

const agentShape = z.object({
  result: z.object({
    agent: z.object({ agent_status: z.enum(AGENT_STATUSES) }).passthrough(),
  }),
});

/**
 * herdr names this field `agent_status`. Reading `state` instead parsed clean and
 * answered `unknown` for every agent — itself a real herdr status — so a finished
 * runner was never recognised as releasable and every tick deferred against drovr's
 * own leftover. An unrecognised shape has to be loud for exactly that reason.
 */
export const parseAgentStatus = (payload: unknown): AgentStatus => {
  const parsed = agentShape.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `herdr agent get did not report an agent_status: ${JSON.stringify(payload).slice(0, 300)}`,
    );
  }
  return parsed.data.result.agent.agent_status;
};

const herdr = async (args: string[]): Promise<unknown> => {
  const shown = `herdr ${args.join(' ')}`;
  const { stdout } = await run('herdr', args, { maxBuffer: 8 * 1024 * 1024 }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw explainSpawn('herdr', error);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${shown} failed: ${detail}`);
    },
  );

  // Not every herdr command answers with JSON; say which one surprised us rather
  // than surfacing a bare "Unexpected end of JSON input".
  if (stdout.trim() === '') return {};
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${shown} did not return JSON. It printed: ${stdout.slice(0, 300)}`);
  }
};

/**
 * teamclaude's own guidance for multiplexers that spawn claude themselves: take its
 * env rather than wrapping the command, so the pane runs a normal interactive
 * `claude` that Craig can talk to while still routing through the proxy.
 */
export const teamclaudeEnv = async (): Promise<string[]> => {
  const { stdout } = await run('teamclaude', ['env']).catch((error: unknown) => {
    throw explainSpawn('teamclaude', error);
  });
  const pairs = stdout
    .split('\n')
    .map((line) => /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]}=${match[2]!.replace(/^["']|["']$/g, '')}`);

  // Without this the pane would start a raw claude against Craig's own quota with no
  // rotation and no accounting — a silent, expensive failure. Refuse instead.
  const routed = pairs.some((pair) => /^(HTTPS_PROXY|ANTHROPIC_BASE_URL)=/.test(pair));
  if (!routed) {
    throw new Error(
      '`teamclaude env` returned no proxy settings, so a cycle would run un-proxied. ' +
        'Check the teamclaude server is up (teamclaude status).',
    );
  }
  return pairs;
};

const baseUrlCache = new Map<string, string | null>();

/**
 * The aice install lives in the program repo's .envrc, so the only honest source is
 * direnv. Cached per process: a watch frame redraws every few seconds and must not
 * shell out per program each time.
 */
export const aiceBaseUrl = async (program: Program): Promise<string | null> => {
  const cached = baseUrlCache.get(program.name);
  if (cached !== undefined) return cached;

  const resolved = await run('direnv', ['exec', program.cwd, 'sh', '-c', 'printf %s "$AICE_BASE_URL"'])
    .then(({ stdout }) => (stdout.trim() === '' ? null : stdout.trim()))
    .catch(() => null);

  baseUrlCache.set(program.name, resolved);
  return resolved;
};

/** Explicit config wins; otherwise match the workspace by label, then by checkout path. */
export const resolveWorkspace = async (program: Program): Promise<string> => {
  const parsed = workspaceListShape.safeParse(await herdr(['workspace', 'list']));
  if (!parsed.success) throw new Error(`herdr workspace list was not the expected shape`);
  const workspaces = parsed.data.result.workspaces;

  if (program.herdrWorkspace !== null) {
    const pinned = workspaces.find((entry) => entry.workspace_id === program.herdrWorkspace);
    if (pinned === undefined) {
      throw new Error(`herdr has no workspace ${program.herdrWorkspace} for program ${program.name}`);
    }
    return pinned.workspace_id;
  }

  const byLabel = workspaces.find((entry) => entry.label === program.name);
  if (byLabel !== undefined) return byLabel.workspace_id;

  const byPath = workspaces.find((entry) => entry.worktree?.checkout_path === program.cwd);
  if (byPath !== undefined) return byPath.workspace_id;

  // drovr knows the program's directory, so a missing workspace is something it can
  // fix rather than refuse over. Closing a workspace should not strand a program.
  const created = workspaceCreateShape.safeParse(
    await herdr([
      'workspace',
      'create',
      '--cwd',
      program.cwd,
      '--label',
      program.name,
      '--no-focus',
    ]),
  );
  if (!created.success) {
    throw new Error(
      `no herdr workspace matches program "${program.name}" by label or by cwd ${program.cwd}, ` +
        `and creating one did not return the expected shape. Create it by hand, or set ` +
        `"herdrWorkspace" on the program in control.json.`,
    );
  }
  console.log(
    `created herdr workspace ${created.data.result.workspace.workspace_id} for ${program.name}`,
  );
  return created.data.result.workspace.workspace_id;
};

export type StartedCycle = { agentName: string; tabId: string | null; paneId: string; reused: boolean };

/**
 * The pane holds a session that is not ours to end. Distinct from a crash: nothing
 * went wrong, the cycle simply did not start, and the next tick should try again
 * without it counting against the program.
 */
export class PaneBusy extends Error {}

const paneExists = async (paneId: string): Promise<boolean> => {
  try {
    await herdr(['pane', 'get', paneId]);
    return true;
  } catch {
    return false;
  }
};

/**
 * A herdr server restart brings panes back as fresh shells in their saved cwd —
 * layout and cwd survive, environment does not. Worse, `resume_agents_on_restore`
 * is on by default, so a restored cycle pane re-runs `claude --resume` with no
 * proxy settings and would bill Craig's quota directly with no rotation. Re-assert
 * the environment in the shell before every start, reused pane or not.
 */
const assertProxyEnv = async (paneId: string): Promise<void> => {
  await herdr(['pane', 'send-text', paneId, 'eval "$(teamclaude env)"\r']);
};

/** An occupied pane means a previous agent is still there — very likely a restored cycle. */
export const paneOccupant = async (paneId: string): Promise<AgentStatus | null> => {
  // `agent get` on a pane holding no agent exits non-zero with agent_not_found. A
  // payload drovr cannot read is a different thing entirely and is left to throw.
  const payload = await herdr(['agent', 'get', paneId]).catch(() => null);
  return payload === null ? null : parseAgentStatus(payload);
};

/**
 * Workspaces are long-lived, so one tab per cycle would bury the workspace in
 * hundreds of them. The program keeps a single cycle tab: the previous agent has
 * exited, leaving the pane at a shell prompt, which is exactly what `agent start`
 * wants. Its scrollback carries prior cycles too.
 */
const cyclePane = async (input: {
  program: Program;
  workspaceId: string;
  remembered: string | null;
  env: string[];
}): Promise<{ paneId: string; tabId: string | null; reused: boolean }> => {
  const { program, workspaceId, remembered, env } = input;
  if (remembered !== null && (await paneExists(remembered))) {
    return { paneId: remembered, tabId: null, reused: true };
  }

  const created = tabCreateShape.safeParse(
    await herdr([
      'tab',
      'create',
      '--workspace',
      workspaceId,
      '--cwd',
      program.cwd,
      '--label',
      cycleTabLabel(program.name),
      '--no-focus',
      ...env.flatMap((pair) => ['--env', pair]),
    ]),
  );
  if (!created.success) throw new Error('herdr tab create was not the expected shape');
  return {
    paneId: created.data.result.root_pane.pane_id,
    tabId: created.data.result.tab.tab_id,
    reused: false,
  };
};

/** Bounded wait for an agent to become promptable after a blocked startup. */
const waitForIdle = async (agentName: string, attempts = 20): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await agentState(agentName);
    if (state === 'idle' || state === 'done') return true;
    if (state === 'gone') return false;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return false;
};

export const startCycleAgent = async (input: {
  program: Program;
  workspaceId: string;
  prompt: string;
  sessionName: string;
  env: string[];
  remembered: string | null;
}): Promise<StartedCycle> => {
  const { program, prompt } = input;
  const agentName = `drovr-${program.name}`.slice(0, 32).toLowerCase();
  const pane = await cyclePane(input);

  if (pane.reused) {
    // A live session in the pane is an ordinary state, not a fault: the previous
    // runner may not have been released yet, or Craig may be talking to it. Try to
    // release our own finished runner; anything else is left strictly alone.
    const occupant = await paneOccupant(pane.paneId);
    if (occupant !== null) {
      const freed =
        occupant === 'idle' || occupant === 'done'
          ? await releaseAgent(agentName, pane.paneId).catch(() => false)
          : false;
      if (!freed) {
        throw new PaneBusy(
          `${program.name} already has a live session in pane ${pane.paneId} (${occupant}). ` +
            'Leaving it alone — it is either still working or being used. The next tick tries again.',
        );
      }
    }
    await assertProxyEnv(pane.paneId);
  }

  // Args after `--` reach claude itself. --model sets the model for this session
  // only, so the runner is always Fable without touching Craig's default; --name
  // makes it obvious in the prompt box and /resume which program a session belongs to.
  // `agent start` exits non-zero with agent_not_ready when claude comes up behind a
  // dialog — a trust prompt, a permission question. The agent is running and named;
  // it simply cannot take input yet. Treating that as fatal leaves a live session
  // sitting there having never been told what to do.
  const started = await herdr([
    'agent',
    'start',
    agentName,
    '--kind',
    'claude',
    '--pane',
    pane.paneId,
    '--',
    '--model',
    program.model,
    '--name',
    input.sessionName,
  ]).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.includes('agent_not_ready')) throw error;
    return { notReady: true };
  });

  if (typeof started === 'object' && started !== null && 'notReady' in started) {
    const ready = await waitForIdle(agentName);
    if (!ready) {
      throw new PaneBusy(
        `${program.name} started but is waiting on a dialog in pane ${pane.paneId} — ` +
          'answer it there and the next tick will prompt it.',
      );
    }
  }

  // No --wait: the cycle runs for hours, and blocking here would defeat the point.
  await promptAgent(agentName, prompt);

  return { agentName, ...pane };
};

const tabListShape = z.object({
  result: z.object({
    tabs: z.array(z.object({ tab_id: z.string(), label: z.string().optional() })),
  }),
});

const paneListShape = z.object({
  result: z.object({
    panes: z.array(z.object({ pane_id: z.string(), tab_id: z.string(), agent: z.string().optional() })),
  }),
});

export const cycleTabLabel = (program: string): string => `${program} cycles`;

/**
 * Only tabs drovr itself labelled, only in that program's workspace, and only when
 * every pane in them is free of an agent. A tab still holding a session is left
 * alone whatever its age — a stray empty tab is untidy, a closed live one is lost work.
 */
export const tidyCycleTabs = async (input: {
  program: string;
  workspaceId: string;
  keepTabId: string | null;
}): Promise<string[]> => {
  const { program, workspaceId, keepTabId } = input;
  const tabs = tabListShape.safeParse(await herdr(['tab', 'list', '--workspace', workspaceId]));
  const panes = paneListShape.safeParse(await herdr(['pane', 'list', '--workspace', workspaceId]));
  if (!tabs.success || !panes.success) return [];

  const label = cycleTabLabel(program);
  const closed: string[] = [];

  for (const tab of tabs.data.result.tabs) {
    if (tab.label !== label || tab.tab_id === keepTabId) continue;
    const own = panes.data.result.panes.filter((pane) => pane.tab_id === tab.tab_id);
    if (own.length === 0 || own.some((pane) => pane.agent !== undefined)) continue;
    await herdr(['tab', 'close', tab.tab_id]);
    closed.push(tab.tab_id);
  }
  return closed;
};

export const agentState = async (agentName: string): Promise<AgentState> => {
  // The agent exited or its pane closed — both mean the cycle is no longer running.
  const payload = await herdr(['agent', 'get', agentName]).catch(() => null);
  if (payload === null) return 'gone';
  return parseAgentStatus(payload);
};

const SETTLED: AgentState[] = ['idle', 'done', 'unknown', 'gone'];

/**
 * Only a settled session can act on `/exit`. Typed into a running turn it is
 * swallowed by that turn instead of executed, and typed at a dialog it is not read
 * at all — either way the pane is held and every later cycle for the program is
 * refused. `unknown` stays settled: herdr simply cannot see a state to wait on.
 */
export const isSettled = (state: AgentState): boolean => SETTLED.includes(state);

/**
 * An interactive claude session cannot exit itself — it finishes its turn and idles
 * at the prompt forever. Once the runner has written its report the cycle has
 * declared itself done, so releasing the pane is cleanup, not a kill. Without this
 * the pane stays occupied and the next cycle for that program is refused.
 */
export const releaseAgent = async (agentName: string, paneId: string): Promise<boolean> => {
  let state = await agentState(agentName);
  for (let attempt = 0; attempt < 10 && !isSettled(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    state = await agentState(agentName);
  }
  if (state === 'gone') return true;

  // A runner can keep working long after writing its report, so refusing here rather
  // than sending anyway is what makes this retryable: the next tick finds the agent
  // idle and releases it then, instead of burning the only attempt on a deaf session.
  if (!isSettled(state)) return false;

  await herdr(['pane', 'send-text', paneId, '/exit\r']).catch(() => ({}));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if ((await agentState(agentName)) === 'gone') return true;
  }
  return false;
};

/** Submits a prompt to a live session — how a cycle is started, and how a stalled one is restarted. */
export const promptAgent = async (agentName: string, prompt: string): Promise<void> => {
  await herdr(['agent', 'prompt', agentName, prompt]);
};

export const interruptAgent = async (agentName: string): Promise<void> => {
  await herdr(['agent', 'send-keys', agentName, 'esc']);
};

/**
 * Best-effort by design: a program with no live pane, a herdr that is down, or a
 * claude whose TUI changed all mean "no preview", never a failed tick.
 */
export const readPreview = async (agentName: string): Promise<Preview | null> => {
  try {
    const { stdout } = await run('herdr', [
      'agent', 'read', agentName,
      '--source', 'recent-unwrapped',
      '--lines', '40',
      '--format', 'text',
    ], { maxBuffer: 1024 * 1024 });
    return parsePreview(stdout);
  } catch (error) {
    console.error(`preview unavailable for ${agentName}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};
