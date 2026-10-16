import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRepo, LUCIDE_TO_SF, profileFromRepo } from '../src/profile.ts';

const repo = (overrides: Record<string, unknown>) => ({ id: 'r1', path: '/Users/cadam/code/x', badgeColor: '#737373', repoIcon: null, ...overrides });

test('an emoji icon and the badge colour become the profile', () => {
  assert.deepEqual(profileFromRepo(repo({ repoIcon: { type: 'emoji', emoji: '🦾' } }), null), { icon: '🦾', color: '#737373' });
});

test('a lucide icon maps through the table, or is dropped', () => {
  assert.deepEqual(profileFromRepo(repo({ repoIcon: { type: 'lucide', name: 'Globe' } }), null), { icon: 'sf:globe', color: '#737373' });
  assert.deepEqual(profileFromRepo(repo({ repoIcon: { type: 'lucide', name: 'Unicorn' } }), null), { color: '#737373' });
  for (const [lucide, sf] of Object.entries(LUCIDE_TO_SF)) assert.match(sf, /^[a-z0-9.]+$/, lucide);
});

test('an image icon keeps its https URL, keeps a small data URL, and drops a big one', () => {
  const url = 'https://github.com/propra-tech.png?size=64';
  assert.equal(profileFromRepo(repo({ repoIcon: { type: 'image', src: url, source: 'github', label: 'x' } }), null)?.icon, url);
  const small = `data:image/png;base64,${'A'.repeat(7800)}`;
  assert.equal(profileFromRepo(repo({ repoIcon: { type: 'image', src: small, source: 'upload', label: 'x' } }), null)?.icon, small);
  const big = `data:image/png;base64,${'A'.repeat(40_000)}`;
  assert.deepEqual(profileFromRepo(repo({ repoIcon: { type: 'image', src: big, source: 'file', label: 'x' } }), null), { color: '#737373' });
});

test('a description is the summary; nothing at all is null; a bad colour is dropped', () => {
  assert.deepEqual(profileFromRepo(repo({ badgeColor: null }), 'Ticket loop for sunnyt'), { summary: 'Ticket loop for sunnyt' });
  assert.equal(profileFromRepo(repo({ badgeColor: null }), null), null);
  assert.deepEqual(profileFromRepo(repo({ badgeColor: 'purple', repoIcon: { type: 'emoji', emoji: '📣' } }), null), { icon: '📣' });
  assert.equal(profileFromRepo({ nonsense: true }, null), null);
  assert.equal(profileFromRepo(repo({ repoIcon: { type: 'hologram', src: 'x' } }), null)?.icon, undefined);
});

test('findRepo picks the repo by id and is null for an unknown id or a malformed list', () => {
  const repos = [repo({ id: 'a' }), repo({ id: 'b', badgeColor: '#8b5cf6' })];
  assert.equal((findRepo(repos, 'b') as { badgeColor: string }).badgeColor, '#8b5cf6');
  assert.equal(findRepo(repos, 'zzz'), null);
  assert.equal(findRepo([42, 'x', null], 'a'), null);
});
