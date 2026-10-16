import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { messageShape, type MessageRow } from '../lambda/hey/handler.ts';

export const POLL_MS = 5_000;
/** Consecutive, not total: a flaky network that still answers is not a lost wait. */
export const MAX_POLL_FAILURES = 5;
const MAX_WAIT_SECONDS = 86_400;

export class UsageError extends Error {}

export const USAGE = 'usage: hey [--to <handle>] [--from <label>] [--host <host>] [--cwd <dir>] [--wait <dur>] [--json] <text>';

export const parseDuration = (text: string): number => {
  const match = /^(\d+)([smh])$/.exec(text);
  if (match === null) throw new UsageError(`--wait takes a duration like 90s, 30m or 2h, not "${text}"`);
  const unit = { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  const seconds = Number(match[1]) * unit;
  if (seconds < 1 || seconds > MAX_WAIT_SECONDS) throw new UsageError(`--wait must be between 1s and 24h, not "${text}"`);
  return seconds;
};

export type Parsed = { to: string; from: string; host: string; cwd: string; text: string; waitSeconds: number | null; json: boolean };

const VALUE_FLAGS = ['--to', '--from', '--host', '--cwd', '--wait'] as const;

export const parseArgs = (
  argv: string[],
  defaults: { to: string | null; from: string | null; host: string; cwd: string },
): Parsed => {
  const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  let json = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    const flag = VALUE_FLAGS.find((known) => known === arg);
    if (flag === undefined) {
      if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}\n${USAGE}`);
      positional.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value\n${USAGE}`);
    values[flag] = value;
    i += 1;
  }
  if (positional.length !== 1) throw new UsageError(`exactly one message text, quoted\n${USAGE}`);
  const text = positional[0]!;
  if (text.trim() === '') throw new UsageError('the message text is blank');
  const to = values['--to'] ?? defaults.to;
  if (to === null) throw new UsageError('no recipient: pass --to or HEY_TO, or put {"to": "<handle>"} in ~/.config/hey.json');
  const host = values['--host'] ?? defaults.host;
  const cwd = values['--cwd'] ?? defaults.cwd;
  return {
    to,
    from: values['--from'] ?? defaults.from ?? `${host}:${cwd}`,
    host,
    cwd,
    text,
    waitSeconds: values['--wait'] === undefined ? null : parseDuration(values['--wait']),
    json,
  };
};

const configShape = z.object({ to: z.string().min(1).optional(), from: z.string().min(1).optional() });

export const readConfig = (path: string): { to: string | null; from: string | null } => {
  if (!existsSync(path)) return { to: null, from: null };
  const parsed = configShape.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${path} is not {"to"?: string, "from"?: string}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return { to: parsed.data.to ?? null, from: parsed.data.from ?? null };
};

export type Invoke = (payload: Record<string, unknown>) => Promise<unknown>;

export type SendInput = { to: string; from: string; host: string; cwd: string; text: string; waitSeconds: number | null };

const sendResponseShape = z.object({
  id: z.string().min(1),
  pk: z.string().min(1),
  createdAt: z.string(),
  waitUntil: z.string().nullable(),
  pushed: z.boolean(),
  reason: z.string().optional(),
});
export type SendResponse = z.infer<typeof sendResponseShape>;

export const send = async (invoke: Invoke, input: SendInput): Promise<SendResponse> => {
  const { waitSeconds, ...rest } = input;
  const payload = { action: 'send', ...rest, ...(waitSeconds === null ? {} : { waitSeconds }) };
  return sendResponseShape.parse(await invoke(payload));
};

export const readMessage = async (invoke: Invoke, pk: string, id: string): Promise<MessageRow> =>
  messageShape.parse(await invoke({ action: 'read', pk, id }));

export type WaitOutcome =
  | { status: 'replied'; reply: string; repliedAt: string }
  | { status: 'unanswered' }
  | { status: 'failed'; reason: string };

/**
 * Bounded twice: by the window, and by consecutive failures. A reply is `reply` being
 * present, never truthy — "" is an answer someone typed.
 */
export const waitForReply = async (opts: {
  read: () => Promise<MessageRow>;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  waitUntilMs: number;
  onPollError: (reason: string) => void;
}): Promise<WaitOutcome> => {
  const maxPolls = Math.ceil((opts.waitUntilMs - opts.nowMs()) / POLL_MS) + 1;
  let failures = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    try {
      const row = await opts.read();
      failures = 0;
      if (row.reply !== undefined) return { status: 'replied', reply: row.reply, repliedAt: row.repliedAt ?? '' };
    } catch (error) {
      failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (failures >= MAX_POLL_FAILURES) return { status: 'failed', reason };
      opts.onPollError(reason);
    }
    if (opts.nowMs() >= opts.waitUntilMs) break;
    await opts.sleep(POLL_MS);
  }
  return { status: 'unanswered' };
};
