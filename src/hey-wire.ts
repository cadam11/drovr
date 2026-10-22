import { z } from 'zod';

/**
 * The wire contract between the hey Lambda and its clients (drovr's tick, the CLI oracle), kept
 * in the client's tree so the public drovr repo carries it without the Lambda. The Lambda
 * imports it from here; nothing in this file touches a table or a network.
 */

/** A row key segment and a card heading: lowercase, readable, no `@` or `#`. */
export const PROGRAM_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour');

export const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const quietHoursShape = z.object({
  from: HHMM,
  to: HHMM,
  tz: z.string().refine(isTimeZone, { message: 'tz must be an IANA zone like America/Winnipeg' }),
});

/**
 * Known keys only, here and in the app's decoder: a key one side does not know is a row the
 * other side cannot trust, and the two must agree on what a prefs row is.
 */
export const prefsShape = z.object({ quietHours: quietHoursShape.nullable(), away: z.boolean() }).strict();
export type Prefs = z.infer<typeof prefsShape>;

const MAX_ICON_DATA_CHARS = 32 * 1024;
const MAX_SUMMARY_CHARS = 500;
const MAX_URL_CHARS = 2048;
const DATA_PNG_PREFIX = 'data:image/png;base64,';

export type IconForm = 'emoji' | 'symbol' | 'url' | 'data';

/**
 * The whole icon contract, in one place; the app's `ProfileIcon.parse` accepts the same four forms
 * in the same order. Null is "not an icon". Emoji: up to eight scalars, at least one pictographic,
 * no whitespace — long enough for a ZWJ sequence, too short for a sentence.
 */
export const iconForm = (icon: string): IconForm | null => {
  if (/^sf:[A-Za-z0-9.]+$/.test(icon)) return 'symbol';
  if (icon.startsWith(DATA_PNG_PREFIX)) {
    const data = icon.slice(DATA_PNG_PREFIX.length);
    return icon.length <= MAX_ICON_DATA_CHARS && /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? 'data' : null;
  }
  if (icon.startsWith('https://')) {
    if (icon.length > MAX_URL_CHARS) return null;
    try {
      new URL(icon);
      return 'url';
    } catch {
      return null;
    }
  }
  const glyphs = [...icon];
  const pictographic = /\p{Extended_Pictographic}/u.test(icon) && !/\s/.test(icon);
  return glyphs.length >= 1 && glyphs.length <= 8 && pictographic ? 'emoji' : null;
};

export type Profile = { from: string; icon: string | null; summary: string | null; color: string | null; updatedAt: string | null };

/**
 * A status row: `payload` is JSON text kept as a string so the phone decodes it with one
 * Codable pass; the Lambda never looks inside beyond checking it is an object. `program`
 * defaults on read because every row written before plan 12 is drovr's.
 */
export const statusRowShape = z.object({
  pk: z.string(),
  sk: z.string().startsWith('status#'),
  program: z.string().default('drovr'),
  host: z.string(),
  at: z.string(),
  payload: z.string(),
  expiresAt: z.number(),
});
export type StatusRow = z.infer<typeof statusRowShape>;

/** The `not_found` message's fixed prefix; the CLI reads a deleted message off it (`MessageGone` in src/hey.ts). */
export const NOT_FOUND_PREFIX = 'no message ';
