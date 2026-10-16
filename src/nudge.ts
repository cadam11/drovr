import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { lambdaInvoke, send } from './hey.ts';
import { ensureDirs, paths } from './paths.ts';

export type SendResult = {
  sent: boolean;
  /** The hey message id, which `drovr status` and the app both show. */
  messageId: string | null;
  via: 'hey';
  /** Why `sent` is false, so no caller has to print "see above" over an empty log. */
  reason: string | null;
};

/** A `Control` satisfies it, so callers pass the control object rather than picking fields. */
export type Recipient = { notifyTo: string | null };

/** The `from` label the app groups a thread by: the program, or drovr itself on this machine. */
export const alertFrom = (program: string | null, host: string): string => program ?? `drovr on ${host}`;

/**
 * The one place drovr alerts Craig, through the same hey lambda the CLI uses. `from` is
 * required rather than defaulted for the reason `originationNumber` once was: a caller that
 * forgets it would file every alert under one anonymous thread.
 *
 * Best-effort by design: an unreachable lambda must never take down a tick or a cycle, so
 * failure is logged and reported rather than thrown. Bounded by the invoke's own 15s.
 */
export const textCraig = async (to: Recipient, message: string, from: string): Promise<SendResult> => {
  if (to.notifyTo === null) {
    const reason = 'notifyTo is null in control.json, so the alert was dropped';
    console.error(`${reason}: ${message.slice(0, 80)}`);
    return { sent: false, messageId: null, via: 'hey', reason };
  }
  try {
    const result = await send(lambdaInvoke(), {
      to: to.notifyTo,
      from,
      host: hostname(),
      cwd: from,
      text: message,
      waitSeconds: null,
      choices: null,
    });
    if (!result.pushed) console.error(`sent ${result.id}, but push failed: ${result.reason ?? 'no reason given'}`);
    return { sent: true, messageId: result.id, via: 'hey', reason: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = /credential|expired|security token|AccessDenied/i.test(detail)
      ? ' Check the default profile with: aws sts get-caller-identity'
      : '';
    console.error(`could not send through hey: ${detail}${hint}`);
    return { sent: false, messageId: null, via: 'hey', reason: detail };
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
  to: Recipient;
  asksUrl: string | null;
}): Promise<boolean> => {
  const { program, asks, askedAt, now, afterMinutes, to, asksUrl } = input;
  if (to.notifyTo === null) return false;
  if (now - askedAt < afterMinutes * 60_000) return false;
  if (alreadyNudged(program, askedAt)) return false;

  const hours = Math.round((now - askedAt) / 3_600_000);
  const message =
    `drovr: ${program} has been blocked ${hours}h on ${asks} unanswered ask(s).` +
    (asksUrl === null ? '' : ` ${asksUrl}`);

  if (!(await textCraig(to, message, alertFrom(program, hostname()))).sent) return false;

  ensureDirs(program);
  writeFileSync(sentPath(program), `${JSON.stringify({ askedAt, sentAt: now })}\n`, 'utf8');
  console.log(`sent hey about ${program} (${asks} ask(s), blocked ${hours}h)`);
  return true;
};
