import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Program } from './control.ts';
import { explainSpawn } from './exec.ts';

const run = promisify(execFile);

/**
 * Threads carry a timestamp under one of several names depending on version, so
 * take whichever is present rather than guessing one and silently reading nothing.
 */
const threadShape = z
  .object({
    id: z.string().optional(),
    resolved: z.boolean().optional(),
    updatedAt: z.string().optional(),
    createdAt: z.string().optional(),
    at: z.string().optional(),
    replies: z.array(z.object({ at: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

const notesShape = z.object({
  notes: z.object({ shared: z.boolean().default(false), threads: z.array(threadShape).default([]) }),
});

export type AsksState = {
  /** Shared notes must be toggled on by the page owner; without it nothing is readable. */
  shared: boolean;
  /** Most recent human activity on the page, or null if there is none. */
  latestAt: number | null;
  openThreads: number;
};

const timestamps = (thread: z.infer<typeof threadShape>): number[] =>
  [thread.updatedAt, thread.createdAt, thread.at, ...(thread.replies ?? []).map((r) => r.at)]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => Date.parse(value))
    .filter((value) => !Number.isNaN(value));

/**
 * `notes list` takes a page relative to a prefix, defaulting to the caller's own
 * slug — passing "craig/loop-asks.html" whole looks under <yourslug>/craig/... and
 * quietly reports an unshared, empty page rather than failing.
 */
export const splitPage = (asksPage: string): { page: string; prefix: string | null } => {
  const cut = asksPage.indexOf('/');
  if (cut === -1) return { page: asksPage, prefix: null };
  return { page: asksPage.slice(cut + 1), prefix: asksPage.slice(0, cut) };
};

const prefixArgs = (prefix: string | null): string[] =>
  prefix === null ? [] : ['--prefix', prefix];

const NOTES_MAX_BYTES = 16 * 1024 * 1024;

const aiceErrorShape = z.object({ error: z.object({ message: z.string() }) });

/**
 * A failing `aice --json` puts its reason on **stdout** and leaves stderr to
 * direnv's banner, so execFile's own error names the command and nothing that can
 * be acted on. Null means there was no reason to lift, not that one was dropped —
 * the original error is still thrown.
 */
const aiceReason = (stdout: unknown): string | null => {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  try {
    const parsed = aiceErrorShape.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data.error.message : null;
  } catch {
    return null;
  }
};

/**
 * Every notes call runs through direnv so the install named by that repo's .envrc,
 * and the aice login held beside it, are the ones used. Sole owner of the argv:
 * the page argument's position differs per subcommand and getting it wrong reads
 * as a page with no notes rather than as an error.
 */
const notesJson = async (cwd: string, argv: string[]): Promise<string> => {
  const { stdout } = await run(
    'direnv',
    ['exec', cwd, 'aice', 'notes', ...argv, '--json'],
    // execFile's 1 MB default applies to `notes list`, where aice allows 4 KB a note
    // and 64 KB a participant: a busy page overruns it and throws ENOBUFS, which
    // reads as a notes outage rather than as the page being too big to fetch.
    { cwd, maxBuffer: NOTES_MAX_BYTES },
  ).catch((error: unknown) => {
    const reason = aiceReason((error as { stdout?: unknown }).stdout);
    if (reason === null) throw explainSpawn('direnv', error);
    throw new Error(`aice notes ${argv[0]} failed: ${reason}`);
  });
  return stdout;
};

const cache = new Map<string, { at: number; state: AsksState | null }>();
const TTL_MS = 60_000;

/**
 * Reads through direnv so the program's own aice install and login apply. Cached
 * briefly: a watch frame redraws every few seconds and must not shell out per
 * program each time.
 */
export const readAsks = async (program: Program, now = Date.now()): Promise<AsksState | null> => {
  const cached = cache.get(program.name);
  if (cached !== undefined && now - cached.at < TTL_MS) return cached.state;
  const state = await readAsksUncached(program);
  cache.set(program.name, { at: now, state });
  return state;
};

const readAsksUncached = async (program: Program): Promise<AsksState | null> => {
  if (program.aice?.asksPage == null) return null;

  const { page, prefix } = splitPage(program.aice.asksPage);
  const parsed = await notesJson(program.cwd, ['list', page, ...prefixArgs(prefix)])
    .then((stdout) => notesShape.safeParse(JSON.parse(stdout)))
    .catch(() => null);

  if (parsed === null || !parsed.success) return null;

  const all = parsed.data.notes.threads.flatMap(timestamps);
  return {
    shared: parsed.data.notes.shared,
    latestAt: all.length === 0 ? null : Math.max(...all),
    openThreads: parsed.data.notes.threads.filter((thread) => thread.resolved !== true).length,
  };
};

/**
 * Strict where `threadShape` above is lenient, and deliberately so: that one backs
 * a liveness heuristic where a missing field costs a timestamp, while this one
 * feeds writes to control.json. An unrecognised shape must throw rather than parse
 * clean into an empty drain — the same rule as herdr's `agent_status`.
 */
const noteThreadShape = z.object({
  id: z.string(),
  author: z.string(),
  text: z.string(),
  resolved: z.boolean(),
});

const listingShape = z.object({
  notes: z.object({ shared: z.boolean(), threads: z.array(noteThreadShape) }),
});

export type NoteThread = z.infer<typeof noteThreadShape>;

/** `shared` is the page owner's toggle: false means unreadable, not unanswered. */
export type NotesListing = { shared: boolean; threads: NoteThread[] };

export const listNotes = async (cwd: string, notesPage: string): Promise<NotesListing> => {
  const { page, prefix } = splitPage(notesPage);
  const stdout = await notesJson(cwd, ['list', page, ...prefixArgs(prefix)]);
  return listingShape.parse(JSON.parse(stdout)).notes;
};

export const replyToNote = async (
  cwd: string,
  notesPage: string,
  noteId: string,
  text: string,
): Promise<void> => {
  const { page, prefix } = splitPage(notesPage);
  await notesJson(cwd, ['reply', page, '--to', noteId, '--text', text, ...prefixArgs(prefix)]);
};

export const resolveNote = async (
  cwd: string,
  notesPage: string,
  noteId: string,
): Promise<void> => {
  const { page, prefix } = splitPage(notesPage);
  await notesJson(cwd, ['resolve', page, noteId, ...prefixArgs(prefix)]);
};
