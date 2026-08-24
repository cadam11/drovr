import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ensureDirs, paths } from './paths.ts';

const run = promisify(execFile);

/**
 * The one place drovr sends SMS. Best-effort by design: a phone that cannot be
 * reached must never take down a tick or a cycle, so failure is logged and reported
 * rather than thrown. Returns whether the message actually went out.
 */
export const textCraig = async (phoneNumber: string | null, message: string): Promise<boolean> => {
  if (phoneNumber === null) return false;
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
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The dev profile is SSO-backed and its session expires, which is precisely the
    // state an unattended overnight supervisor finds it in. Name the command.
    const hint = /sso session|expired|invalid/i.test(detail)
      ? ' Refresh it with: aws sso login --profile dev'
      : '';
    console.error(`could not text: ${detail}${hint}`);
    return false;
  }
};

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

  if (!(await textCraig(phoneNumber, message))) return false;

  ensureDirs(program);
  writeFileSync(sentPath(program), `${JSON.stringify({ askedAt, sentAt: now })}\n`, 'utf8');
  console.log(`texted about ${program} (${asks} ask(s), blocked ${hours}h)`);
  return true;
};
