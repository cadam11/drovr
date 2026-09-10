import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const root = (): string => process.env.DROVR_HOME ?? join(homedir(), '.drovr');

export const paths = () => {
  const base = root();
  return {
    base,
    control: join(base, 'control.json'),
    cycles: join(base, 'cycles.jsonl'),
    decisions: join(base, 'decisions.jsonl'),
    /** Sampled per tick: the only record of how much of the pool Craig himself takes. */
    usage: join(base, 'usage.jsonl'),
    lastTick: join(base, 'last-tick.json'),
    tickLock: join(base, 'tick.lock'),
    programLock: (program: string) => join(base, 'programs', program, 'cycle.lock'),
    logs: join(base, 'logs'),
    programState: (program: string) => join(base, 'programs', program),
    lastCycle: (program: string) => join(base, 'programs', program, 'last-cycle.json'),
    stateFile: (program: string) => join(base, 'programs', program, 'state.json'),
  };
};

export const ensureDirs = (program?: string): void => {
  const p = paths();
  mkdirSync(p.logs, { recursive: true });
  if (program !== undefined) mkdirSync(p.programState(program), { recursive: true });
};
