export const MAX_INTENTS_PER_TICK = 20;

const PREFIX = 'drovr-intent v1';

export type Action =
  | { kind: 'mode'; value: string }
  | { kind: 'pause'; hours: number }
  | { kind: 'reserve'; delta: number }
  | { kind: 'concurrency'; delta: number }
  | { kind: 'enable'; program: string; enabled: boolean }
  | { kind: 'priority'; program: string; delta: number };

export type Intent = { id: string; action: Action; requestedAt: number; expiresAt: number };

const MODES = ['off', 'low', 'normal', 'away'];

const toAction = (words: string[]): Action | string => {
  const [verb, argument] = words;
  if (verb === 'mode' && argument !== undefined && MODES.includes(argument)) {
    return { kind: 'mode', value: argument };
  }
  if (verb === 'pause') {
    const hours = Number(/^(\d+)h$/.exec(argument ?? '')?.[1]);
    return Number.isFinite(hours) ? { kind: 'pause', hours } : 'pause needs a duration like 3h';
  }
  if (verb === 'reserve') {
    const delta = Number(argument);
    return Number.isFinite(delta) ? { kind: 'reserve', delta } : 'reserve needs a signed number';
  }
  if (verb === 'concurrency') {
    const delta = Number(argument);
    return Number.isFinite(delta) ? { kind: 'concurrency', delta } : 'concurrency needs a signed number';
  }
  if ((verb === 'enable' || verb === 'disable') && argument !== undefined) {
    return { kind: 'enable', program: argument, enabled: verb === 'enable' };
  }
  if (verb === 'priority' && argument !== undefined && words[2] !== undefined) {
    const delta = Number(words[2]);
    return Number.isFinite(delta) ? { kind: 'priority', program: argument, delta } : 'priority needs a signed number';
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
  const expiresMatch = /expires=(\S+)/.exec(body);
  if (expiresMatch === null) return { rejected: 'no expires= stamp' };

  const expiresAt = Date.parse(expiresMatch[1]!);
  if (Number.isNaN(expiresAt)) return { rejected: 'unparseable expires= stamp' };
  if (expiresAt <= now) return { rejected: 'expired before it was drained' };

  const action = toAction(body.replace(/expires=\S+/, '').trim().split(/\s+/));
  if (typeof action === 'string') return { rejected: action };
  return { id, action, requestedAt: now, expiresAt };
};
