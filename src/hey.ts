import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NOT_FOUND_PREFIX, prefsShape, PROGRAM_PATTERN, statusRowShape, type Prefs, type Profile, type StatusRow } from './hey-wire.ts';
import { credentialsPath, DEFAULT_ENDPOINT, toolCaller } from './hey-http.ts';
import { accountsFromTeamclaude, statusAccountShape } from './status-accounts.ts';
import { statusShape as teamclaudeStatusShape } from './teamclaude.ts';

export const POLL_MS = 5_000;
/** Consecutive, not total: a flaky network that still answers is not a lost wait. */
export const MAX_POLL_FAILURES = 5;
const MAX_WAIT_SECONDS = 86_400;

export class UsageError extends Error {}

export const USAGE =
  'usage: hey [send] [--to <handle>] [--from <label>] [--host <host>] [--cwd <dir>] [--wait <dur>] [--choices a,b] [--detach] [--json] <text>\n' +
  '       hey wait <id> [--wait <dur>] [--json]   |   hey profile --from <label> [--icon <icon>] [--summary <text>] [--color #rrggbb]   |   hey prefs   |   hey status [--json]   |   hey status put --program <name> [--host <host>] [--teamclaude] -   |   hey login | logout | whoami   |   hey help [command]\n' +
  '       --multi with --choices lets several answers be picked; the reply is them joined by ", "';

export const parseDuration = (text: string): number => {
  const match = /^(\d+)([smh])$/.exec(text);
  if (match === null) throw new UsageError(`--wait takes a duration like 90s, 30m or 2h, not "${text}"`);
  const unit = { s: 1, m: 60, h: 3600 }[match[2] as 's' | 'm' | 'h'];
  const seconds = Number(match[1]) * unit;
  if (seconds < 1 || seconds > MAX_WAIT_SECONDS) throw new UsageError(`--wait must be between 1s and 24h, not "${text}"`);
  return seconds;
};

