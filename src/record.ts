import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Port tooling, not a feature. When DROVR_RECORD names a directory, every call to a hooked
 * pure function writes its input and output there, keyed by a hash of the input, so the Go
 * suite can replay the whole TS suite's cases. Off (the normal case) it costs one env read.
 * Deleted with src/ at cut-over.
 */
const replacer = (_key: string, value: unknown): unknown => {
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return value;
};

export const record = <T>(fn: string, input: unknown, output: T): T => {
  const dir = process.env.DROVR_RECORD;
  if (dir === undefined) return output;
  const body = JSON.stringify({ fn, input, output }, replacer, 2);
  const key = createHash('sha1').update(JSON.stringify(input, replacer)).digest('hex').slice(0, 16);
  mkdirSync(join(dir, fn), { recursive: true });
  writeFileSync(join(dir, fn, `${key}.json`), `${body}\n`, 'utf8');
  return output;
};
