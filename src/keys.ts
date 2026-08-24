import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_CEILINGS, parseControl, readControl, type Control } from './control.ts';
import { MODES } from './modes.ts';
const PAUSES = [
  { label: '1h', ms: 3_600_000 },
  { label: '3h', ms: 10_800_000 },
  { label: '8h', ms: 28_800_000 },
  { label: '24h', ms: 86_400_000 },
];

export type Action = { message: string; redraw: boolean; quit?: boolean };

/**
 * Every edit goes through the control file rather than in-memory state: launchd
 * ticks read the same file, so a change made here applies to the next tick even
 * if the watch session is closed a second later.
 */
const mutate = (path: string, change: (raw: Record<string, unknown>) => void): Control => {
  const raw: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'));
  change(raw);
  const validated = parseControl(raw);
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return validated;
};

const programAt = (raw: Record<string, unknown>, name: string): Record<string, unknown> => {
  const programs = raw.programs;
  if (!Array.isArray(programs)) throw new Error('control.programs is not an array');
  const found = programs.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === name,
  );
  if (found === undefined) throw new Error(`no program named "${name}"`);
  return found;
};

export const cycleMode = (path: string, current: string): Action => {
  const next = MODES[(MODES.indexOf(current as (typeof MODES)[number]) + 1) % MODES.length]!;
  mutate(path, (raw) => {
    raw.mode = next;
  });
  return { message: `mode → ${next}`, redraw: true };
};

export const cyclePause = (path: string, current: string | null): Action => {
  if (current !== null && Date.parse(current) > Date.now()) {
    mutate(path, (raw) => {
      raw.pauseUntil = null;
    });
    return { message: 'pause cleared', redraw: true };
  }
  const step = PAUSES[0]!;
  const until = new Date(Date.now() + step.ms).toISOString();
  mutate(path, (raw) => {
    raw.pauseUntil = until;
  });
  return { message: `paused ${step.label}`, redraw: true };
};

export const extendPause = (path: string, current: string | null): Action => {
  const base = current === null ? Date.now() : Math.max(Date.now(), Date.parse(current));
  const elapsed = base - Date.now();
  const next = PAUSES.find((step) => step.ms > elapsed + 60_000) ?? PAUSES[PAUSES.length - 1]!;
  const until = new Date(Date.now() + next.ms).toISOString();
  mutate(path, (raw) => {
    raw.pauseUntil = until;
  });
  return { message: `paused ${next.label}`, redraw: true };
};

export const toggleEnabled = (path: string, name: string): Action => {
  let enabled = true;
  mutate(path, (raw) => {
    const program = programAt(raw, name);
    enabled = program.enabled !== false ? false : true;
    program.enabled = enabled;
  });
  return { message: `${name} ${enabled ? 'enabled' : 'disabled'}`, redraw: true };
};

export const nudgePriority = (path: string, name: string, delta: number): Action => {
  let priority = 0;
  mutate(path, (raw) => {
    const program = programAt(raw, name);
    const current = typeof program.priority === 'number' ? program.priority : 0;
    priority = Math.max(-9, Math.min(9, current + delta));
    program.priority = priority;
  });
  return { message: `${name} priority → ${priority}`, redraw: true };
};

/**
 * Craig thinks in "space reserved for me", which is the inverse of the ceiling
 * programs may spend up to. The 5h burst ceiling keeps its ratio to the weekly one,
 * so tightening the reserve cannot silently widen bursts.
 */
export const setReserve = (path: string, mode: string, fraction: number): Action => {
  const reserve = Math.max(0.05, Math.min(0.95, fraction));
  const weekly = 1 - reserve;
  let session = 0;

  mutate(path, (raw) => {
    // Seed from the defaults: writing back only the edited mode would leave the
    // others missing, and the next `drovr mode <other>` would have no ceiling.
    const ceilings = { ...DEFAULT_CEILINGS, ...((raw.ceilings ?? {}) as typeof DEFAULT_CEILINGS) };
    const current = ceilings[mode] ?? DEFAULT_CEILINGS.normal!;
    const ratio = current.weekly === 0 ? 1 : current.session / current.weekly;
    session = Math.max(0.05, Math.min(1, weekly * ratio));
    ceilings[mode] = { weekly, session };
    raw.ceilings = ceilings;
  });

  const pct = (value: number): string => `${Math.round(value * 100)}%`;
  return {
    message: `${mode}: ${pct(reserve)} held for you — programs up to ${pct(weekly)} weekly, ${pct(session)} per 5h`,
    redraw: true,
  };
};

export const adjustConcurrency = (path: string, delta: number): Action => {
  let cap = 1;
  mutate(path, (raw) => {
    const current = typeof raw.maxConcurrentCycles === 'number' ? raw.maxConcurrentCycles : 2;
    cap = Math.max(1, Math.min(8, current + delta));
    raw.maxConcurrentCycles = cap;
  });
  return { message: `concurrency cap → ${cap}`, redraw: true };
};

/**
 * Panel intents name a target where the TUI's keys cycle, so they need setters
 * rather than steppers — but the same `mutate`, so control.json keeps one writer.
 *
 * The bounds below restate the parser's own (src/intents.ts) at the point of the
 * write. A setter wider than the parser leaves a gap for any later caller; one
 * narrower silently refuses input the parser promised was valid.
 */
export const setMode = (path: string, mode: string): Action => {
  if (!MODES.includes(mode as (typeof MODES)[number])) {
    throw new Error(`unknown mode "${mode}" — expected one of: ${MODES.join(', ')}`);
  }
  mutate(path, (raw) => {
    raw.mode = mode;
  });
  return { message: `mode → ${mode}`, redraw: true };
};

export const pauseForHours = (path: string, hours: number): Action => {
  if (!Number.isFinite(hours) || hours < 1 || hours > 72) {
    throw new Error(`pause of ${hours}h is out of range — expected 1h to 72h`);
  }
  const until = new Date(Date.now() + hours * 3_600_000).toISOString();
  mutate(path, (raw) => {
    raw.pauseUntil = until;
  });
  return { message: `paused ${hours}h`, redraw: true };
};

export const setEnabled = (path: string, name: string, enabled: boolean): Action => {
  mutate(path, (raw) => {
    programAt(raw, name).enabled = enabled;
  });
  return { message: `${name} ${enabled ? 'enabled' : 'disabled'}`, redraw: true };
};

/**
 * The panel sends a delta against the reserve Craig thinks in; setReserve takes an
 * absolute one, so read the current ceiling first. Refused while the mode is off:
 * there is no ceiling in force to move, and writing an `off` entry would create a
 * number ceilingsFor() never reads.
 */
export const nudgeReserve = (path: string, delta: number): Action => {
  if (!Number.isFinite(delta) || delta < -0.95 || delta > 0.95) {
    throw new Error(`reserve delta ${delta} is out of range — expected -0.95 to 0.95`);
  }
  const control = readControl(path);
  if (control.mode === 'off') {
    throw new Error('mode is off, so no ceiling is in force — set a mode before moving the reserve');
  }
  const fallback = DEFAULT_CEILINGS[control.mode] ?? DEFAULT_CEILINGS.normal!;
  const weekly = control.ceilings[control.mode]?.weekly ?? fallback.weekly;
  return setReserve(path, control.mode, 1 - weekly + delta);
};