export const COMMAND_NAMES = ['send', 'wait', 'profile', 'prefs', 'status', 'login', 'logout', 'whoami', 'guide', 'help'] as const;
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
  detach: boolean;
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
  let detach = false;
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
    if (arg === '--detach') {
      detach = true;
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
  if (detach && waitSeconds === null) throw new UsageError('--detach needs --wait: without a window nothing listens for the reply');
  return {
    to,
    from: values['--from'] ?? defaults.from ?? `${host}:${cwd}`,
    host,
    cwd,
    text,
    waitSeconds,
    choices,
    multi,
    detach,
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
export const publicMessageShape = z.object({ id: z.string().min(1), from: z.string(), text: z.string(), createdAt: z.string(), waitUntil: z.string().nullable(), reply: z.string().nullable(), repliedAt: z.string().nullable() });
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

export type StatusInput = { to: string; program?: string; host: string; at: string; payload: string };

/** One status row: drovr's tick omits `program` (the handler defaults it); any other writer names itself. `payload` is JSON text the handler checks is an object. */
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

export const GENERIC_STATUS_MAX_LINES = 20;

const lineShape = z.object({
  label: z.string().min(1).max(40),
  value: z.string().max(120),
  state: z.enum(['ok', 'warn', 'bad']).optional(),
});

/**
 * What a program other than drovr puts on its card. `z.object` strips keys it does not
 * declare, which is the contract: Hadrian pipes the one object it also writes to SSM, with
 * `at`, `box` and `tickets` beside these, and only the known fields travel. A known field
 * of the wrong shape is refused here, with its path, before anything is sent.
 */
export const genericStatusShape = z.object({
  title: z.string().min(1).max(60),
  intervalSeconds: z.number().int().min(10).max(86_400).optional(),
  accounts: z.array(statusAccountShape).max(50).optional(),
  lines: z.array(lineShape).max(GENERIC_STATUS_MAX_LINES).optional(),
  note: z.string().max(200).optional(),
});
export type GenericStatus = z.infer<typeof genericStatusShape>;

const parseStdinObject = (stdin: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(stdin);
  } catch (error) {
    throw new UsageError(`stdin is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new UsageError('stdin is not a JSON object');
  return value as Record<string, unknown>;
};

/**
 * The payload text for `hey status put`. Plain mode validates stdin as the generic shape;
 * `--teamclaude` runs `teamclaude status --json` through drovr's own parser and the shared
 * accounts builder, so a box pipes it with no mapping code. The title defaults to
 * `<program>@<host>` either way: a writer has a card before it has written any copy.
 */
export const buildGenericPayload = (input: { program: string; host: string; stdin: string; teamclaude: boolean }): string => {
  const title = `${input.program}@${input.host}`;
  if (input.teamclaude) {
    // Not parseStatus: its message is zod's whole issues array, and a box's log wants one line naming the path.
    const status = teamclaudeStatusShape.safeParse(parseStdinObject(input.stdin));
    if (!status.success) throw new Error(`teamclaude status did not match expected shape: ${firstIssue(status.error)}`);
    return JSON.stringify(genericStatusShape.parse({ title, accounts: accountsFromTeamclaude(status.data) }));
  }
  const object = parseStdinObject(input.stdin);
  const parsed = genericStatusShape.safeParse({ title, ...object });
  if (!parsed.success) throw new UsageError(`payload ${firstIssue(parsed.error)}`);
  return JSON.stringify(parsed.data);
};

/** `<path>: <message>` for the first issue, in shape order — the one line a log wants. */
const firstIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  return `${issue?.path.join('.') || 'is invalid'}: ${issue?.message ?? 'invalid'}`;
};

export type StatusPutArgs = { to: string; program: string; host: string; teamclaude: boolean };

/** `hey status put --program <name> [--host <host>] [--to <handle>] [--teamclaude] -`: the trailing `-` says the payload is on stdin. */
export const parseStatusPutArgs = (argv: string[], defaults: { to: string | null; host: string }): StatusPutArgs => {
  const teamclaude = argv.includes('--teamclaude');
  const dash = argv.includes('-');
  const rest = argv.filter((arg) => arg !== '--teamclaude' && arg !== '-');
  const values = flagValues(rest, ['--to', '--program', '--host']);
  const program = values.get('--program');
  if (program === undefined) throw new UsageError('hey status put needs --program <name>: the writer this row belongs to');
  if (program === 'drovr') throw new UsageError('--program drovr is refused: drovr writes its own row from the tick');
  if (!PROGRAM_PATTERN.test(program)) throw new UsageError(`--program is lowercase letters, digits and hyphens, starting with a letter, at most 32 characters, not "${program}"`);
  if (!dash) throw new UsageError('hey status put reads its payload from stdin: end the line with -');
  const to = values.get('--to') ?? defaults.to;
  if (to === null) throw noRecipient();
  return { to, program, host: values.get('--host') ?? defaults.host, teamclaude };
};

/** Read leniently: this is a summary line over a payload drovr owns, and a missing field costs a word, not the line. */
const statusSummaryShape = z.object({
  mode: z.string().optional(),
  capacity: z.object({ cyclesFundable: z.number().nullable(), bindingBucket: z.string() }).nullable().optional(),
  programs: z.array(z.unknown()).optional(),
});

/** Same leniency for a generic row: the phone is strict about this shape; a terminal summary is not the place to refuse it. */
const genericSummaryShape = z.object({ title: z.string().optional(), lines: z.array(z.unknown()).optional() });

const ageMinutes = (row: StatusRow, nowMs: number): number => Math.max(0, Math.floor((nowMs - Date.parse(row.at)) / 60_000));

const describeDrovrRow = (row: StatusRow, nowMs: number): string => {
  const parsed = statusSummaryShape.safeParse(JSON.parse(row.payload));
  const summary = parsed.success ? parsed.data : {};
  const capacity = summary.capacity ?? null;
  const funding =
    capacity === null || capacity.cyclesFundable === null
      ? 'no capacity figure'
      : `${capacity.cyclesFundable.toFixed(2)} cycles fundable · ${capacity.bindingBucket} binding`;
  return `drovr@${row.host}  ${row.at} (${ageMinutes(row, nowMs)}m ago)  ${summary.mode ?? '?'} · ${funding} · ${summary.programs?.length ?? 0} programs`;
};

const describeGenericRow = (row: StatusRow, nowMs: number): string => {
  const parsed = genericSummaryShape.safeParse(JSON.parse(row.payload));
  const summary = parsed.success ? parsed.data : {};
  return `${row.program}@${row.host}  ${row.at} (${ageMinutes(row, nowMs)}m ago)  ${summary.title ?? '?'} · ${summary.lines?.length ?? 0} lines`;
};

export const describeStatusRow = (row: StatusRow, nowMs: number): string =>
  row.program === 'drovr' ? describeDrovrRow(row, nowMs) : describeGenericRow(row, nowMs);

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

/** A send's id is the handler's ULID; anything else cannot name a message, so it is refused before a call. */
const MESSAGE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type WaitArgs = { id: string; sliceSeconds: number | null; json: boolean };

/** `hey wait <id> [--wait <dur>] [--json]`: --wait bounds this call, not the message's own window. */
export const parseWaitArgs = (argv: string[]): WaitArgs => {
  let json = false;
  let slice: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--wait') {
      slice = argv[i + 1];
      if (slice === undefined) throw new UsageError('--wait needs a value');
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }
  if (positional.length !== 1) throw new UsageError('hey wait takes exactly one message id: the "id" hey --json printed');
  const id = positional[0]!;
  if (!MESSAGE_ID.test(id)) throw new UsageError(`"${id}" is not a message id: hey --json prints it as "id", 26 characters`);
  return { id, sliceSeconds: slice === undefined ? null : parseDuration(slice), json };
};

/** listening: this call's slice ended while the message's own window is still open. */
export type ResumeOutcome = WaitOutcome | { status: 'listening' };
export type Resumed = { first: PublicMessage | null; outcome: ResumeOutcome };

/**
 * A wait on a message sent earlier. The first read finds the window; a tool error there throws
 * (bad id, not signed in), and later reads are polls with waitForReply's failure budget. The slice
 * bounds this call only, so "slice ended" and "window closed" stay distinguishable.
 */
export const resumeWait = async (opts: {
  call: Call;
  id: string;
  sliceSeconds: number | null;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  onPollError: (reason: string) => void;
}): Promise<Resumed> => {
  let first: PublicMessage;
  try {
    first = await readMessage(opts.call, opts.id);
  } catch (error) {
    if (error instanceof MessageGone) return { first: null, outcome: { status: 'deleted' } };
    throw error;
  }
  if (first.reply !== null) return { first, outcome: { status: 'replied', reply: first.reply, repliedAt: first.repliedAt ?? '' } };
  if (first.waitUntil === null) return { first, outcome: { status: 'unanswered' } };
  const windowEndMs = Date.parse(first.waitUntil);
  if (Number.isNaN(windowEndMs)) throw new Error(`hey read answered with a waitUntil that is not an instant: ${first.waitUntil}`);
  const startMs = opts.nowMs();
  if (windowEndMs <= startMs) return { first, outcome: { status: 'unanswered' } };
  const sliceEndMs = opts.sliceSeconds === null ? windowEndMs : Math.min(windowEndMs, startMs + opts.sliceSeconds * 1000);
  // The first read already said "nothing yet"; polling again at once would only repeat it.
  await opts.sleep(POLL_MS);
  const outcome = await waitForReply({ read: () => readMessage(opts.call, opts.id), sleep: opts.sleep, nowMs: opts.nowMs, waitUntilMs: sliceEndMs, onPollError: opts.onPollError });
  if (outcome.status === 'unanswered' && sliceEndMs < windowEndMs) return { first, outcome: { status: 'listening' } };
  return { first, outcome };
};

export type WaitReport = { code: 0 | 2; stdout: string | null; stderr: string | null };

/**
 * What `hey wait` prints for every outcome but `failed` (the caller throws that). --json is the
 * send --json object; `quiet` is null because the row does not record it, `to` is the configured
 * handle (null without one) because the read tool does not return it.
 */
export const waitReport = (input: Resumed & { id: string; to: string | null; json: boolean; clock: (iso: string) => string }): WaitReport => {
  const { id, first, outcome } = input;
  if (outcome.status === 'failed') throw new Error(`gave up polling: ${outcome.reason}`);
  const replied = outcome.status === 'replied';
  const code = replied ? 0 : 2;
  if (input.json) {
    const line = {
      id, to: input.to, from: first?.from ?? null, sentAt: first?.createdAt ?? null, waitUntil: first?.waitUntil ?? null, quiet: null,
      reply: replied ? outcome.reply : null, repliedAt: replied ? outcome.repliedAt : null, status: outcome.status,
    };
    return { code, stdout: JSON.stringify(line), stderr: null };
  }
  if (replied) return { code, stdout: outcome.reply, stderr: null };
  if (outcome.status === 'deleted') return { code, stdout: null, stderr: `message ${id} was deleted on the phone; no reply is coming` };
  const waitUntil = first?.waitUntil ?? null;
  if (waitUntil === null) return { code, stdout: null, stderr: `message ${id} was sent without --wait; no reply is coming` };
  if (outcome.status === 'listening') return { code, stdout: null, stderr: `still waiting on ${id} until ${input.clock(waitUntil)}` };
  return { code, stdout: null, stderr: `no reply by ${input.clock(waitUntil)}` };
};
