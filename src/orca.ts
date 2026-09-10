// src/orca.ts
//
// drovr's one interface to the runner's terminal. A cycle is an interactive claude
// session in an Orca terminal that Craig can read and talk to; drovr creates it, prompts
// it, watches it and — only once it has settled — releases it. Every caller speaks in
// program names; handles, tabs and worktree ids are this file's business.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Program } from './control.ts';
import { ExecTimedOut, explainSpawn, runBounded } from './exec.ts';
import { paths } from './paths.ts';
import { parsePreview, type Preview } from './preview.ts';

/** What a live claude in a terminal can be doing; `gone` is drovr's own: no claude there at all. */
export type AgentStatus = 'idle' | 'working' | 'blocked';
export type AgentState = AgentStatus | 'gone';

/**
 * Every orca call is a local socket round-trip and normally sub-second. Bounded because
 * `agentState` is reached from the tick's per-program loop, where a hung call holds the
 * tick lock that lock.ts can only reclaim from a dead holder.
 */
const ORCA_TIMEOUT_MS = 20_000;

/**
 * How long the TUI gets to settle before a claude is called `working`. `terminal wait`
 * returns the instant it is satisfied, so an idle runner costs nothing and a working one
 * costs exactly this per probe.
 */
const IDLE_PROBE_MS = 1_500;

/**
 * A cold `teamclaude run` is seconds to tens of seconds before claude is promptable, and
 * legitimately slower behind a trust dialog. Bounded generously: a ceiling that fires on a
 * healthy start refuses cycles for no reason, which is worse than the wedge it guards.
 */
const AGENT_START_TIMEOUT_MS = 90_000;

/** How long `terminal send` observes a prompt for proof the turn started. */
const PROMPT_SUBMIT_WAIT_S = 10;

/**
 * direnv may evaluate a whole .envrc — a version manager, a nix shell — so this is the
 * slowest of the local calls by a wide margin and gets the loosest ceiling.
 */
const DIRENV_TIMEOUT_MS = 30_000;

/**
 * Orca answers a refusal as an `ok: false` envelope on stdout and a non-zero exit, so the
 * envelope is the interface and the exit code only says to go and read it. A refusal
 * carries a code drovr branches on.
 */
export class OrcaRefused extends Error {
  code: string;
  constructor(shown: string, code: string) {
    super(`${shown} refused: ${code}`);
    this.code = code;
  }
}

const envelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string() }).passthrough() }),
]);

export const unwrap = (payload: unknown, shown: string): unknown => {
  const parsed = envelope.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`${shown} did not answer with an orca envelope: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  if (!parsed.data.ok) throw new OrcaRefused(shown, parsed.data.error.code);
  return parsed.data.result;
};

/** Codes that all mean "there is no such terminal" — the handle is stale or the tab is closed. */
const GONE_CODES = ['terminal_handle_stale', 'terminal_not_found', 'selector_not_found'];

const isGone = (error: unknown): boolean => error instanceof OrcaRefused && GONE_CODES.includes(error.code);

/** Raw envelope, unread. `orca()` below unwraps it; the pure parsers take the envelope itself. */
const orcaRaw = async (args: string[], timeoutMs = ORCA_TIMEOUT_MS): Promise<unknown> => {
  const shown = `orca ${args.join(' ')}`;
  const { stdout } = await runBounded('orca', [...args, '--json'], {
    timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    label: shown,
  }).catch((error: unknown) => {
    if (error instanceof ExecTimedOut) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw explainSpawn('orca', error);
    // A refusal exits non-zero with the envelope on stdout; that envelope is the answer.
    const printed = (error as { stdout?: unknown }).stdout;
    if (typeof printed === 'string' && envelope.safeParse(parseJson(printed)).success) {
      return { stdout: printed, stderr: '' };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${shown} failed: ${detail}`);
  });
  const parsed = parseJson(stdout);
  if (parsed === null) throw new Error(`${shown} did not return JSON. It printed: ${stdout.slice(0, 300)}`);
  return parsed;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const orca = async (args: string[], timeoutMs = ORCA_TIMEOUT_MS): Promise<unknown> =>
  unwrap(await orcaRaw(args, timeoutMs), `orca ${args.join(' ')}`);

