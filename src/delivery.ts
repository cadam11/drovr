import { z } from 'zod';
import { runBounded } from './exec.ts';
import type { SendResult } from './nudge.ts';

/**
 * Reached only from `drovr notify`, so a hang here costs a person their prompt rather
 * than the supervisor its lock — but bounded on the same principle: execFile has no
 * default timeout, so leaving one call unbounded makes the rule a matter of memory.
 */
const AWS_TIMEOUT_MS = 20_000;

export type DeliveryVerdict = {
  state: 'delivered' | 'failed' | 'unknown';
  reason: string;
};

export const unverified = (reason: string): DeliveryVerdict => ({ state: 'unknown', reason });

/**
 * SNS writes SMS delivery status to two fixed log groups derived from the account
 * and region. Successes and failures land in different ones, so which group an event
 * turns up in is itself the answer.
 */
export const logGroups = (account: string, region: string): { ok: string; failed: string } => {
  const base = `sns/${region}/${account}/DirectPublishToPhoneNumber`;
  return { ok: base, failed: `${base}/Failure` };
};

const eventShape = z.object({
  notification: z.object({ messageId: z.string() }),
  delivery: z.object({ providerResponse: z.string().optional() }).partial(),
});

/** Finds this send among a log group's events. Foreign records are skipped, not guessed at. */
export const findResponse = (messages: string[], messageId: string): string | null => {
  for (const raw of messages) {
    let parsed;
    try {
      parsed = eventShape.safeParse(JSON.parse(raw));
    } catch {
      continue;
    }
    if (!parsed.success) continue;
    if (parsed.data.notification.messageId !== messageId) continue;
    return parsed.data.delivery.providerResponse ?? 'no provider response recorded';
  }
  return null;
};

const identity = async (): Promise<{ account: string; region: string } | null> => {
  const account = await runBounded('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { timeoutMs: AWS_TIMEOUT_MS })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  const region = await runBounded('aws', ['configure', 'get', 'region'], { timeoutMs: AWS_TIMEOUT_MS })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '');
  if (account === '' || region === '') return null;
  return { account, region };
};

const eventsSince = async (group: string, sinceMs: number): Promise<string[]> => {
  const { stdout } = await runBounded('aws', [
    'logs',
    'filter-log-events',
    '--log-group-name',
    group,
    '--start-time',
    String(sinceMs),
    '--query',
    'events[].message',
    '--output',
    'json',
  ], { timeoutMs: AWS_TIMEOUT_MS }).catch(() => ({ stdout: '[]' }));
  const parsed = z.array(z.string()).safeParse(JSON.parse(stdout || '[]'));
  return parsed.success ? parsed.data : [];
};

const POLL_MS = 10_000;

/**
 * Delivery status arrives a minute or so after the send, so this polls rather than
 * reads once. Bounded by timeoutMs: an answer that never comes is reported as unknown,
 * never waited on forever, and never reported as success.
 */
export const verifyDelivery = async (
  result: SendResult,
  timeoutMs: number,
  now = Date.now(),
): Promise<DeliveryVerdict> => {
  if (!result.sent) return unverified('nothing was sent');
  if (result.via === 'slack') return { state: 'delivered', reason: 'slack stored it in the channel' };
  if (result.messageId === null) return unverified('the send returned no MessageId to look up');
  if (result.via === 'end-user-messaging') {
    // Its events go to a configuration set's own destination, and drovr has no
    // configuration set. Name what would create one rather than gesture at it.
    return unverified(
      'End User Messaging reports delivery through a configuration set, and drovr has none. ' +
        'It takes two steps and an IAM role that can write logs: ' +
        'aws pinpoint-sms-voice-v2 create-configuration-set --configuration-set-name drovr-sms, ' +
        'then create-event-destination --matching-event-types TEXT_DELIVERED TEXT_FAILED ' +
        'with a cloud-watch-logs-destination. Sending is unaffected either way.',
    );
  }

  const who = await identity();
  if (who === null) return unverified('could not resolve the AWS account and region to read logs in');
  const groups = logGroups(who.account, who.region);
  const since = now - 120_000;
  const deadline = now + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const failed = findResponse(await eventsSince(groups.failed, since), result.messageId);
    if (failed !== null) return { state: 'failed', reason: failed };
    const ok = findResponse(await eventsSince(groups.ok, since), result.messageId);
    if (ok !== null) return { state: 'delivered', reason: ok };
  }
  return unverified(`no delivery status within ${Math.round(timeoutMs / 1000)}s — check again later`);
};
