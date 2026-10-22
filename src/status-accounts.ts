import { record } from './record.ts';
import { z } from 'zod';
import { fableEligible, switchThresholds, type TeamclaudeStatus } from './teamclaude.ts';

const bucketShape = z.object({ usedFraction: z.number().nullable(), resetsAt: z.string().nullable() });
const thresholdsShape = z.object({ session: z.number().nullable(), general: z.number().nullable(), fable: z.number().nullable() });
export const headroomShape = z.object({ fable: z.number(), general: z.number(), session: z.number() });

/**
 * One teamclaude account as every status writer puts it on the wire — drovr's tick and any
 * program piping `teamclaude status --json` through `hey status put --teamclaude`. The phone
 * draws this as the accounts grid (ios `DrovrStatus.Account`), so the two are kept field for
 * field. `headroom` is drovr's pool figure under its ceilings and only drovr has one; a writer
 * with no pool leaves it out and the grid shows no figure.
 */
export const statusAccountShape = z.object({
  name: z.string().min(1),
  org: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  sessions: z.number().int().nonnegative().default(0),
  disabled: z.boolean(),
  current: z.boolean().default(false),
  lastUsedAt: z.string().nullable().default(null),
  /** Null when teamclaude declares no fable route: no restriction known, not none eligible. */
  fableEligible: z.boolean().nullable(),
  fableTarget: z.boolean(),
  buckets: z.object({ session: bucketShape, general: bucketShape, fable: bucketShape }),
  switchThresholds: thresholdsShape.nullable(),
  headroom: headroomShape.nullable().optional(),
});
export type StatusAccount = z.infer<typeof statusAccountShape>;

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

/** The ACCOUNTS block of `drovr watch`, per account, from a parsed teamclaude status. Pure. */
const accountsFromTeamclaudeUnrecorded = (status: TeamclaudeStatus): StatusAccount[] => {
  const eligible = fableEligible(status);
  const target = status.routes.find((route) => route.name === 'fable')?.target ?? null;
  return status.accounts.map((account) => ({
    name: account.name,
    org: account.orgName,
    status: account.status,
    sessions: account.sessions,
    disabled: account.disabled,
    current: account.name === status.currentAccount,
    lastUsedAt: account.usage.lastUsed,
    fableEligible: eligible === null ? null : eligible.has(account.name),
    fableTarget: account.name === target,
    buckets: {
      session: { usedFraction: account.quota.unified5h, resetsAt: iso(account.quota.unified5hReset) },
      general: { usedFraction: account.quota.unified7d, resetsAt: iso(account.quota.unified7dReset) },
      fable: { usedFraction: account.quota.unified7dFable, resetsAt: iso(account.quota.unified7dFableReset) },
    },
    switchThresholds: switchThresholds(status, account),
  }));
};

export const accountsFromTeamclaude = (status: TeamclaudeStatus): StatusAccount[] =>
  record('accountsFromTeamclaude', { status }, accountsFromTeamclaudeUnrecorded(status));
