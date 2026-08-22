import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

/**
 * teamclaude reports each quota bucket as a used-fraction (0..1) plus an epoch-ms
 * reset. A null bucket means no window is currently open, i.e. nothing used yet.
 */
const bucketFields = z.object({
  unified5h: z.number().nullable(),
  unified5hReset: z.number().nullable(),
  unified7d: z.number().nullable(),
  unified7dReset: z.number().nullable(),
  unified7dFable: z.number().nullable(),
  unified7dFableReset: z.number().nullable(),
});

const accountShape = z.object({
  name: z.string(),
  disabled: z.boolean(),
  quota: bucketFields,
  rateLimitedUntil: z.number().nullable(),
  pausedUntil: z.number().nullable(),
});

const statusShape = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.array(accountShape),
});

export type TeamclaudeStatus = z.infer<typeof statusShape>;
export type TeamclaudeAccount = z.infer<typeof accountShape>;

export const parseStatus = (raw: unknown): TeamclaudeStatus => {
  const parsed = statusShape.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`teamclaude status did not match expected shape: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const readStatus = async (bin = 'teamclaude'): Promise<TeamclaudeStatus> => {
  const { stdout } = await run(bin, ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 });
  return parseStatus(JSON.parse(stdout));
};
