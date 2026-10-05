import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBounded } from './exec.ts';
import { z } from 'zod';
import { ensureDirs, paths } from './paths.ts';


/**
 * The alerting path is the worst place to leave unbounded: `textCraig` is called from
 * inside the tick (a neglected ask, a stalled runner), so an `aws` call that hangs holds
 * the tick lock — the thing whose job is to say something is wrong takes the supervisor
 * down instead. 30s, because it is a network call and best-effort either way.
 */
const SEND_TIMEOUT_MS = 30_000;

/** Reading the token is a local keychain lookup; anything slower than this is wedged. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/** The bot token lives in the login keychain, never in control.json, which the TUI rewrites. */
const SLACK_KEYCHAIN_SERVICE = 'drovr-slack';

export type SendResult = {
  sent: boolean;
  /** Slack's message `ts`, or the SMS MessageId the delivery logs are searched by. */
  messageId: string | null;
  via: 'slack' | 'sns' | 'end-user-messaging';
};

/**
 * Every field is required, never defaulted — see `textCraig` for why. A `Control`
 * satisfies it, so callers pass the control object rather than picking fields.
 */
export type Recipient = {
  slackChannel: string | null;
  phoneNumber: string | null;
  originationNumber: string | null;
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

const slackReplyShape = z.object({ ok: z.boolean(), error: z.string().optional(), ts: z.string().optional() });

const slackToken = async (): Promise<string> => {
  const { stdout } = await runBounded('security', ['find-generic-password', '-s', SLACK_KEYCHAIN_SERVICE, '-w'], {
    timeoutMs: KEYCHAIN_TIMEOUT_MS,
  });
  const token = stdout.trim();
  if (!token.startsWith('xoxb-')) throw new Error(`keychain item ${SLACK_KEYCHAIN_SERVICE} does not hold a bot token`);
  return token;
};

/**
 * A channel id posts there (the app must be a member); a user id lands in the app's DM.
 * Unlike SMS, `ok` here is the real verdict: Slack has stored the message.
 */
const postToSlack = async (userId: string, message: string): Promise<string | null> => {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await slackToken()}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: userId, text: message }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const reply = slackReplyShape.parse(await response.json());
  if (!reply.ok) throw new Error(`slack refused the message: ${reply.error ?? 'no reason given'}`);
  return reply.ts ?? null;
};

/**
 * The fallback transport. Deliberately on the *default* AWS profile: the
 * named profiles here are SSO-backed and their sessions expire, which is precisely
 * the state an unattended overnight supervisor finds them in. The default profile
 * is a static IAM user, so it still works at 4am. Do not add --profile.
 *
 * A null `originationNumber` lets SNS pick a number, and it picks one of sunnyt's —
 * measured 2026-08-27 — so replies land in inbound topics sunnyt's cycles poll.
 * `sent` means the API accepted the message — never that a handset received it.
 */
const sendSms = async (
  phoneNumber: string | null,
  message: string,
  originationNumber: string | null,
): Promise<SendResult> => {
  const via = originationNumber === null ? 'sns' : 'end-user-messaging';
  if (phoneNumber === null) return { sent: false, messageId: null, via };
  try {
    const { stdout } = await runBounded('aws', sendArgs(phoneNumber, message, originationNumber), {
      timeoutMs: SEND_TIMEOUT_MS,
    });
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

/**
 * The one place drovr alerts Craig: a Slack DM from the Drovr app, falling back to SMS
 * when Slack is unconfigured or refuses. Every field of `to` is required for the same
 * reason runBounded's timeout is: `originationNumber` defaulted to null once, four of
 * five call sites forgot it, and SNS then sent from one of sunnyt's numbers.
 *
 * Best-effort by design: a phone that cannot be reached must never take down a tick or
 * a cycle, so failure is logged and reported rather than thrown.
 */
export const textCraig = async (to: Recipient, message: string): Promise<SendResult> => {
  if (to.slackChannel !== null) {
    try {
      return { sent: true, messageId: await postToSlack(to.slackChannel, message), via: 'slack' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`could not reach slack, falling back to SMS: ${detail}`);
    }
  }
  return sendSms(to.phoneNumber, message, to.originationNumber);
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
  if (to.slackChannel === null && to.phoneNumber === null) return false;
  if (now - askedAt < afterMinutes * 60_000) return false;
  if (alreadyNudged(program, askedAt)) return false;

  const hours = Math.round((now - askedAt) / 3_600_000);
  const message =
    `drovr: ${program} has been blocked ${hours}h on ${asks} unanswered ask(s).` +
    (asksUrl === null ? '' : ` ${asksUrl}`);

  if (!(await textCraig(to, message)).sent) return false;

  ensureDirs(program);
  writeFileSync(sentPath(program), `${JSON.stringify({ askedAt, sentAt: now })}\n`, 'utf8');
  console.log(`texted about ${program} (${asks} ask(s), blocked ${hours}h)`);
  return true;
};
