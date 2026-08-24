export const MAX_INTENTS_PER_TICK = 20;

const PREFIX = 'drovr-intent v1';
const MODES = ['off', 'low', 'normal', 'away'];
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type Action =
  | { kind: 'mode'; value: string }
  | { kind: 'pause'; hours: number }
  | { kind: 'reserve'; delta: number }
  | { kind: 'concurrency'; delta: number }
  | { kind: 'enable'; program: string; enabled: boolean }
  | { kind: 'priority'; program: string; delta: number };

export type Intent = { id: string; action: Action; requestedAt: number; expiresAt: number };

const toAction = (words: string[]): Action | string => {
  const [verb, arg1, arg2] = words;

  if (verb === 'mode') {
    if (arg1 === undefined) return 'mode needs a value';
    if (!MODES.includes(arg1)) return `mode needs one of: ${MODES.join(', ')}`;
    if (arg2 !== undefined) return `mode does not take multiple arguments; unexpected: ${arg2}`;
    return { kind: 'mode', value: arg1 };
  }

  if (verb === 'pause') {
    if (arg1 === undefined) return 'pause needs a duration like 3h';
    const match = /^(\d+)h$/.exec(arg1);
    const hours = Number(match?.[1]);
    if (!Number.isFinite(hours)) return 'pause needs a duration like 3h';
    if (hours < 1 || hours > 72) return 'pause needs a duration between 1h and 72h';
    if (arg2 !== undefined) return `pause does not take multiple arguments; unexpected: ${arg2}`;
    return { kind: 'pause', hours };
  }

  if (verb === 'reserve') {
    if (arg1 === undefined) return 'reserve needs a signed number between -0.95 and 0.95';
    const delta = Number(arg1);
    if (!Number.isFinite(delta)) return 'reserve needs a signed number between -0.95 and 0.95';
    if (delta < -0.95 || delta > 0.95) return 'reserve needs a signed number between -0.95 and 0.95';
    if (arg2 !== undefined) return `reserve does not take multiple arguments; unexpected: ${arg2}`;
    return { kind: 'reserve', delta };
  }

  if (verb === 'concurrency') {
    if (arg1 === undefined) return 'concurrency needs a signed number between -7 and 7';
    const delta = Number(arg1);
    if (!Number.isFinite(delta)) return 'concurrency needs a signed number between -7 and 7';
    if (delta < -7 || delta > 7) return 'concurrency needs a signed number between -7 and 7';
    if (arg2 !== undefined) return `concurrency does not take multiple arguments; unexpected: ${arg2}`;
    return { kind: 'concurrency', delta };
  }

  if (verb === 'enable') {
    if (arg1 === undefined) return 'enable needs a program name';
    if (arg2 !== undefined) return `enable does not take multiple arguments; unexpected: ${arg2}`;
    return { kind: 'enable', program: arg1, enabled: true };
  }

  if (verb === 'disable') {
    if (arg1 === undefined) return 'disable needs a program name';
    if (arg2 !== undefined) return `disable does not take multiple arguments; unexpected: ${arg2}`;
    return { kind: 'enable', program: arg1, enabled: false };
  }

  if (verb === 'priority') {
    if (arg1 === undefined) return 'priority needs a program name and a signed number between -9 and 9';
    if (arg2 === undefined) return 'priority needs a program name and a signed number between -9 and 9';
    const delta = Number(arg2);
    if (!Number.isFinite(delta)) return 'priority needs a program name and a signed number between -9 and 9';
    if (delta < -9 || delta > 9) return 'priority needs a signed number between -9 and 9';
    if (words[3] !== undefined) return `priority does not take extra arguments; unexpected: ${words[3]}`;
    return { kind: 'priority', program: arg1, delta };
  }

  if (verb === 'interrupt') return 'interrupt is not available from the panel — use drovr watch';
  return `unknown action "${verb ?? ''}"`;
};

export const parseIntent = (
  text: string,
  id: string,
  now: number,
): Intent | { rejected: string } => {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return { rejected: 'not an intent' };

  const body = trimmed.slice(PREFIX.length).trim();

  const expiresPresent = /(?:^|\s)expires=/.test(body);
  const expiresMatches = body.match(/(?:^|\s)expires=(\S+)/g);
  if (!expiresPresent) return { rejected: 'no expires= stamp' };
  if (expiresMatches === null || expiresMatches.length === 0) return { rejected: 'expires= present but empty' };
  if (expiresMatches.length > 1) return { rejected: 'expires= appears more than once; expected exactly one' };

  const expiresMatch = /(?:^|\s)expires=(\S+)/.exec(body);
  const expiresStamp = expiresMatch?.[1];
  if (expiresStamp === undefined) return { rejected: 'expires= present but empty' };
  if (!ISO_8601_REGEX.test(expiresStamp)) return { rejected: 'expires= must be ISO 8601 format like 2026-08-24T12:00:00.000Z' };

  const expiresAt = Date.parse(expiresStamp);
  if (Number.isNaN(expiresAt)) return { rejected: 'unparseable expires= stamp' };
  if (expiresAt <= now) return { rejected: 'expired before it was drained' };

  const action = toAction(body.replace(/(?:^|\s)expires=\S+/, '').trim().split(/\s+/).filter(Boolean));
  if (typeof action === 'string') return { rejected: action };
  return { id, action, requestedAt: now, expiresAt };
};
