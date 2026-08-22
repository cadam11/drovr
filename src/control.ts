import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Ceilings } from './capacity.ts';

const ceilingsShape = z.object({ weekly: z.number(), session: z.number() });

/** The install itself comes from the repo's .envrc via direnv, not from here. */
const aiceShape = z.object({
  /** Null until the program has an asks page; the loop creates one on onboarding. */
  asksPage: z.string().nullable().default(null),
  statusPage: z.string(),
  publishArgs: z.array(z.string()).default(['--agent', 'claude']),
});

const programShape = z.object({
  name: z.string(),
  cwd: z.string(),
  /** {program} and {mode} are substituted before spawning. */
  cycleCommand: z.string().default('teamclaude run -- -p "/project-loop {program}"'),
  enabled: z.boolean().default(true),
  /** Run the cycle through direnv so the repo's own .envrc supplies its environment. */
  useDirenv: z.boolean().default(true),
  /**
   * 'herdr' opens the cycle as an interactive agent tab in the program's workspace, so it can
   * be talked to like any other session. 'headless' runs claude -p to a log file instead.
   */
  runner: z.enum(['herdr', 'headless']).default('herdr'),
  /** Pin the herdr workspace; otherwise it is matched by label, then by cwd. */
  herdrWorkspace: z.string().nullable().default(null),
  /** Prompt sent to the runner. {program} is substituted.
   *  Only used by the headless runner as a full shell command. */
  cyclePrompt: z.string().default('/project-loop {program}'),
  /** Lower wins the next capacity slot, matching teamclaude priority. */
  priority: z.number().default(0),
  /** ISO date. Inside the horizon the program is promoted one priority step. */
  deadline: z.string().nullable().default(null),
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
  /** Hard stop on watching one cycle, so a wedged runner cannot hold its slot forever. */
  maxCycleHours: z.number().default(12),
  /** Concurrent cycles across all programs; each one reserves capacity from the shared pool. */
  maxConcurrentCycles: z.number().default(2),
  /** Days before a deadline at which a program is promoted one priority step. */
  deadlineHorizonDays: z.number().default(21),
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

/**
 * A calendar-bound program earns a priority step as its date closes in, and keeps
 * it while overdue — a deadline that has passed is more urgent, not less.
 */
export const effectivePriority = (program: Program, now: number, horizonDays: number): number => {
  if (program.deadline === null) return program.priority;
  const at = Date.parse(program.deadline);
  if (Number.isNaN(at)) {
    throw new Error(`program "${program.name}" has an invalid deadline: ${program.deadline}`);
  }
  const daysAway = (at - now) / 86_400_000;
  return daysAway <= horizonDays ? program.priority - 1 : program.priority;
};

/** Priority order, name as a deterministic tie-break. */
export const byPriority = (programs: Program[], now: number, horizonDays: number): Program[] =>
  [...programs].sort(
    (a, b) =>
      effectivePriority(a, now, horizonDays) - effectivePriority(b, now, horizonDays) ||
      a.name.localeCompare(b.name),
  );

export const isPaused = (control: Control, now: number): boolean => {
  if (control.pauseUntil === null) return false;
  const until = Date.parse(control.pauseUntil);
  if (Number.isNaN(until)) {
    throw new Error(`control.pauseUntil is not a valid timestamp: ${control.pauseUntil}`);
  }
  return until > now;
};
