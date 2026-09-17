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

test('parseStatus defaults fields a future teamclaude payload might omit outright', () => {
  const parsed = parseStatus({
    currentAccount: null,
    accounts: [{
      name: 'second@example.com',
      disabled: false,
      quota: {
        unified5h: null, unified5hReset: null, unified7d: null, unified7dReset: null,
        unified7dFable: null, unified7dFableReset: null,
      },
      rateLimitedUntil: null, pausedUntil: null,
    }],
  });
  const account = parsed.accounts[0]!;
  assert.equal(account.type, 'oauth');
  assert.equal(account.orgName, null);
  assert.equal(account.status, null);
  assert.equal(account.sessions, 0);
  assert.equal(account.usage.lastUsed, null);
  assert.equal(account.quota.unifiedStatus, null);
});

/**
 * Recorded from tick.err, 2026-09-14T17:38:50Z. Five consecutive ticks refused a payload
 * whose only fault was this field's type, and drovr made no decision for the hour they
 * spanned. The two "until" fields are null on every healthy status, so this shape is
 * reachable *only* while an account is throttled — which is when admission matters most.
 */
const throttled = (until: unknown, paused: unknown = null) => ({
  currentAccount: 'fourth@example.com',
  accounts: [{
    name: 'fourth@example.com',
    type: 'oauth', orgName: 'Propra', status: 'throttled', sessions: 1, disabled: false,
    quota: {
      unified5h: 0.4, unified5hReset: 1787596200000,
      unified7d: 0.5, unified7dReset: 1787778000000,
      unified7dFable: 0.6, unified7dFableReset: 1787778000000,
      unifiedStatus: 'allowed_warning',
    },
    usage: { lastUsed: '2026-09-14T17:38:00.000Z' },
    rateLimitedUntil: until,
    pausedUntil: paused,
  }],
});

test('a throttled account reported as an ISO string parses, where it used to kill the tick', () => {
  const account = parseStatus(throttled('2026-09-14T18:00:00.000Z')).accounts[0]!;
  assert.equal(account.rateLimitedUntil, Date.parse('2026-09-14T18:00:00.000Z'));
});

test('an epoch-ms string coerces to the same number capacity.ts compares against now', () => {
  const account = parseStatus(throttled('1787596200000', '1787596200000')).accounts[0]!;
  assert.equal(account.rateLimitedUntil, 1787596200000);
  assert.equal(account.pausedUntil, 1787596200000);
});

test('a number is still a number, and null is still null', () => {
  const account = parseStatus(throttled(1787596200000, null)).accounts[0]!;
  assert.equal(account.rateLimitedUntil, 1787596200000);
  assert.equal(account.pausedUntil, null);
});

/**
 * Null is this field's own word for "no limit known" and capacity.ts already treats it
 * that way, so an unreadable instant costs one account's throttle state rather than the
 * whole pass. Never left as a string: capacity.ts compares it against `now`, where a
 * string compares false and marks a throttled account usable.
 */
test('an unparseable instant reads as no limit known, not as a refused payload', () => {
  const account = parseStatus(throttled('whenever', 'soon')).accounts[0]!;
  assert.equal(account.rateLimitedUntil, null);
  assert.equal(account.pausedUntil, null);
});

test('a reset reported as a string coerces too — one rule, no exception to re-derive', () => {
  const raw = throttled(null);
  raw.accounts[0]!.quota.unified7dReset = '2026-09-21T00:00:00.000Z' as never;
  assert.equal(parseStatus(raw).accounts[0]!.quota.unified7dReset, Date.parse('2026-09-21T00:00:00.000Z'));
});

test('parseStatus still refuses a type it cannot make an instant of', () => {
  assert.throws(() => parseStatus(throttled({ at: 1787596200000 })), /did not match expected shape/);
});
