import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Ceilings } from './capacity.ts';

const ceilingsShape = z.object({ weekly: z.number(), session: z.number() });

/**
 * Exported so an edit to one mode cannot silently drop the others — writing back a
 * partial ceilings map would leave the next `drovr mode <other>` with no entry.
 */
export const DEFAULT_CEILINGS: Record<string, { weekly: number; session: number }> = {
  low: { weekly: 0.25, session: 0.25 },
  normal: { weekly: 0.55, session: 0.4 },
  away: { weekly: 0.85, session: 0.6 },
};

export type Ceiling = { weekly: number; session: number };

/** Ascending permissiveness. `off` spends nothing, so it has no ceilings to rank. */
const RANKED = ['low', 'normal', 'away'];

/**
 * The mode names have to mean what they say. `setReserve` edits one mode at a time
 * and clamps each edit only against itself, so nothing stopped `low` drifting above
 * `away`: measured live on 2026-08-25 at session 0.65 against away's 0.60, which made
 * the mode Craig reaches for when he is nervous the most permissive of the three.
 *
 * The mode just edited is authoritative — it is what he asked for — and the others
 * give way around it: tighter modes are pulled down to at most its ceiling, looser
 * ones pushed up to at least it. Ordering is an invariant of the file, not a
 * convention, so it is enforced at every write rather than documented and hoped for.
 */
export const orderCeilings = (
  ceilings: Record<string, Ceiling>,
  edited: string,
): Record<string, Ceiling> => {
  const anchorIndex = RANKED.indexOf(edited);
  if (anchorIndex === -1) return ceilings;

  const out: Record<string, Ceiling> = { ...ceilings };
  const bucket = (mode: string, key: keyof Ceiling): number =>
    out[mode]?.[key] ?? DEFAULT_CEILINGS[mode]![key];
  const put = (mode: string, key: keyof Ceiling, value: number): void => {
    out[mode] = { ...(out[mode] ?? DEFAULT_CEILINGS[mode]!), [key]: value };
  };

  for (const key of ['weekly', 'session'] as const) {
    for (let i = anchorIndex - 1; i >= 0; i -= 1) {
      const looser = RANKED[i + 1]!;
      put(RANKED[i]!, key, Math.min(bucket(RANKED[i]!, key), bucket(looser, key)));
    }
    for (let i = anchorIndex + 1; i < RANKED.length; i += 1) {
      const tighter = RANKED[i - 1]!;
      put(RANKED[i]!, key, Math.max(bucket(RANKED[i]!, key), bucket(tighter, key)));
    }
  }
  return out;
};

/**
 * The install itself comes from the repo's .envrc via direnv, not from here.
 *
 * Asks only. drovr's status page is one page for every program on drovr's own install
 * (publish.ts), so it is not per-program config; `statusPage` and `publishArgs` were
 * dropped when the per-program pages went, and Zod strips them from an older file.
 */
const aiceShape = z.object({
  /** Null until the program has an asks page; the loop creates one on onboarding. */
  asksPage: z.string().nullable().default(null),
});

/**
 * A cycle run on a paired remote Orca runtime instead of this Mac. drovr itself still runs
 * here and keeps the one ledger; only the runner's terminal lives on the box, and the
 * report comes back over ssh. `program.cwd` stays the local checkout for direnv and asks.
 */
