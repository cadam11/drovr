import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendRecord, inFlight, readCycles, snapshot, type CycleRecord } from './ledger.ts';
import { decide, type Decision } from './decide.ts';
import { isOnboarding, readReport, runCycle } from './cycle.ts';
import { poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, readControl, type Program } from './control.ts';
import { acquire, holder, release } from './lock.ts';
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

const writeStatusPage = async (
  program: Program,
  decision: Decision,
  cycles: CycleRecord[],
  now: number,
  note?: string,
): Promise<void> => {
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

/**
 * Cycles run for hours, so tick must not await them: it hands each admitted
 * program to a detached `drovr run-cycle`, which owns that program's lock and
 * ledger entries. Tick itself returns in seconds so the next launchd firing can
 * evaluate the other programs.
 */
const launch = (program: Program): void => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const child = spawn(process.execPath, [cli, 'run-cycle', program.name], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`${program.name}: launched cycle (pid ${child.pid})`);
};

export const tick = async (): Promise<void> => {
  const p = paths();
  ensureDirs();
  if (!acquire(p.tickLock)) {
    console.log('another tick is still evaluating');
    return;
  }

  try {
    const control = readControl(p.control);
    const status = await readStatus();
    const now = Date.now();

    for (const program of byPriority(control.programs, now, control.deadlineHorizonDays).filter((entry) => entry.enabled)) {
      const cycles = readCycles(p.cycles);
      const decision = decide({ status, control, cycles, program: program.name, now });
      logDecision(program.name, decision, now);
      console.log(`${program.name}: ${decision.verdict} — ${decision.reason}`);

      if (decision.verdict !== 'GO' || decision.pool === null) {
        const mine = cycles.filter((cycle) => cycle.program === program.name);
        await writeStatusPage(program, decision, mine, now);
        continue;
      }
      launch(program);
    }
  } finally {
    release(p.tickLock);
  }
};

/** The detached per-program worker. Holds the program lock for the cycle's whole life. */
export const runProgramCycle = async (name: string): Promise<void> => {
  const p = paths();
  ensureDirs(name);
  const lock = p.programLock(name);
  if (!acquire(lock)) {
    console.error(`a cycle for ${name} is already running (pid ${holder(lock)})`);
    process.exitCode = 1;
    return;
  }

  try {
    const control = readControl(p.control);
    const program = control.programs.find((entry) => entry.name === name);
    if (program === undefined) throw new Error(`no program named "${name}" in ${p.control}`);

    const ceilings = ceilingsFor(control);
    if (ceilings === null) throw new Error('mode is off');

    const startedAt = new Date().toISOString();
    const kind = isOnboarding(name) ? 'onboarding' : 'delivery';
    const before = snapshot(poolFrom(await readStatus(), ceilings, Date.now()));

    const record = (extra: Partial<CycleRecord>): void => {
      appendRecord(p.cycles, {
        v: 1,
        kind,
        program: name,
        startedAt,
        endedAt: null,
        exit: 'running',
        poolBefore: before,
        poolAfter: null,
        startupTokens: null,
        yield: null,
        asksRaised: 0,
        ...extra,
      });
    };

    record({});
    const outcome = await runCycle(program, startedAt, control.maxCycleHours);
    const report = readReport(name);
    const after = snapshot(poolFrom(await readStatus(), ceilings, Date.now()));

    record({
      endedAt: new Date().toISOString(),
      exit: report?.exit ?? 'crash',
      poolAfter: after,
      startupTokens: report?.startupTokens ?? null,
      yield: report?.yield ?? null,
      asksRaised: report?.asksRaised ?? 0,
    });

    if (report === null) {
      console.error(
        `cycle for ${name} produced no report — recorded as crash. ${outcome.detail}`,
      );
      const cycles = readCycles(p.cycles).filter((cycle) => cycle.program === name);
      const decision = decide({
        status: await readStatus(),
        control,
        cycles: readCycles(p.cycles),
        program: name,
        now: Date.now(),
      });
      await writeStatusPage(
        program,
        decision,
        cycles,
        Date.now(),
        'Last cycle ended without a report — treated as a crash.',
      );
    }
  } finally {
    release(lock);
  }
};

export const inFlightCycles = (): CycleRecord[] => inFlight(readCycles(paths().cycles));
