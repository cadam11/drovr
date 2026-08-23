import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Program } from './control.ts';

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
  const argv = [
    'exec',
    program.cwd,
    'aice',
    'notes',
    'list',
    page,
    ...(prefix === null ? [] : ['--prefix', prefix]),
    '--json',
  ];
  const parsed = await run('direnv', argv, { cwd: program.cwd })
    .then(({ stdout }) => notesShape.safeParse(JSON.parse(stdout)))
    .catch(() => null);

  if (parsed === null || !parsed.success) return null;

  const all = parsed.data.notes.threads.flatMap(timestamps);
  return {
    shared: parsed.data.notes.shared,
    latestAt: all.length === 0 ? null : Math.max(...all),
    openThreads: parsed.data.notes.threads.filter((thread) => thread.resolved !== true).length,
  };
};
