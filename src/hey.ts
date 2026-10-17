import { existsSync, readFileSync } from 'node:fs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { z } from 'zod';
import {
  messageShape, NOT_FOUND_PREFIX, prefsShape, statusRowShape, type MessageRow, type Prefs, type Profile, type StatusRow,
} from '../lambda/hey/handler.ts';

export const POLL_MS = 5_000;
/** Consecutive, not total: a flaky network that still answers is not a lost wait. */
export const MAX_POLL_FAILURES = 5;
const MAX_WAIT_SECONDS = 86_400;

export class UsageError extends Error {}

export const USAGE =
  'usage: hey [send] [--to <handle>] [--from <label>] [--host <host>] [--cwd <dir>] [--wait <dur>] [--choices a,b] [--json] <text>\n' +
  '       hey profile --from <label> [--icon <icon>] [--summary <text>] [--color #rrggbb]   |   hey prefs   |   hey status [--json]   |   hey help [command]\n' +
  '       --multi with --choices lets several answers be picked; the reply is them joined by ", "';

export const parseDuration = (text: string): number => {
  const match = /^(\d+)([smh])$/.exec(text);
  if (match === null) throw new UsageError(`--wait takes a duration like 90s, 30m or 2h, not "${text}"`);
  const unit = { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  const seconds = Number(match[1]) * unit;
  if (seconds < 1 || seconds > MAX_WAIT_SECONDS) throw new UsageError(`--wait must be between 1s and 24h, not "${text}"`);
  return seconds;
};

export const COMMAND_NAMES = ['send', 'profile', 'prefs', 'status', 'guide', 'help'] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

/** The first word is a command only when it names one; everything else is the message it always was. */
export const commandOf = (argv: string[]): { command: CommandName; rest: string[] } => {
  const first = argv[0];
  const named = COMMAND_NAMES.find((name) => name === first);
  return named === undefined ? { command: 'send', rest: argv } : { command: named, rest: argv.slice(1) };
};

const MAX_CHOICES = 4;
const MAX_CHOICE_CHARS = 24;

/** Mirrors the Lambda's `choicesShape`, so a bad list is refused here with the usage line rather than as a bad_request after a round trip. */
export const parseChoices = (text: string): string[] => {
  const choices = text.split(',').map((choice) => choice.trim());
  if (choices.length < 2 || choices.length > MAX_CHOICES) throw new UsageError(`--choices takes 2 to ${MAX_CHOICES} comma-separated answers, not "${text}"`);
  if (choices.some((choice) => choice === '')) throw new UsageError(`--choices has an empty answer in "${text}"`);
  const long = choices.find((choice) => choice.length > MAX_CHOICE_CHARS);
  if (long !== undefined) throw new UsageError(`--choices: "${long}" is over ${MAX_CHOICE_CHARS} characters`);
  if (new Set(choices).size !== choices.length) throw new UsageError(`--choices repeats an answer in "${text}"`);
  return choices;
};

export type Parsed = {
  to: string;
  from: string;
  host: string;
  cwd: string;
  text: string;
  waitSeconds: number | null;
  choices: string[] | null;
  multi: boolean;
  json: boolean;
};

const VALUE_FLAGS = ['--to', '--from', '--host', '--cwd', '--wait', '--choices'] as const;

const noRecipient = (): UsageError =>
  new UsageError('no recipient: pass --to or HEY_TO, or put {"to": "<handle>"} in ~/.config/hey.json');

export const parseArgs = (
  argv: string[],
  defaults: { to: string | null; from: string | null; host: string; cwd: string },
): Parsed => {
  const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
  let json = false;
  let multi = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--multi') {
      multi = true;
      continue;
    }
    const flag = VALUE_FLAGS.find((known) => known === arg);
    if (flag === undefined) {
      if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
      positional.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    values[flag] = value;
    i += 1;
  }
  if (positional.length !== 1) throw new UsageError(`exactly one message text, quoted`);
  const text = positional[0]!;
  if (text.trim() === '') throw new UsageError('the message text is blank');
  const to = values['--to'] ?? defaults.to;
  if (to === null) throw noRecipient();
  const host = values['--host'] ?? defaults.host;
  const cwd = values['--cwd'] ?? defaults.cwd;
  const waitSeconds = values['--wait'] === undefined ? null : parseDuration(values['--wait']);
  const choices = values['--choices'] === undefined ? null : parseChoices(values['--choices']);
  if (choices !== null && waitSeconds === null) throw new UsageError('--choices needs --wait: nobody would read the answer');
  if (multi && choices === null) throw new UsageError('--multi needs --choices: there is nothing to pick several of');
  return {
    to,
    from: values['--from'] ?? defaults.from ?? `${host}:${cwd}`,
    host,
    cwd,
    text,
    waitSeconds,
    choices,
    multi,
    json,
  };
};

