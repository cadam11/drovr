import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NOT_FOUND_PREFIX, prefsShape, statusRowShape, type Prefs, type Profile, type StatusRow } from '../lambda/hey/handler.ts';
import { credentialsPath, DEFAULT_ENDPOINT, toolCaller } from './hey-http.ts';

export const POLL_MS = 5_000;
/** Consecutive, not total: a flaky network that still answers is not a lost wait. */
export const MAX_POLL_FAILURES = 5;
const MAX_WAIT_SECONDS = 86_400;

export class UsageError extends Error {}

export const USAGE =
  'usage: hey [send] [--to <handle>] [--from <label>] [--host <host>] [--cwd <dir>] [--wait <dur>] [--choices a,b] [--json] <text>\n' +
  '       hey profile --from <label> [--icon <icon>] [--summary <text>] [--color #rrggbb]   |   hey prefs   |   hey status [--json]   |   hey login | logout | whoami   |   hey help [command]\n' +
  '       --multi with --choices lets several answers be picked; the reply is them joined by ", "';

export const parseDuration = (text: string): number => {
  const match = /^(\d+)([smh])$/.exec(text);
  if (match === null) throw new UsageError(`--wait takes a duration like 90s, 30m or 2h, not "${text}"`);
  const unit = { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  const seconds = Number(match[1]) * unit;
  if (seconds < 1 || seconds > MAX_WAIT_SECONDS) throw new UsageError(`--wait must be between 1s and 24h, not "${text}"`);
  return seconds;
};

export const COMMAND_NAMES = ['send', 'profile', 'prefs', 'status', 'login', 'logout', 'whoami', 'guide', 'help'] as const;
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

const configShape = z.object({
  to: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  /** A second deployment, one day; the credentials file's issuer must be this URL's origin. */
  endpoint: z.string().url().startsWith('https://').optional(),
});

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

export const readConfig = (path: string): { to: string | null; from: string | null; endpoint: string } => {
  if (!existsSync(path)) return { to: null, from: null, endpoint: DEFAULT_ENDPOINT };
  const parsed = configShape.safeParse(parseJsonFile(path));
  if (!parsed.success) {
    throw new Error(`${path} is not {"to"?: string, "from"?: string, "endpoint"?: "https://…"}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  return { to: parsed.data.to ?? null, from: parsed.data.from ?? null, endpoint: parsed.data.endpoint ?? DEFAULT_ENDPOINT };
};

/** One MCP tool call: the tool's name and arguments in, its structured result out; every caller parses it with zod. */
export type Call = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The caller every command and drovr's own sends use: the config's endpoint, the credentials file under `home`, the real clock. */
export const defaultCaller = (home: string = homedir()): Call =>
  toolCaller({ http: fetch, endpoint: readConfig(join(home, '.config', 'hey.json')).endpoint, path: credentialsPath(home), nowMs: Date.now });

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
  createdAt: z.string(),
  waitUntil: z.string().nullable(),
  pushed: z.boolean(),
  quiet: z.boolean(),
  reason: z.string().nullable(),
});
export type SendResponse = z.infer<typeof sendResponseShape>;

export const send = async (call: Call, input: SendInput): Promise<SendResponse> => {
  const { waitSeconds, choices, multi, ...rest } = input;
  return sendResponseShape.parse(
    await call('send', { ...rest, ...(waitSeconds === null ? {} : { waitSeconds }), ...(choices === null ? {} : { choices }), ...(multi ? { multi } : {}) }),
  );
};

/** The row a wait was polling is gone: Craig deleted the thread on the phone. Not a poll failure. */
export class MessageGone extends Error {
  constructor(id: string) {
    super(`message ${id} was deleted on the phone`);
  }
}

/** The `read` tool's shape (tools.ts `publicMessage`): absent becomes null there, so "answered" is `reply !== null` here. */
export const publicMessageShape = z.object({ id: z.string().min(1), text: z.string(), waitUntil: z.string().nullable(), reply: z.string().nullable(), repliedAt: z.string().nullable() });
export type PublicMessage = z.infer<typeof publicMessageShape>;

export const readMessage = async (call: Call, id: string): Promise<PublicMessage> => {
  try {
    return publicMessageShape.parse(await call('read', { id }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(NOT_FOUND_PREFIX)) throw new MessageGone(id);
    throw error;
  }
};

export const readPrefs = async (call: Call, to: string): Promise<Prefs> => z.object({ prefs: prefsShape }).parse(await call('prefs', { to })).prefs;

const statusAckShape = z.object({ sk: z.string().min(1), at: z.string(), expiresAt: z.number() });
export type StatusAck = z.infer<typeof statusAckShape>;

export type StatusInput = { to: string; host: string; at: string; payload: string };

/** drovr's once-a-tick status row; `payload` is the `drovr status --json` text, validated by the handler. */
export const putStatus = async (call: Call, input: StatusInput): Promise<StatusAck> => statusAckShape.parse(await call('putStatus', { ...input }));

export const readStatuses = async (call: Call, to: string): Promise<StatusRow[]> => z.object({ status: z.array(statusRowShape) }).parse(await call('status', { to })).status;

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

/** Only the fields given travel: the handler merges, and an absent field must not read as "clear". */
export const setProfile = async (call: Call, input: ProfileInput): Promise<Profile> => {
  const payload: Record<string, unknown> = { to: input.to, from: input.from };
  for (const field of ['icon', 'summary', 'color'] as const) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  return z.object({ profile: profileShape }).parse(await call('profile', payload)).profile;
};

const whoamiShape = z.object({ email: z.string().min(1), handle: z.string().min(1), sub: z.string().min(1) });
export type Whoami = z.infer<typeof whoamiShape>;
export const whoami = async (call: Call): Promise<Whoami> => whoamiShape.parse(await call('whoami', {}));

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
  read: () => Promise<{ reply: string | null; repliedAt: string | null }>;
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
      if (row.reply !== null) return { status: 'replied', reply: row.reply, repliedAt: row.repliedAt ?? '' };
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
