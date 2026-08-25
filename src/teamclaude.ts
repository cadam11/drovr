import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { explainSpawn } from './exec.ts';

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
  unifiedStatus: z.string().nullable().default(null),
});

const accountShape = z.object({
  name: z.string(),
  type: z.string().default('oauth'),
  orgName: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  sessions: z.number().default(0),
  disabled: z.boolean(),
  quota: bucketFields,
  usage: z.object({ lastUsed: z.string().nullable().default(null) }).default({ lastUsed: null }),
  rateLimitedUntil: z.number().nullable(),
  pausedUntil: z.number().nullable(),
});

/**
 * teamclaude routes per model. Only the route's own eligibility flags matter here —
 * the match globs and colours are its business, not drovr's.
 */
const routeShape = z.object({
  name: z.string(),
  accounts: z.array(z.object({ name: z.string(), eligible: z.boolean() })).default([]),
});

const statusShape = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.array(accountShape),
  routes: z.array(routeShape).default([]),
});

export type TeamclaudeStatus = z.infer<typeof statusShape>;
export type TeamclaudeAccount = z.infer<typeof accountShape>;

/**
 * The runner is always Fable, so an account the fable route marks ineligible will
 * never serve one of its requests — its headroom is not drovr's to spend, however
 * healthy the three buckets look. Eligibility tracks usage against teamclaude's own
 * switchThreshold, so an ineligible account usually becomes eligible again at its
 * next reset rather than needing anyone to intervene.
 *
 * Null when teamclaude declares no fable route, or names no accounts on it: that is
 * "no restriction known", which is very different from "nothing is eligible".
 */
export const fableEligible = (status: TeamclaudeStatus): Set<string> | null => {
  const route = status.routes.find((entry) => entry.name === 'fable');
  if (route === undefined || route.accounts.length === 0) return null;
  return new Set(route.accounts.filter((entry) => entry.eligible).map((entry) => entry.name));
};

export const parseStatus = (raw: unknown): TeamclaudeStatus => {
  const parsed = statusShape.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`teamclaude status did not match expected shape: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const readStatus = async (bin = 'teamclaude'): Promise<TeamclaudeStatus> => {
  try {
    const { stdout } = await run(bin, ['status', '--json'], { maxBuffer: 8 * 1024 * 1024 });
    return parseStatus(JSON.parse(stdout));
  } catch (error) {
    throw explainSpawn(bin, error);
  }
};
