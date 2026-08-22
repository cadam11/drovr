import { readFileSync, writeFileSync } from 'node:fs';
import { parseControl, type Control } from './control.ts';

const MODES = ['off', 'low', 'normal', 'away'] as const;
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

export const adjustConcurrency = (path: string, delta: number): Action => {
  let cap = 1;
  mutate(path, (raw) => {
    const current = typeof raw.maxConcurrentCycles === 'number' ? raw.maxConcurrentCycles : 2;
    cap = Math.max(1, Math.min(8, current + delta));
    raw.maxConcurrentCycles = cap;
  });
  return { message: `concurrency cap → ${cap}`, redraw: true };
};