const terminalShape = z.object({
  terminal: z
    .object({
      handle: z.string(),
      agentIdentity: z.string().nullable(),
      agentWait: z.unknown().optional(),
      title: z.string().optional(),
      worktreePath: z.string().optional(),
    })
    .passthrough(),
});

const shownTerminal = (show: unknown): z.infer<typeof terminalShape>['terminal'] | null => {
  let result: unknown;
  try {
    result = unwrap(show, 'orca terminal show');
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
  const parsed = terminalShape.safeParse(result);
  if (!parsed.success) {
    throw new Error(
      `orca terminal show did not report agentIdentity: ${JSON.stringify(result).slice(0, 300)}`,
    );
  }
  return parsed.data.terminal;
};

/**
 * What `terminal show` alone can decide. `agentWait` is orca's word for a claude parked on a
 * prompt only a human can answer — drovr's `blocked`. Null means orca looked and found none;
 * an absent field means an older host never looked, which is not evidence of anything.
 */
const occupancyFrom = (show: unknown): 'gone' | 'blocked' | 'occupied' => {
  const terminal = shownTerminal(show);
  if (terminal === null || terminal.agentIdentity === null) return 'gone';
  if (terminal.agentWait !== undefined && terminal.agentWait !== null) return 'blocked';
  return 'occupied';
};

const waitShape = z.object({ wait: z.object({ satisfied: z.boolean() }).passthrough() });

const idleSatisfied = (wait: unknown): boolean => {
  try {
    const result = unwrap(wait, 'orca terminal wait');
    const parsed = waitShape.safeParse(result);
    if (!parsed.success) throw new Error(`orca terminal wait did not report satisfied: ${JSON.stringify(result).slice(0, 300)}`);
    return parsed.data.wait.satisfied;
  } catch (error) {
    // A probe that ran out of time is the normal answer for a working claude.
    if (error instanceof OrcaRefused && error.code === 'timeout') return false;
    throw error;
  }
};

/** `show` is the `terminal show` envelope; `idle` the `terminal wait --for tui-idle` envelope. */
export const agentStateFrom = (show: unknown, idle: unknown): AgentState => {
  const occupancy = occupancyFrom(show);
  if (occupancy !== 'occupied') return occupancy;
  return idleSatisfied(idle) ? 'idle' : 'working';
};

const SETTLED: AgentState[] = ['idle', 'gone'];

/**
 * Only a settled session can act on `/exit`. Typed into a running turn it is swallowed by
 * that turn instead of executed, and typed at a dialog it is not read at all — either way
 * the terminal is held and every later cycle for the program is refused.
 */
export const isSettled = (state: AgentState): boolean => SETTLED.includes(state);

const readShape = z.object({ terminal: z.object({ tail: z.array(z.string()) }).passthrough() });

export const previewText = (read: unknown): string =>
  readShape.parse(unwrap(read, 'orca terminal read')).terminal.tail.join('\n');

const SAFE_WORD = /^[A-Za-z0-9_\-./=:@%+,]+$/;

/** `terminal create --command` hands the text to a shell, so every argument is quoted for one. */
export const shellCommand = (argv: string[]): string =>
  argv.map((arg) => (SAFE_WORD.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ');

/**
 * A handle is drovr's grip on a terminal, not an address a human can follow. Every message
 * about a held terminal names the tab and the command that opens it. Best effort by
 * construction — orca being unreachable costs the message its address, never the message.
 */
export type PaneAddress = { where: string; open: string | null };

export const terminalAddress = (show: unknown, handle: string): PaneAddress => {
  let terminal: z.infer<typeof terminalShape>['terminal'] | null;
  try {
    terminal = shownTerminal(show);
  } catch {
    terminal = null;
  }
  if (terminal === null || terminal.title === undefined || terminal.worktreePath === undefined) {
    return { where: `terminal ${handle}`, open: null };
  }
  return {
    where: `its "${terminal.title}" tab in ${basename(terminal.worktreePath)}`,
    open: `orca terminal switch --terminal ${handle}`,
  };
};

/**
 * The follow-me command on its own line, so it survives being read at the end of a
 * sentence and can be copied. Empty when orca could not name a tab.
 */
export const openLine = (address: PaneAddress): string =>
  address.open === null ? '' : `\n  look:  ${address.open}`;

const listShape = z.object({
  terminals: z.array(z.object({ handle: z.string(), tabId: z.string() }).passthrough()),
});

/**
 * Handles are runtime-scoped: an Orca restart invalidates every one, while the tab it
 * named is restored — with the claude session resumed in it. Losing track of that
 * terminal is how a runner ends up un-watched and its program admitted again on top of
 * it, so the tab id is the identity that survives.
 */
export const adoptHandle = (list: unknown, tabId: string): string | null => {
  const parsed = listShape.parse(unwrap(list, 'orca terminal list'));
  return parsed.terminals.find((terminal) => terminal.tabId === tabId)?.handle ?? null;
};

// ---------------------------------------------------------------------------------------
// The remembered terminal: one per program, on disk, because the process that started a
// cycle is not the one that watches its state on the next tick.

const rememberedShape = z.object({ handle: z.string(), tabId: z.string(), worktreeId: z.string() });
export type RememberedTerminal = z.infer<typeof rememberedShape>;

const terminalFile = (program: string): string => join(paths().programState(program), 'cycle-terminal.json');

/** Reached from inside the tick, so an unreadable file costs the identity, never the pass. */
export const rememberedTerminal = (program: string): RememberedTerminal | null => {
  const path = terminalFile(program);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    console.error(`could not read ${path}, treating ${program} as having no runner terminal: ${String(error)}`);
    return null;
  }
  const parsed = rememberedShape.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const rememberTerminal = (program: string, record: RememberedTerminal): void => {
  writeFileSync(terminalFile(program), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
};

const forgetTerminal = (program: string): void => {
  rmSync(terminalFile(program), { force: true });
};

// ---------------------------------------------------------------------------------------
// Live calls.

const showTerminal = (handle: string): Promise<unknown> => orcaRaw(['terminal', 'show', '--terminal', handle]);

const probeIdle = (handle: string): Promise<unknown> =>
  orcaRaw(
    ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(IDLE_PROBE_MS)],
    IDLE_PROBE_MS + ORCA_TIMEOUT_MS,
  );

/** State of the claude in one terminal. Two calls at most; the idle probe only when it can matter. */
export const agentState = async (handle: string): Promise<AgentState> => {
  const show = await showTerminal(handle);
  if (occupancyFrom(show) !== 'occupied') return agentStateFrom(show, null);
  return agentStateFrom(show, await probeIdle(handle));
};

/**
 * The live handle of a program's runner terminal, or null when there is none. A stale
 * handle is re-resolved through the remembered tab, and the file is rewritten so the
 * next reader pays nothing.
 */
export const runnerTerminal = async (program: string): Promise<string | null> => {
  const remembered = rememberedTerminal(program);
  if (remembered === null) return null;
  if (shownTerminal(await showTerminal(remembered.handle)) !== null) return remembered.handle;

  const list = await orcaRaw(['terminal', 'list', '--worktree', `id:${remembered.worktreeId}`]).catch(() => null);
  const adopted = list === null ? null : adoptHandle(list, remembered.tabId);
  if (adopted === null) return null;
  rememberTerminal(program, { ...remembered, handle: adopted });
  return adopted;
};

export const runnerState = async (program: string): Promise<AgentState> => {
  const handle = await runnerTerminal(program);
  return handle === null ? 'gone' : agentState(handle);
};

export const runnerAddress = async (program: string): Promise<PaneAddress> => {
  const handle = await runnerTerminal(program).catch(() => null);
  if (handle === null) return { where: `no terminal (${program} has never run, or its terminal is closed)`, open: null };
  return terminalAddress(await showTerminal(handle).catch(() => null), handle);
};

const baseUrlCache = new Map<string, string | null>();

/**
 * The aice install lives in the program repo's .envrc, so the only honest source is
 * direnv. Cached per process: a watch frame redraws every few seconds and must not shell
 * out per program each time.
 */
export const aiceBaseUrl = async (program: Program): Promise<string | null> => {
  const cached = baseUrlCache.get(program.name);
  if (cached !== undefined) return cached;

  const resolved = await runBounded(
    'direnv',
    ['exec', program.cwd, 'sh', '-c', 'printf %s "$AICE_BASE_URL"'],
    { timeoutMs: DIRENV_TIMEOUT_MS },
  )
    .then(({ stdout }) => (stdout.trim() === '' ? null : stdout.trim()))
    .catch(() => null);

  baseUrlCache.set(program.name, resolved);
  return resolved;
};

const worktreeShape = z.object({ worktree: z.object({ id: z.string() }).passthrough() });

/**
 * The Orca worktree whose checkout is the program's cwd. Orca only opens terminals in
 * worktrees it knows, and registering one is a decision about Craig's workspace, so a
 * missing one is refused with the command that fixes it rather than fixed silently.
 */
export const resolveWorktree = async (program: Program): Promise<string> => {
  try {
    return worktreeShape.parse(await orca(['worktree', 'show', '--worktree', `path:${program.cwd}`])).worktree.id;
  } catch (error) {
    if (!isGone(error)) throw error;
    throw new Error(
      `orca has no worktree at ${program.cwd}, so ${program.name} has nowhere to run. ` +
        `Register it:  orca repo add --path ${program.cwd}`,
    );
  }
};

export type StartedCycle = { handle: string; tabId: string };

/**
 * The terminal holds a session that is not ours to end. Distinct from a crash: nothing
 * went wrong, the cycle simply did not start, and the next tick should try again without
 * it counting against the program.
 */
export class PaneBusy extends Error {}

export const cycleTabLabel = (program: string): string => `${program} cycles`;

const closeTerminal = async (handle: string): Promise<void> => {
  await orca(['terminal', 'close', '--terminal', handle]).catch((error: unknown) => {
    if (!isGone(error)) throw error;
  });
};

/**
 * A finished cycle leaves its claude idle at the prompt, or a bare shell once released.
 * Either is drovr's own leftover and is cleared before the new terminal is made, so a
 * program keeps one cycle tab rather than accreting one per cycle. Anything still working
 * or waiting on a dialog is left strictly alone.
 */
const clearLeftover = async (program: Program): Promise<void> => {
  const handle = await runnerTerminal(program.name);
  if (handle === null) return;
  const state = await agentState(handle);
  if (state === 'idle' && !(await releaseAgent(handle))) {
    throw new PaneBusy(`${program.name}'s previous runner would not exit. The next tick tries again.`);
  }
  if (state === 'working' || state === 'blocked') {
    const address = terminalAddress(await showTerminal(handle).catch(() => null), handle);
    throw new PaneBusy(
      `${program.name} already has a live session in ${address.where} (${state}). ` +
        'Leaving it alone — it is either still working or being used. ' +
        `The next tick tries again.${openLine(address)}`,
    );
  }
  await closeTerminal(handle);
  forgetTerminal(program.name);
};

const createdShape = z.object({ terminal: z.object({ handle: z.string(), tabId: z.string() }).passthrough() });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded: claude takes seconds to appear behind `teamclaude run`; a shell that never grows one has crashed. */
const waitForClaude = async (handle: string, attempts = 30): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const terminal = shownTerminal(await showTerminal(handle));
    if (terminal === null) return false;
    if (terminal.agentIdentity !== null) return true;
    await sleep(3_000);
  }
  return false;
};

/**
 * Opens the cycle's terminal and prompts the claude in it. drovr does not own the
 * process: the command is orca's to run and the session is Craig's to talk to. `command`
 * is the full argv (direnv, teamclaude and claude's own flags) — the proxy comes from
 * `teamclaude run`, exactly as Craig's own `claude` alias does.
 */
export const startCycleAgent = async (input: {
  program: Program;
  worktreeId: string;
  command: string[];
  prompt: string;
}): Promise<StartedCycle> => {
  const { program, worktreeId, command, prompt } = input;
  await clearLeftover(program);

  const created = createdShape.parse(
    await orca([
      'terminal',
      'create',
      '--worktree',
      `id:${worktreeId}`,
      '--title',
      cycleTabLabel(program.name),
      '--command',
      shellCommand(command),
    ]),
  ).terminal;
  const started = { handle: created.handle, tabId: created.tabId };
  rememberTerminal(program.name, { ...started, worktreeId });

  if (!(await waitForClaude(started.handle))) {
    throw new Error(`${program.name}'s runner exited before claude came up — check ${terminalAddress(null, started.handle).where}`);
  }
  await orcaRaw(
    ['terminal', 'wait', '--terminal', started.handle, '--for', 'tui-idle', '--timeout-ms', String(AGENT_START_TIMEOUT_MS)],
    AGENT_START_TIMEOUT_MS + ORCA_TIMEOUT_MS,
  );

  // A trust dialog settles the TUI too, so idle alone is not promptable. The agent is
  // live and its terminal is remembered; the next tick prompts it once Craig answers.
  const state = await agentState(started.handle);
  if (state !== 'idle') {
    const address = terminalAddress(await showTerminal(started.handle).catch(() => null), started.handle);
    throw new PaneBusy(
      `${program.name} started but is ${state} in ${address.where} — answer whatever it is ` +
        `waiting on there and the next tick will prompt it.${openLine(address)}`,
    );
  }

  await promptAgent(started.handle, prompt);
  return started;
};

/**
 * An interactive claude session cannot exit itself — it finishes its turn and idles at
 * the prompt forever. Once the runner has written its report the cycle has declared
 * itself done, so releasing the terminal is cleanup, not a kill. Refuses rather than
 * sends while the session is not settled, which is what makes it retryable: the next
 * tick finds the agent idle and releases it then.
 */
export const releaseAgent = async (handle: string): Promise<boolean> => {
  let state = await agentState(handle);
  for (let attempt = 0; attempt < 10 && !isSettled(state); attempt += 1) {
    await sleep(3_000);
    state = await agentState(handle);
  }
  if (state === 'gone') {
    await closeTerminal(handle);
    return true;
  }
  if (!isSettled(state)) return false;

  await orca(['terminal', 'send', '--terminal', handle, '--text', '/exit', '--enter']).catch(() => ({}));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(2_000);
    if ((await agentState(handle)) === 'gone') {
      await closeTerminal(handle);
      return true;
    }
  }
  return false;
};

