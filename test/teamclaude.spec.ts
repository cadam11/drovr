import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus } from '../src/teamclaude.ts';

const raw = {
  currentAccount: 'fourth@example.com',
  accounts: [
    {
      name: 'fourth@example.com',
      type: 'oauth',
      orgName: "fourth@example.com's Organization",
      status: 'active',
      sessions: 4,
      disabled: false,
      quota: {
        unified5h: 0.23, unified5hReset: 1787596200000,
        unified7d: 0.87, unified7dReset: 1787778000000,
        unified7dFable: 0.94, unified7dFableReset: 1787778000000,
        unifiedStatus: 'allowed_warning',
      },
      usage: { lastUsed: '2026-08-24T15:22:59.091Z' },
      rateLimitedUntil: null,
      pausedUntil: null,
    },
  ],
};

test('parseStatus keeps the fields the panel renders', () => {
  const parsed = parseStatus(raw);
  const account = parsed.accounts[0]!;
  assert.equal(account.type, 'oauth');
  assert.equal(account.status, 'active');
  assert.equal(account.sessions, 4);
  assert.equal(account.usage.lastUsed, '2026-08-24T15:22:59.091Z');
  assert.equal(account.quota.unifiedStatus, 'allowed_warning');
});

test('parseStatus tolerates an account that has never been used', () => {
  const parsed = parseStatus({
    currentAccount: null,
    accounts: [{
      name: 'second@example.com',
      type: 'oauth', orgName: 'Propra', status: 'active', sessions: 0, disabled: false,
      quota: {
        unified5h: null, unified5hReset: null, unified7d: null, unified7dReset: null,
        unified7dFable: null, unified7dFableReset: null, unifiedStatus: null,
      },
      usage: { lastUsed: null },
      rateLimitedUntil: null, pausedUntil: null,
    }],
  });
  assert.equal(parsed.accounts[0]!.quota.unifiedStatus, null);
  assert.equal(parsed.accounts[0]!.usage.lastUsed, null);
});
