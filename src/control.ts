import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Ceilings } from './capacity.ts';

const ceilingsShape = z.object({ weekly: z.number(), session: z.number() });

/**
 * Programs live on different aice installs (propra vs aice-x), and aice-x
 * publishes need `--agent claude`, so the flags travel with the program.
 */
const aiceShape = z.object({
  asksPage: z.string(),
  statusPage: z.string(),
  publishArgs: z.array(z.string()).default([]),
});

const programShape = z.object({
  name: z.string(),
  cwd: z.string(),
  /** {program} and {mode} are substituted before spawning. */
  cycleCommand: z.string().default('teamclaude run -- -p "/project-loop {program}"'),
  enabled: z.boolean().default(true),
  aice: aiceShape.nullable().default(null),
});

const controlShape = z.object({
  mode: z.enum(['off', 'low', 'normal', 'away']).default('normal'),
  /** ISO timestamp; while in the future no cycle starts, whatever the mode. */
  pauseUntil: z.string().nullable().default(null),
  ceilings: z
    .record(z.string(), ceilingsShape)
    .default({
      low: { weekly: 0.25, session: 0.25 },
      normal: { weekly: 0.55, session: 0.4 },
      away: { weekly: 0.85, session: 0.6 },
    }),
  /** Spare cycles the pool must still hold after admitting one, so a cycle can always land. */
  reserveCycles: z.number().default(0.5),
  maxCyclesPerDay: z.number().default(8),
  /** Runner winds down at this context size; the hard stop is above it. */
  contextCeilingTokens: z.number().default(250_000),
  /** Consecutive zero-yield cycles before the loop stops and escalates. */
  stuckCycleThreshold: z.number().default(3),
  /** Used until the ledger holds enough delivery cycles to measure real cost. */
  seedCycleCost: z
    .object({ fable: z.number(), general: z.number(), session: z.number() })
    .default({ fable: 0.1, general: 0.08, session: 0.25 }),
  programs: z.array(programShape).default([]),
});

export type Control = z.infer<typeof controlShape>;
export type Program = z.infer<typeof programShape>;

export const parseControl = (raw: unknown): Control => {
  const parsed = controlShape.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`control file is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const readControl = (path: string): Control => {
  const contents = readFileSync(path, 'utf8');
  return parseControl(JSON.parse(contents));
};

export const ceilingsFor = (control: Control): Ceilings | null => {
  if (control.mode === 'off') return null;
  const ceilings = control.ceilings[control.mode];
  if (ceilings === undefined) {
    throw new Error(`control.ceilings has no entry for mode "${control.mode}"`);
  }
  return ceilings;
};

export const isPaused = (control: Control, now: number): boolean => {
  if (control.pauseUntil === null) return false;
  const until = Date.parse(control.pauseUntil);
  if (Number.isNaN(until)) {
    throw new Error(`control.pauseUntil is not a valid timestamp: ${control.pauseUntil}`);
  }
  return until > now;
};
