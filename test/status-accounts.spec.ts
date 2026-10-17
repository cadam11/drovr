import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsFromTeamclaude, statusAccountShape } from '../src/status-accounts.ts';
import { parseStatus } from '../src/teamclaude.ts';

/** `teamclaude status --json` as the Hadrian box prints it: two accounts, a fable route, a fleet threshold table. */
const recorded = {
  currentAccount: 'fifth@example.com',
  switchThreshold: 0.95,
  switchThresholds: { unified5h: 0.98, unified7d: 0.9, unified7dFable: 0.98 },
  accounts: [
    {
      name: 'fifth@example.com', type: 'oauth', orgName: 'Propra', status: 'active', sessions: 2, disabled: false,
      quota: { unified5h: 0.23, unified5hReset: 1787596200000, unified7d: 0.87, unified7dReset: 1787778000000, unified7dFable: 0.94, unified7dFableReset: 1787778000000, unifiedStatus: 'allowed_warning' },
      usage: { lastUsed: '2026-10-17T15:22:59.091Z' }, rateLimitedUntil: null, pausedUntil: null, switchThreshold: null,
    },
    {
      name: 'agent@example.com', type: 'oauth', orgName: null, status: 'active', sessions: 0, disabled: false,
      quota: { unified5h: null, unified5hReset: null, unified7d: null, unified7dReset: null, unified7dFable: null, unified7dFableReset: null, unifiedStatus: null },
      usage: { lastUsed: null }, rateLimitedUntil: null, pausedUntil: null, switchThreshold: 0.8,
    },
  ],
  routes: [{ name: 'fable', target: 'fifth@example.com', accounts: [{ name: 'fifth@example.com', eligible: true }, { name: 'agent@example.com', eligible: false }] }],
};

test('accountsFromTeamclaude maps a recorded teamclaude status to the shared shape, with no headroom key', () => {
  const accounts = accountsFromTeamclaude(parseStatus(recorded));
  assert.deepEqual(accounts[0], {
    name: 'fifth@example.com', org: 'Propra', status: 'active', sessions: 2, disabled: false, current: true,
    lastUsedAt: '2026-10-17T15:22:59.091Z', fableEligible: true, fableTarget: true,
    buckets: {
      session: { usedFraction: 0.23, resetsAt: '2026-08-24T18:30:00.000Z' },
      general: { usedFraction: 0.87, resetsAt: '2026-08-26T21:00:00.000Z' },
      fable: { usedFraction: 0.94, resetsAt: '2026-08-26T21:00:00.000Z' },
    },
    switchThresholds: { session: 0.98, general: 0.9, fable: 0.98 },
  });
  // An account teamclaude has never used: every bucket null, its own threshold on every bucket.
  assert.deepEqual(accounts[1]?.buckets, {
    session: { usedFraction: null, resetsAt: null }, general: { usedFraction: null, resetsAt: null }, fable: { usedFraction: null, resetsAt: null },
  });
  assert.deepEqual(accounts[1]?.switchThresholds, { session: 0.8, general: 0.8, fable: 0.8 });
  assert.equal(accounts[1]?.fableEligible, false);
  assert.ok(accounts.every((entry) => !('headroom' in entry)), 'headroom is drovr’s pool figure, added by status-payload.ts');
});

test('the shared shape accepts headroom present, null or absent, and strips a field it does not know', () => {
  const [base] = accountsFromTeamclaude(parseStatus(recorded));
  assert.ok(statusAccountShape.safeParse(base).success);
  assert.ok(statusAccountShape.safeParse({ ...base, headroom: null }).success);
  assert.ok(statusAccountShape.safeParse({ ...base, headroom: { fable: 0.1, general: 0.2, session: 0.3 } }).success);
  const stripped = statusAccountShape.parse({ ...base, hadrianOnly: 'x' });
  assert.ok(!('hadrianOnly' in stripped));
});

test('the shared shape fills what a hand-built writer may leave out and refuses what no reader can do without', () => {
  const minimal = statusAccountShape.parse({
    name: 'a@x', disabled: false, fableEligible: null, fableTarget: false, switchThresholds: null,
    buckets: { session: { usedFraction: 0.1, resetsAt: null }, general: { usedFraction: null, resetsAt: null }, fable: { usedFraction: null, resetsAt: null } },
  });
  assert.deepEqual([minimal.org, minimal.status, minimal.sessions, minimal.current, minimal.lastUsedAt], [null, null, 0, false, null]);
  const noBuckets = statusAccountShape.safeParse({ name: 'a@x', disabled: false, fableEligible: null, fableTarget: false, switchThresholds: null });
  assert.equal(noBuckets.success, false);
  assert.deepEqual(noBuckets.success ? [] : noBuckets.error.issues[0]?.path, ['buckets']);
});
