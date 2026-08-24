// test/preview.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePreview } from '../src/preview.ts';

const REAL = `⏺ Agent "Promotion train + S-123 close" finished · 30m 42s

⏺ Poll 7, ~8 min. Waiting.

✻ Cooked for 5s · 1 monitor still running

──────────────── sunnyt program runner ─
❯
────────────────────────────────────────
  Propra@Craigs-MacBook-Pro in sunnyt on stage
  using Fable 5 | ctx:18% (176k)
  ⏵⏵ auto mode on · 1 monitor · ← for agents
`;

test('parsePreview takes the trailing assistant lines', () => {
  const preview = parsePreview(REAL)!;
  assert.equal(preview.lines.length, 3);
  assert.match(preview.lines[0]!, /^Agent "Promotion train/);
  assert.equal(preview.lines[2]!, 'Cooked for 5s · 1 monitor still running');
});

test('parsePreview reads the context gauge', () => {
  const preview = parsePreview(REAL)!;
  assert.equal(preview.contextPercent, 18);
  assert.equal(preview.contextTokens, 176_000);
  assert.equal(preview.subagents, 1);
});

test('parsePreview is bounded by maxLines and truncates long lines', () => {
  const raw = Array.from({ length: 40 }, (_, i) => `⏺ line ${i} ${'x'.repeat(400)}`).join('\n');
  const preview = parsePreview(raw, 6)!;
  assert.equal(preview.lines.length, 6);
  assert.ok(preview.lines.every((line) => line.length <= 200));
  assert.match(preview.lines[5]!, /^line 39/);
});

test('parsePreview caps the whole preview at 2KB of UTF-8', () => {
  const raw = Array.from({ length: 10 }, (_, i) => `⏺ ${'✻'.repeat(190)} ${i}`).join('\n');
  const preview = parsePreview(raw)!;
  assert.ok(Buffer.byteLength(preview.lines.join('\n'), 'utf8') <= 2048);
});

test('parsePreview returns null rather than throwing on an unrecognised shape', () => {
  assert.equal(parsePreview(''), null);
  assert.equal(parsePreview('claude: command not found'), null);
});
