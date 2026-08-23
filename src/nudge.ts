import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ensureDirs, paths } from './paths.ts';

const run = promisify(execFile);

const sentShape = z.object({ askedAt: z.number(), sentAt: z.number() });

const sentPath = (program: string): string => join(paths().programState(program), 'nudged.json');

/** One nudge per ask, not one per tick: a phone buzzing every ten minutes is noise. */
const alreadyNudged = (program: string, askedAt: number): boolean => {
  const path = sentPath(program);
  if (!existsSync(path)) return false;
  const parsed = sentShape.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  return parsed.success && parsed.data.askedAt === askedAt;
};

/**
 * A runner exits after raising an ask, so it cannot watch the clock on its own
 * question. drovr can: it knows how long a program has been blocked, and an ask
 * nobody has seen is worth more than a tidy status line.
 */
export const nudgeIfNeglected = async (input: {
  program: string;
  asks: number;
  askedAt: number;
  now: number;
  afterMinutes: number;
  phoneNumber: string | null;
  asksUrl: string | null;
}): Promise<boolean> => {
  const { program, asks, askedAt, now, afterMinutes, phoneNumber, asksUrl } = input;
  if (phoneNumber === null) return false;
  if (now - askedAt < afterMinutes * 60_000) return false;
  if (alreadyNudged(program, askedAt)) return false;

  const hours = Math.round((now - askedAt) / 3_600_000);
  const message =
    `drovr: ${program} has been blocked ${hours}h on ${asks} unanswered ask(s).` +
    (asksUrl === null ? '' : ` ${asksUrl}`);

  try {
    await run('aws', [
      'sns',
      'publish',
      '--profile',
      'dev',
      '--phone-number',
      phoneNumber,
      '--message',
      message,
    ]);
  } catch (error) {
    // Never let a failed nudge take down a tick; the status line still carries it.
    console.error(`could not text about ${program}: ${error instanceof Error ? error.message : error}`);
    return false;
  }

  ensureDirs(program);
  writeFileSync(sentPath(program), `${JSON.stringify({ askedAt, sentAt: now })}\n`, 'utf8');
  console.log(`texted about ${program} (${asks} ask(s), blocked ${hours}h)`);
  return true;
};
