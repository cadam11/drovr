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
    /** Every invocation, including a skip or a failure — distinct from snapshotState's
     * `publishedAt`, which only advances on an actual publish (see publish-snapshot.ts). */
    snapshotRun: join(base, 'snapshot-run.json'),
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
    statusPage: (program: string) => join(base, 'programs', program, 'status.html'),
  };
};

export const ensureDirs = (program?: string): void => {
  const p = paths();
  mkdirSync(p.logs, { recursive: true });
  if (program !== undefined) mkdirSync(p.programState(program), { recursive: true });
};
