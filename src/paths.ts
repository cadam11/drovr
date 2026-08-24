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
    snapshotState: join(base, 'snapshot-state.json'),
    decisions: join(base, 'decisions.jsonl'),
    tickLock: join(base, 'tick.lock'),
    programLock: (program: string) => join(base, 'programs', program, 'cycle.lock'),
    logs: join(base, 'logs'),
    programState: (program: string) => join(base, 'programs', program),
    lastCycle: (program: string) => join(base, 'programs', program, 'last-cycle.json'),
    stateFile: (program: string) => join(base, 'programs', program, 'state.json'),
    statusPage: (program: string) => join(base, 'programs', program, 'status.html'),
  };
};

export const ensureDirs = (program?: string): void => {
  const p = paths();
  mkdirSync(p.logs, { recursive: true });
  if (program !== undefined) mkdirSync(p.programState(program), { recursive: true });
};
