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
export const closingMessage = (sessionId: string): string | null => {
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