/** Release by program: true when nothing is left holding a terminal for it. */
export const releaseRunner = async (program: string): Promise<boolean> => {
  const handle = await runnerTerminal(program);
  if (handle === null) return true;
  const released = await releaseAgent(handle);
  if (released) forgetTerminal(program);
  return released;
};

/** Submits a prompt to a live session — how a cycle is started, and how a stalled one is restarted. */
export const promptAgent = async (handle: string, prompt: string): Promise<void> => {
  await orca(
    ['terminal', 'send', '--terminal', handle, '--text', prompt, '--enter', '--wait-submit', String(PROMPT_SUBMIT_WAIT_S)],
    PROMPT_SUBMIT_WAIT_S * 1_000 + ORCA_TIMEOUT_MS,
  );
};

const requireRunner = async (program: string): Promise<string> => {
  const handle = await runnerTerminal(program);
  if (handle === null) throw new Error(`${program} has no runner terminal`);
  return handle;
};

export const promptRunner = async (program: string, prompt: string): Promise<void> =>
  promptAgent(await requireRunner(program), prompt);

/** An interrupt, not a kill: the runner gets to wind down and write its report. */
export const interruptRunner = async (program: string): Promise<void> => {
  await orca(['terminal', 'send', '--terminal', await requireRunner(program), '--interrupt']);
};

