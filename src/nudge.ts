import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ensureDirs, paths } from './paths.ts';

const run = promisify(execFile);

export type SendResult = {
  sent: boolean;
  messageId: string | null;
  via: 'sns' | 'end-user-messaging';
};

/**
 * Two transports, because they are not interchangeable. SNS `publish` cannot resolve
 * drovr's own long code as an origination identity: it accepts the call, returns a
 * MessageId, and then fails at delivery with "The provided number does not exist or
 * does not belong to the account". End User Messaging sends from that same number
 * without complaint. Both measured on 2026-08-24, to the same handset, minutes apart.
 *
 * So a configured originationNumber routes through End User Messaging, and SNS is
 * used only when no number is set — where it picks one itself and delivers fine.
 * Numbers are region-scoped; both calls inherit the profile's default region, which
 * is the region the number was acquired in.
 */
export const sendArgs = (
  phoneNumber: string,
  message: string,
  originationNumber: string | null,
): string[] => {
  if (originationNumber === null) {
    return ['sns', 'publish', '--phone-number', phoneNumber, '--message', message];
  }
  return [
    'pinpoint-sms-voice-v2',
    'send-text-message',
    '--destination-phone-number',
    phoneNumber,
    '--origination-identity',
    originationNumber,
    '--message-body',
    message,
    '--message-type',
    'TRANSACTIONAL',
  ];
};

/** Both APIs answer with a MessageId, which is how a send is found in the delivery logs. */
export const messageIdOf = (stdout: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const id = (parsed as { MessageId?: unknown }).MessageId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
};

/**
 * The one place drovr sends SMS. Deliberately on the *default* AWS profile: the
 * named profiles here are SSO-backed and their sessions expire, which is precisely
 * the state an unattended overnight supervisor finds them in. The default profile
 * is a static IAM user, so it still works at 4am. Do not add --profile.
 *
 * Best-effort by design: a phone that cannot be reached must never take down a tick
 * or a cycle, so failure is logged and reported rather than thrown. `sent` means the
 * API accepted the message — never that a handset received it.
 */
export const textCraig = async (
  phoneNumber: string | null,
  message: string,
  originationNumber: string | null = null,
): Promise<SendResult> => {
  const via = originationNumber === null ? 'sns' : 'end-user-messaging';
  if (phoneNumber === null) return { sent: false, messageId: null, via };
  try {
    const { stdout } = await run('aws', sendArgs(phoneNumber, message, originationNumber));
    return { sent: true, messageId: messageIdOf(stdout), via };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = /credential|expired|invalid|token/i.test(detail)
      ? ' Check the default profile with: aws sts get-caller-identity'
      : '';
    console.error(`could not text: ${detail}${hint}`);
    return { sent: false, messageId: null, via };
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

  if (!(await textCraig(phoneNumber, message)).sent) return false;

  ensureDirs(program);
  writeFileSync(sentPath(program), `${JSON.stringify({ askedAt, sentAt: now })}\n`, 'utf8');
  console.log(`texted about ${program} (${asks} ask(s), blocked ${hours}h)`);
  return true;
};
