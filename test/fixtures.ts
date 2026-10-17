import { parseControl, type Control } from '../src/control.ts';
import type { TeamclaudeStatus } from '../src/teamclaude.ts';

export const HOUR = 3_600_000;
export const NOW = Date.parse('2026-08-22T12:00:00.000Z');

type AccountInput = {
  name: string;
  fable?: number | null;
  general?: number | null;
  session?: number | null;
  weeklyResetInHours?: number;
  disabled?: boolean;
  rateLimitedUntil?: number | null;
  /** One of the values teamclaude actually emits: 'active' | 'error' | 'exhausted' | 'throttled'. */
  status?: string;
  switchThreshold?: number | null;
};

export const account = (input: AccountInput) => ({
  name: input.name,
  type: 'oauth',
  orgName: null,
  status: input.status ?? 'active',
  sessions: 0,
  disabled: input.disabled ?? false,
  quota: {
    unified5h: input.session ?? null,
    unified5hReset: input.session === undefined || input.session === null ? null : NOW + 2 * HOUR,
    unified7d: input.general ?? 0,
    unified7dReset: NOW + (input.weeklyResetInHours ?? 84) * HOUR,
    unified7dFable: input.fable ?? 0,
    unified7dFableReset: NOW + (input.weeklyResetInHours ?? 84) * HOUR,
    unifiedStatus: null,
  },
  usage: { lastUsed: null },
  rateLimitedUntil: input.rateLimitedUntil ?? null,
  pausedUntil: null,
  switchThreshold: input.switchThreshold ?? null,
});

/**
 * `ineligible` names accounts the fable route refuses. Omitted, no route is declared
 * at all, which drovr reads as "no restriction known" rather than "none eligible".
 */
export const status = (
  accounts: ReturnType<typeof account>[],
  ineligible?: string[],
  target: string | null = null,
): TeamclaudeStatus => ({
  currentAccount: accounts[0]?.name ?? null,
  accounts,
  switchThreshold: null,
  switchThresholds: null,
  routes:
    ineligible === undefined
      ? []
      : [
          {
            name: 'fable',
            accounts: accounts.map((entry) => ({
              name: entry.name,
              eligible: !ineligible.includes(entry.name),
            })),
            target,
          },
        ],
});

export const control = (overrides: Record<string, unknown> = {}): Control =>
  parseControl({
    mode: 'normal',
    programs: [{ name: 'demo', cwd: '/tmp/demo' }],
    ...overrides,
  });

/** Three healthy accounts: plenty of both buckets, nothing near a ceiling. */
export const healthy = () =>
  status([
    account({ name: 'a', fable: 0.05, general: 0.05, session: 0.0 }),
    account({ name: 'b', fable: 0.1, general: 0.1, session: 0.0 }),
    account({ name: 'c', fable: 0.1, general: 0.1, session: 0.0 }),
  ]);