const configShape = z.object({ to: z.string().min(1).optional(), from: z.string().min(1).optional() });

/** Any flag that asks for usage wins over everything else on the line. */
export const wantsHelp = (argv: string[]): boolean => argv.includes('--help') || argv.includes('-h');

const parseJsonFile = (path: string): unknown => {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const readConfig = (path: string): { to: string | null; from: string | null } => {
  if (!existsSync(path)) return { to: null, from: null };
  const parsed = configShape.safeParse(parseJsonFile(path));
  if (!parsed.success) {
    throw new Error(`${path} is not {"to"?: string, "from"?: string}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return { to: parsed.data.to ?? null, from: parsed.data.from ?? null };
};

export type Invoke = (payload: Record<string, unknown>) => Promise<unknown>;

export type SendInput = {
  to: string;
  from: string;
  host: string;
  cwd: string;
  text: string;
  waitSeconds: number | null;
  choices: string[] | null;
  multi: boolean;
};

const sendResponseShape = z.object({
  id: z.string().min(1),
  pk: z.string().min(1),
  createdAt: z.string(),
  waitUntil: z.string().nullable(),
  pushed: z.boolean(),
  /** Default, so a Lambda not yet redeployed still parses. */
  quiet: z.boolean().default(false),
  reason: z.string().optional(),
});
export type SendResponse = z.infer<typeof sendResponseShape>;

export const send = async (invoke: Invoke, input: SendInput): Promise<SendResponse> => {
  const { waitSeconds, choices, multi, ...rest } = input;
  const payload = {
    action: 'send',
    ...rest,
    ...(waitSeconds === null ? {} : { waitSeconds }),
    ...(choices === null ? {} : { choices }),
    ...(multi ? { multi } : {}),
  };
  return sendResponseShape.parse(await invoke(payload));
};

/** The row a wait was polling is gone: Craig deleted the thread on the phone. Not a poll failure. */
export class MessageGone extends Error {
  constructor(id: string) {
    super(`message ${id} was deleted on the phone`);
  }
}

export const readMessage = async (invoke: Invoke, pk: string, id: string): Promise<MessageRow> => {
  try {
    return messageShape.parse(await invoke({ action: 'read', pk, id }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(NOT_FOUND_PREFIX)) throw new MessageGone(id);
    throw error;
  }
};

export const readPrefs = async (invoke: Invoke, to: string): Promise<Prefs> =>
  prefsShape.parse(await invoke({ action: 'prefs', to }));

const statusAckShape = z.object({ pk: z.string().min(1), sk: z.string().min(1), at: z.string(), expiresAt: z.number() });
export type StatusAck = z.infer<typeof statusAckShape>;

export type StatusInput = { to: string; host: string; at: string; payload: string };

/** drovr's once-a-tick status row; `payload` is the `drovr status --json` text, validated by the Lambda. */
export const putStatus = async (invoke: Invoke, input: StatusInput): Promise<StatusAck> =>
  statusAckShape.parse(await invoke({ action: 'status', ...input }));

export const readStatuses = async (invoke: Invoke, to: string): Promise<StatusRow[]> =>
  z.array(statusRowShape).parse(await invoke({ action: 'readStatus', to }));

/** `hey status` takes no text and no wait; anything but --to and --json is a usage error. */
export const parseStatusArgs = (argv: string[], defaults: { to: string | null }): { to: string; json: boolean } => {
  let to = defaults.to;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--to') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError('--to needs a value');
      to = value;
      i += 1;
      continue;
    }
    throw new UsageError(`hey status takes --to and --json only, not "${arg}"`);
  }
  if (to === null) throw noRecipient();
  return { to, json };
};

/** Read leniently: this is a summary line over a payload drovr owns, and a missing field costs a word, not the line. */
const statusSummaryShape = z.object({
  mode: z.string().optional(),
  capacity: z.object({ cyclesFundable: z.number().nullable(), bindingBucket: z.string() }).nullable().optional(),
  programs: z.array(z.unknown()).optional(),
});

export const describeStatusRow = (row: StatusRow, nowMs: number): string => {
  const parsed = statusSummaryShape.safeParse(JSON.parse(row.payload));
  const summary = parsed.success ? parsed.data : {};
  const ageMinutes = Math.max(0, Math.floor((nowMs - Date.parse(row.at)) / 60_000));
  const capacity = summary.capacity ?? null;
  const funding =
    capacity === null || capacity.cyclesFundable === null
      ? 'no capacity figure'
      : `${capacity.cyclesFundable.toFixed(2)} cycles fundable · ${capacity.bindingBucket} binding`;
  return `drovr@${row.host}  ${row.at} (${ageMinutes}m ago)  ${summary.mode ?? '?'} · ${funding} · ${summary.programs?.length ?? 0} programs`;
};

const profileShape = z.object({
  from: z.string(),
  icon: z.string().nullable(),
  summary: z.string().nullable(),
  color: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type ProfileInput = { to: string; from: string; icon?: string; summary?: string; color?: string };

/** Only the fields given travel: the Lambda merges, and an absent field must not read as "clear". */
export const setProfile = async (invoke: Invoke, input: ProfileInput): Promise<Profile> => {
  const payload: Record<string, unknown> = { action: 'profile', to: input.to, from: input.from };
  for (const field of ['icon', 'summary', 'color'] as const) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  return profileShape.parse(await invoke(payload));
};

/** `--flag value` pairs from a fixed set; a positional or an unknown flag is a usage error naming it. */
const flagValues = (argv: string[], known: readonly string[]): Map<string, string> => {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!known.includes(arg)) throw new UsageError(arg.startsWith('--') ? `unknown flag ${arg}` : `unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    values.set(arg, value);
    i += 1;
  }
  return values;
};

export const parseProfileArgs = (argv: string[], defaults: { to: string | null }): ProfileInput => {
  const values = flagValues(argv, ['--to', '--from', '--icon', '--summary', '--color']);
  const from = values.get('--from');
  if (from === undefined) throw new UsageError('hey profile needs --from <label>: the sender whose profile this is');
  const to = values.get('--to') ?? defaults.to;
  if (to === null) throw noRecipient();
  const input: ProfileInput = { to, from };
  const icon = values.get('--icon');
  const summary = values.get('--summary');
  const color = values.get('--color');
  if (icon !== undefined) input.icon = icon;
  if (summary !== undefined) input.summary = summary;
  if (color !== undefined) input.color = color;
  return input;
};

export const parsePrefsArgs = (argv: string[], defaults: { to: string | null }): { to: string } => {
  const to = flagValues(argv, ['--to']).get('--to') ?? defaults.to;
  if (to === null) throw noRecipient();
  return { to };
};

export type WaitOutcome =
  | { status: 'replied'; reply: string; repliedAt: string }
  | { status: 'unanswered' }
  | { status: 'deleted' }
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
      // Nobody will answer a message that no longer exists; it is an outcome, not a flaky poll.
      if (error instanceof MessageGone) return { status: 'deleted' };
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

export const REGION = 'ca-central-1';
export const FUNCTION_NAME = 'hey';
/** A bare name resolves in the caller's own account. A sender in another account (a Hadrian box, whose
 *  role is granted on the Lambda) must name the full ARN: HEY_FUNCTION=arn:aws:lambda:ca-central-1:…:function:hey */
export const functionName = (env: NodeJS.ProcessEnv = process.env): string => env.HEY_FUNCTION ?? FUNCTION_NAME;
/** One network call, and the Lambda itself is capped at 10s. */
const INVOKE_TIMEOUT_MS = 15_000;

const errorPayloadShape = z.object({ errorMessage: z.string() });

/** The error payload is read leniently: a timeout arrives as plain text, not JSON. */
export const invokeResult = (functionError: string | undefined, payload: Uint8Array | undefined): unknown => {
  if (payload === undefined || payload.length === 0) throw new Error('the hey lambda returned an empty response');
  const text = new TextDecoder().decode(payload);
  if (functionError === undefined) return JSON.parse(text);
  try {
    const parsed = errorPayloadShape.safeParse(JSON.parse(text));
    throw new Error(parsed.success ? parsed.data.errorMessage : text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(text);
    throw error;
  }
};

/**
 * The default credential chain and nothing else: the Mac's default profile, a scoped
 * user's keys in the environment elsewhere. maxAttempts 1 because a retried send is a
 * duplicate message, and a retried read is the wait loop's job.
 */
export const lambdaInvoke = (): Invoke => {
  const client = new LambdaClient({
    region: REGION,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: INVOKE_TIMEOUT_MS, requestTimeout: INVOKE_TIMEOUT_MS },
  });
  return async (payload) => {
    const out = await client.send(
      new InvokeCommand({ FunctionName: functionName(), Payload: new TextEncoder().encode(JSON.stringify(payload)) }),
    );
    return invokeResult(out.FunctionError, out.Payload);
  };
};
