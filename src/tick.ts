import { writeFileSync } from 'node:fs';
import { appendRecord, readCycles, snapshot, type CycleRecord } from './ledger.ts';
import { decide, type Decision } from './decide.ts';
import { isOnboarding, readReport, runCycle } from './cycle.ts';
import { poolFrom } from './capacity.ts';
import { ceilingsFor, readControl, type Control, type Program } from './control.ts';
import { acquire, release } from './lock.ts';
import { ensureDirs, paths } from './paths.ts';
import { readStatus } from './teamclaude.ts';
import { renderStatus } from './render.ts';
import { publishStatus } from './publish.ts';

const logDecision = (program: string, decision: Decision, now: number): void => {
  appendRecord(paths().decisions, {
    v: 1,
    at: new Date(now).toISOString(),
    program,
    verdict: decision.verdict,
    reason: decision.reason,
    pool: decision.pool === null ? null : snapshot(decision.pool),
    cyclesFundable: decision.cyclesFundable,
  });
};

const writeStatusPage = async (program: Program, decision: Decision, cycles: CycleRecord[], now: number, note?: string): Promise<void> => {
  ensureDirs(program.name);
  const html = renderStatus({
    program: program.name,
    decision,
    recent: cycles.slice(-10).reverse(),
    renderedAt: now,
    ...(note === undefined ? {} : { note }),
  });
  const file = paths().statusPage(program.name);
  writeFileSync(file, html, 'utf8');
  await publishStatus(program, file);
};

/** One cycle, start to finish. The ledger is written before the spawn so a hard kill still leaves a record. */
const executeCycle = async (program: Program, control: Control, before: CycleRecord['poolBefore']): Promise<void> => {
  const startedAt = new Date().toISOString();
  const kind = isOnboarding(program.name) ? 'onboarding' : 'delivery';

  appendRecord(paths().cycles, {
    v: 1,
    kind,
    program: program.name,
    startedAt,
    endedAt: null,
    exit: 'running',
    poolBefore: before,
    poolAfter: null,
    startupTokens: null,
    yield: null,
    asksRaised: 0,
  });

  const code = await runCycle(program, startedAt);
  const report = readReport(program.name);
  const status = await readStatus();
  const ceilings = ceilingsFor(control);
  const after = ceilings === null ? null : snapshot(poolFrom(status, ceilings, Date.now()));

  appendRecord(paths().cycles, {
    v: 1,
    kind,
    program: program.name,
    startedAt,
    endedAt: new Date().toISOString(),
    exit: report?.exit ?? 'crash',
    poolBefore: before,
    poolAfter: after,
    startupTokens: report?.startupTokens ?? null,
    yield: report?.yield ?? null,
    asksRaised: report?.asksRaised ?? 0,
  });

  if (report === null) {
    console.error(`cycle for ${program.name} exited ${code} without a report — recorded as crash`);
  }
};

export const tick = async (): Promise<void> => {
  const p = paths();
  ensureDirs();
  if (!acquire(p.lock)) {
    console.log('another tick holds the lock — a cycle is in flight');
    return;
  }

  try {
    const control = readControl(p.control);
    const status = await readStatus();
    const cycles = readCycles(p.cycles);
    const now = Date.now();

    for (const program of control.programs.filter((candidate) => candidate.enabled)) {
      const scoped = cycles.filter((cycle) => cycle.program === program.name);
      const decision = decide({ status, control, cycles: scoped, now });
      logDecision(program.name, decision, now);
      console.log(`${program.name}: ${decision.verdict} — ${decision.reason}`);

      if (decision.verdict !== 'GO' || decision.pool === null) {
        await writeStatusPage(program, decision, scoped, now);
        continue;
      }

      await executeCycle(program, control, snapshot(decision.pool));
      const refreshed = readCycles(p.cycles).filter((cycle) => cycle.program === program.name);
      const last = refreshed.at(-1);
      await writeStatusPage(
        program,
        decision,
        refreshed,
        Date.now(),
        last?.exit === 'crash' ? 'Last cycle ended without a report — treated as a crash.' : undefined,
      );
    }
  } finally {
    release(p.lock);
  }
};
