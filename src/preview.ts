// src/preview.ts

/** claude marks each assistant turn with one of these glyphs. */
const TURN_GLYPHS = ['⏺', '✻', '✦'];

const MAX_LINE = 200;
const MAX_SCAN = 400;

export type Preview = {
  lines: string[];
  contextPercent: number | null;
  contextTokens: number | null;
  subagents: number | null;
};

const isTurn = (line: string): boolean => TURN_GLYPHS.some((glyph) => line.startsWith(glyph));

const strip = (line: string): string =>
  Array.from(line).slice(1).join('').trim().slice(0, MAX_LINE);

const lastMatch = (text: string, pattern: RegExp): RegExpExecArray | null => {
  let match: RegExpExecArray | null = null;
  let lastMatch: RegExpExecArray | null = null;
  const regex = new RegExp(pattern, 'g');
  while ((match = regex.exec(text)) !== null) {
    lastMatch = match;
  }
  return lastMatch;
};

const gauge = (scanned: string): { percent: number | null; tokens: number | null } => {
  const match = lastMatch(scanned, /ctx:\s*(\d+)%\s*\(([\d.]+)([km])\)/i);
  if (match === null) return { percent: null, tokens: null };
  const scale = match[3]!.toLowerCase() === 'm' ? 1_000_000 : 1_000;
  return { percent: Number(match[1]), tokens: Math.round(Number(match[2]) * scale) };
};

/** Line truncation is by character; this enforces the byte budget the panel ships. */
const capBytes = (lines: string[], budget = 2048): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  return kept;
};

const monitors = (scanned: string): number | null => {
  const match = lastMatch(scanned, /(\d+)\s+monitor/);
  return match === null ? null : Number(match[1]);
};

/**
 * A scrape of claude's TUI, not a declared interface: the format changes between
 * releases, so an unrecognised shape yields null and the panel simply shows no
 * preview. This must never be able to fail a tick.
 */
export const parsePreview = (raw: string, maxLines = 6): Preview | null => {
  if (raw.trim() === '') return null;

  const all = raw.split('\n');
  const scanned = all.slice(Math.max(0, all.length - MAX_SCAN));
  const turns = scanned.filter(isTurn).map(strip).filter((line) => line !== '');
  if (turns.length === 0) return null;

  const scannedText = scanned.join('\n');
  const { percent, tokens } = gauge(scannedText);
  return {
    lines: capBytes(turns.slice(-maxLines)),
    contextPercent: percent,
    contextTokens: tokens,
    subagents: monitors(scannedText),
  };
};
