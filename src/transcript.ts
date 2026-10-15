// src/transcript.ts
//
// The runner's closing message, lifted from claude's own session transcript. The agent is
// told never to recap, and yet every cycle ends with one — so rather than ask for it through
// `drovr report`, drovr reads the last thing claude said. That file is claude's, in a format
// it has not declared, which makes this a scrape: lenient like preview.ts, never a failed tick.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Host } from './control.ts';
import { runSsh } from './exec.ts';

/** One `cat` over ssh; the file is a few hundred KB at most. */
const SSH_TIMEOUT_MS = 20_000;

/** Enough for a full recap; a runner that says more than this is not closing, it is working. */
export const CLOSING_MAX_CHARS = 4_000;

const assistantText = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.object({ type: z.literal('text'), text: z.string() }).or(z.object({ type: z.string() }))),
  }),
});

export const closingFrom = (jsonl: string): string | null => {
  let closing: string | null = null;
  for (const line of jsonl.split('\n')) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = assistantText.safeParse(raw);
    if (!parsed.success) continue;
    for (const block of parsed.data.message.content) {
      if ('text' in block && block.text.trim() !== '') closing = block.text.trim().slice(0, CLOSING_MAX_CHARS);
    }
  }
  return closing;
};

/**
 * Claude keys the transcript by the session id drovr minted, under a directory named for
 * the cwd. The cwd slug is claude's to compute, so every project directory is searched
 * for the id rather than re-deriving it. Null when there is no such file yet, or when
 * the format has moved on: the ledger loses a recap, nothing else.
 */
export const closingMessage = async (sessionId: string, host: Host | null = null): Promise<string | null> => {
  if (host !== null) return remoteClosing(sessionId, host);
  const projects = join(homedir(), '.claude', 'projects');
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (!existsSync(path)) continue;
    try {
      return closingFrom(readFileSync(path, 'utf8'));
    } catch (error: unknown) {
      console.error(`could not read the transcript at ${path}, recording no closing message: ${String(error)}`);
      return null;
    }
  }
  return null;
};

/**
 * The box's ~/.claude is the box's own: the transcript is read where it was written, with
 * the same search over every project directory, done by the remote shell's glob. A failed
 * read is logged and costs the ledger a recap, exactly as an unreadable local file does.
 */
const remoteClosing = async (sessionId: string, host: Host): Promise<string | null> => {
  // The id is interpolated into a shell string, so it has to be the UUID drovr minted.
  if (!/^[0-9a-f-]+$/i.test(sessionId)) throw new Error(`session id is not a UUID: ${sessionId}`);
  try {
    const { stdout } = await runSsh(host.ssh, `cat ~/.claude/projects/*/${sessionId}.jsonl`, SSH_TIMEOUT_MS);
    return closingFrom(stdout);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`could not read the transcript for ${sessionId} on ${host.ssh}, recording no closing message: ${detail}`);
    return null;
  }
};