/**
 * Closes a program's cycle terminal only when no claude is in it. A terminal still
 * holding a session is left alone whatever its age — a stray shell is untidy, a closed
 * live session is lost work. Returns the closed handle, or null when nothing was.
 */
export const tidyRunnerTerminal = async (program: string): Promise<string | null> => {
  const handle = await runnerTerminal(program);
  if (handle === null) return null;
  if ((await agentState(handle)) !== 'gone') return null;
  await closeTerminal(handle);
  forgetTerminal(program);
  return handle;
};

/**
 * Best-effort by design: a program with no live terminal, an orca that is down, or a
 * claude whose TUI changed all mean "no preview", never a failed tick. The failure is
 * returned rather than logged — a caller drawing a frame is the only one who knows where
 * a diagnostic can land without becoming an unsolicited terminal write.
 */
export const readPreview = async (
  program: string,
): Promise<{ preview: Preview | null; warning: string | null }> => {
  try {
    const handle = await runnerTerminal(program);
    if (handle === null) return { preview: null, warning: `preview unavailable for ${program}: no runner terminal` };
    const read = await orcaRaw(['terminal', 'read', '--terminal', handle, '--limit', '40']);
    return { preview: parsePreview(previewText(read)), warning: null };
  } catch (error) {
    const [firstLine] = explainSpawn('orca', error).message.split('\n');
    return { preview: null, warning: `preview unavailable for ${program}: ${firstLine ?? ''}` };
  }
};