const hostShape = z.object({
  /** Orca environment id of the paired runtime, from `orca environment list`. */
  environment: z.string(),
  /** ssh target, e.g. ubuntu@relliq-devbox. */
  ssh: z.string(),
  /** The checkout on the box: an absolute path, since orca addresses the worktree by it. */
  cwd: z.string().regex(/^\//, 'host.cwd must be an absolute path on the box'),
  /** The box's own DROVR_HOME; `~` is the remote user's home, expanded there. */
  drovrHome: z.string().default('~/.drovr'),
  /**
   * The claude binary on the box. Its `claude` alias routes through teamclaude, whose pool
   * is Mac-local and has no server there, so the launch names the binary directly.
   */
  claude: z.string().default('~/.local/bin/claude'),
  /** A local shell command that starts the box and returns once ssh answers. Null: never wake. */
  wake: z.string().nullable().default(null),
});

export type Host = z.infer<typeof hostShape>;

const programShape = z.object({
  name: z.string(),
  cwd: z.string(),
  host: hostShape.nullable().default(null),
  /** {program} and {mode} are substituted before spawning. */
  cycleCommand: z
    .string()
    .default('teamclaude run -- --model {model} -p "/project-loop {program}"'),
  enabled: z.boolean().default(true),
  /**
   * The coordinator is always Fable; it spawns Opus/Sonnet/Haiku subagents itself.
   * Passed per session with claude's --model, never as Craig's default.
   */
  model: z.string().default('fable'),
  /** Run the cycle through direnv so the repo's own .envrc supplies its environment. */
  useDirenv: z.boolean().default(true),
  /**
   * 'orca' opens the cycle as an interactive claude in a terminal of the program's Orca
   * worktree, so it can be talked to like any other session. 'headless' runs claude -p to a
   * log file instead.
   */
  runner: z.enum(['orca', 'headless']).default('orca'),
  /** Prompt sent to the runner. {program} is substituted.
   *  Only used by the headless runner as a full shell command. */
  cyclePrompt: z.string().default('/project-loop {program}'),
  /** Shown in the runner's prompt box and /resume list. {program} is substituted. */
  sessionName: z.string().default('{program} program runner'),
  /** Overrides the global daily cap for this program only. */
  maxCyclesPerDay: z.number().nullable().default(null),
  /**
   * Lower keeps running deeper into a draining pool: each distinct step down raises the
   * admission bar by `priorityStepCycles` (see `priorityRank`). Also the same-tick
   * evaluation order, matching teamclaude priority.
   */
  priority: z.number().default(0),
  /** ISO date. Inside the horizon the program is promoted one priority step. */
  deadline: z.string().nullable().default(null),
  /**
   * ISO timestamp; while in the future no cycle starts for this program alone. Usually
   * set by the program's own cycle (`drovr report --pause-until`) when everything left
   * is waiting on time — soak tests, external actors — rather than on a person. Lapses
   * on its own; `drovr resume <program>` clears it early.
   */
  pauseUntil: z.string().nullable().default(null),
  /**
   * Duration like "12h" or "7d": at most one cycle start per window, measured from the
   * last start. Null means every tick is a candidate. For programs that only need
   * periodic attention; `drovr cadence <program> off` clears it.
   */
  cadence: z.string().regex(/^\d+[mhd]$/, 'cadence must look like 30m, 12h, or 7d')
    .nullable()
    .default(null),
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
  /**
   * Each priority step down raises a program's admission bar by this many cycles, so as
   * the pool drains the lowest-priority programs pause first and the top one runs last.
   * Zero restores priority to a same-tick tiebreak, which live measurement showed binding
   * once a week (docs/allocation-review.md, finding 3).
   */
  priorityStepCycles: z.number().default(0.25),
  maxCyclesPerDay: z.number().default(8),
  /** Hard stop on watching one cycle, so a wedged runner cannot hold its slot forever. */
  maxCycleHours: z.number().default(12),
  /**
   * Wall-clock ceiling on one tick. A pass that overruns releases its own lock and exits,
   * so a wedge cannot stop admission silently. Adjustable because the cost of getting it
   * wrong is asymmetric: too loose only delays the recovery, while too tight aborts
   * healthy passes. A real pass measures around 8s against this default.
   */
  tickBudgetMinutes: z.number().default(8),
  /** Concurrent cycles across all programs; each one reserves capacity from the shared pool. */
  maxConcurrentCycles: z.number().default(2),
  /** Days before a deadline at which a program is promoted one priority step. */
  deadlineHorizonDays: z.number().default(21),
  /** Runner winds down at this context size; the hard stop is above it. */
  contextCeilingTokens: z.number().default(250_000),
  /** Crashes only latch a program while they are recent; older ones age out. */
  crashWindowMinutes: z.number().default(60),
  /** The hey handle alerts go to (infra/users.tf). Null disables every alert; the log line stays. */
  notifyTo: z.string().nullable().default(null),
  nudgeAfterMinutes: z.number().default(240),
  /** How long to leave a blocked program alone before trying again. */
  blockedBackoffMinutes: z.number().default(60),
  /** Consecutive zero-yield cycles before the loop stops and escalates. */
  stuckCycleThreshold: z.number().default(3),
  /** An idle runner that has written no report is stalled once it has idled this long. */
  stallNudgeMinutes: z.number().default(10),
  /** Nudges a stalled runner gets before its cycle is given up on and its pane freed. */
  maxStallNudges: z.number().default(3),
  /**
   * How long a runner may sit on a dialog before Craig is texted to come and clear it.
   * Never nudged and never given up on — a blocked runner's work is intact, merely paused
   * — so a human is the only thing that resolves it, and 20m is short because the cost of
   * not knowing is the whole cycle: measured 2026-08-27, sunnyt held a pane and a
   * concurrency slot for 12.8h on a bash-permission prompt nobody had been told about.
   */
  blockedAlertMinutes: z.number().default(20),
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
 * The phone's Away toggle, for one pass. Returned, never written: the TUI's `m` key and
 * `drovr mode` own the stored mode, and a pass that wrote `away` back would make the toggle
 * sticky after Craig turned it off. `off` is left alone — it is a stop, not a ceiling to loosen.
 */
export const applyAwayMode = (control: Control, awayFromPhone: boolean): Control =>
  awayFromPhone && control.mode !== 'off' ? { ...control, mode: 'away' } : control;

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

/**
 * Where this program sits in the drain order, and who outranks it. Rank 0 is the most
 * important enabled program; each step down deepens the admission bar by
 * `priorityStepCycles`, which is what pauses lower-priority programs first as the pool
 * drains. Counted over *distinct* priority values so equal-priority programs face the
 * same bar rather than one of them losing to a name sort, and only over programs that
 * could actually take a cycle: a disabled program spends nothing, so it must not deepen
 * anyone's bar, and one resting (`pauseUntil`) or outside its cadence window has
 * declared it will not start now — holding room for it is the disabled-program failure
 * with a timer on it (measured 2026-08-29: sunnyt resting 20h shadowed aice-x out of a
 * pool whose binding bucket refilled four times before the wake). The shadow re-forms
 * on its own the tick the rest lapses or the window opens. A `blocked` program still
 * counts: an answer can arrive any second, and a block is a wait, not a refusal of
 * capacity.
 *
 * `lastStartFor` supplies each program's last cycle start (ledger data control.ts must
 * not read itself) so cadence windows can be judged for the shadowing programs, not
 * just the one being ranked.
 */
export const priorityRank = (
  control: Control,
  program: string,
  now: number,
  lastStartFor: (name: string) => number | null,
): { rank: number; above: string[] } => {
  const enabled = control.programs.filter((entry) => entry.enabled);
  const mine = enabled.find((entry) => entry.name === program);
  if (mine === undefined) return { rank: 0, above: [] };

  const startable = enabled.filter((entry) => {
    if (programPausedUntil(entry, now) !== null) return false;
    const windowOpens = nextCadenceStart(entry, lastStartFor(entry.name));
    return windowOpens === null || windowOpens <= now;
  });
  const priorityOf = (entry: Program): number =>
    effectivePriority(entry, now, control.deadlineHorizonDays);
  const higher = startable.filter((entry) => priorityOf(entry) < priorityOf(mine));
  const rank = new Set(higher.map(priorityOf)).size;
  return {
    rank,
    above: byPriority(higher, now, control.deadlineHorizonDays).map((entry) => entry.name),
  };
};

export const parseDuration = (input: string): number => {
  const match = /^(\d+)([mhd])$/.exec(input);
  if (match === null) throw new Error(`duration must look like 30m, 3h, or 2d — got "${input}"`);
  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * ms;
};

/** Longest a program may rest itself, so a confused agent cannot dark one for a season. */
export const MAX_REST_DAYS = 35;

/** A lapsed pause is not a pause (the panel/index.html trap): only a future timestamp holds. */
export const programPausedUntil = (entry: Program, now: number): number | null => {
  if (entry.pauseUntil === null) return null;
  const until = Date.parse(entry.pauseUntil);
  if (Number.isNaN(until)) {
    throw new Error(`${entry.name}.pauseUntil is not a valid timestamp: ${entry.pauseUntil}`);
  }
  return until > now ? until : null;
};

/**
 * When the cadence window opens again. Measured from the last *start* — a cycle in
 * flight opens its window too, or a long cycle plus its cadence would drift the
 * schedule. Null when cadence is unset or nothing has ever run: a cadence must never
 * stop a program's first cycle.
 */
export const nextCadenceStart = (entry: Program, lastStartedAt: number | null): number | null => {
  if (entry.cadence === null || lastStartedAt === null) return null;
  return lastStartedAt + parseDuration(entry.cadence);
};

export const isPaused = (control: Control, now: number): boolean => {
  if (control.pauseUntil === null) return false;
  const until = Date.parse(control.pauseUntil);
  if (Number.isNaN(until)) {
    throw new Error(`control.pauseUntil is not a valid timestamp: ${control.pauseUntil}`);
  }
  return until > now;
};
