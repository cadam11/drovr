import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Program } from './control.ts';

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

const agentShape = z.object({
  result: z.object({ agent: z.object({ state: z.string() }).partial() }).partial(),
});

const herdr = async (args: string[]): Promise<unknown> => {
  const { stdout } = await run('herdr', args, { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};

/**
 * teamclaude's own guidance for multiplexers that spawn claude themselves: take its
 * env rather than wrapping the command, so the pane runs a normal interactive
 * `claude` that Craig can talk to while still routing through the proxy.
 */
export const teamclaudeEnv = async (): Promise<string[]> => {
  const { stdout } = await run('teamclaude', ['env']);
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

  throw new Error(
    `no herdr workspace matches program "${program.name}" by label or by cwd ${program.cwd}. ` +
      `Create one, or set "herdrWorkspace" on the program in control.json.`,
  );
};

export type StartedCycle = { agentName: string; tabId: string | null; paneId: string; reused: boolean };

const paneExists = async (paneId: string): Promise<boolean> => {
  try {
    await herdr(['pane', 'get', paneId]);
    return true;
  } catch {
    return false;
  }
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
      `${program.name} cycles`,
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

export const startCycleAgent = async (input: {
  program: Program;
  workspaceId: string;
  prompt: string;
  env: string[];
  remembered: string | null;
}): Promise<StartedCycle> => {
  const { program, prompt } = input;
  const agentName = `drovr-${program.name}`.slice(0, 32).toLowerCase();
  const pane = await cyclePane(input);

  await herdr(['agent', 'start', agentName, '--kind', 'claude', '--pane', pane.paneId]);
  // No --wait: the cycle runs for hours, and blocking here would defeat the point.
  await herdr(['agent', 'prompt', agentName, prompt]);

  return { agentName, ...pane };
};

export const agentState = async (agentName: string): Promise<string> => {
  try {
    const parsed = agentShape.safeParse(await herdr(['agent', 'get', agentName]));
    return parsed.success ? (parsed.data.result?.agent?.state ?? 'unknown') : 'unknown';
  } catch {
    // The agent exited or its pane closed — both mean the cycle is no longer running.
    return 'gone';
  }
};

export const interruptAgent = async (agentName: string): Promise<void> => {
  await herdr(['agent', 'send-keys', agentName, 'esc']);
};
