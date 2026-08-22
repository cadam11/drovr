import { allocationFor, type Allocation, type BucketName } from './allocation.ts';
import { poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, effectivePriority, readControl, type Control } from './control.ts';
import { decide, type Decision } from './decide.ts';
import { estimateCycleCost, inFlight, readCycles, spentSince, type CycleRecord } from './ledger.ts';
import { hoursToWeeklyReset } from './capacity.ts';
import { holder } from './lock.ts';
import { paths } from './paths.ts';
import { readStatus } from './teamclaude.ts';

const ESC = '\x1b[';
const dim = (text: string): string => `${ESC}2m${text}${ESC}0m`;
const bold = (text: string): string => `${ESC}1m${text}${ESC}0m`;
const paint = (code: number, text: string): string => `${ESC}${code}m${text}${ESC}0m`;

const VERDICT_COLOUR: Record<string, number> = { GO: 32, WAIT: 33, STOP: 31, RUN: 36 };

/** Segment order matches the stack: yours-spent, programs-spent, in-flight, free, held. */
const SEGMENTS: { key: keyof Allocation; char: string; colour: number; label: string }[] = [
  { key: 'yoursSpent', char: '▓', colour: 35, label: 'you spent' },
  { key: 'programsSpent', char: '█', colour: 32, label: 'programs spent' },
  { key: 'programsReserved', char: '▒', colour: 36, label: 'in flight' },
  { key: 'programsAvailable', char: '░', colour: 90, label: 'free to programs' },
  { key: 'yoursReserved', char: '·', colour: 35, label: 'held for you' },
];

/** Largest-remainder allocation so the bar is always exactly `width` cells. */
const barCells = (allocation: Allocation, width: number): number[] => {
  const shares = SEGMENTS.map((segment) => (allocation[segment.key] as number) / allocation.total);
  const exact = shares.map((share) => share * width);
  const floors = exact.map(Math.floor);
  const deficit = width - floors.reduce((total, value) => total + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
    .slice(0, Math.max(0, deficit))
    .map((entry) => entry.index);
  return floors.map((value, index) => value + (order.includes(index) ? 1 : 0));
};

const bar = (allocation: Allocation, width: number): string =>
  barCells(allocation, width)
    .map((cells, index) => paint(SEGMENTS[index]!.colour, SEGMENTS[index]!.char.repeat(cells)))
    .join('');

const asPercent = (value: number, total: number): string =>
  `${((value / total) * 100).toFixed(0)}%`.padStart(4);

const legend = (): string =>
  SEGMENTS.map((segment) => `${paint(segment.colour, segment.char)} ${dim(segment.label)}`).join('  ');

const elapsed = (since: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
};

const programLine = (input: {
  name: string;
  priority: number;
  decision: Decision;
  running: CycleRecord | undefined;
  pid: number | null;
  now: number;
  nameWidth: number;
}): string => {
  const { name, priority, decision, running, pid, now, nameWidth } = input;
  const verdict = running === undefined ? decision.verdict : 'RUN';
  const badge = paint(VERDICT_COLOUR[verdict] ?? 37, verdict.padEnd(4));
  const detail =
    running === undefined
      ? decision.reason
      : `pid ${pid ?? '?'} · ${elapsed(running.startedAt, now)} · ${running.kind}`;
  return `  ${dim(`[p${priority}]`.padEnd(6))}${name.padEnd(nameWidth)} ${badge}  ${dim(detail)}`;
};

const ledgerLine = (cycle: CycleRecord, nameWidth: number): string => {
  const produced = cycle.yield;
  const total = produced === null ? '—' : produced.ticketsMoved + produced.prsOpened + produced.commits;
  return dim(
    `  ${cycle.startedAt.slice(5, 16).replace('T', ' ')}  ${cycle.program.padEnd(nameWidth)} ` +
      `${cycle.kind.padEnd(10)} ${cycle.exit.padEnd(9)} yield=${String(total).padEnd(4)} asks=${cycle.asksRaised}`,
  );
};

const BUCKETS: { name: BucketName; label: string; ceiling: (control: Control) => 'weekly' | 'session' }[] = [
  { name: 'fable', label: 'fable   7d', ceiling: () => 'weekly' },
  { name: 'general', label: 'general 7d', ceiling: () => 'weekly' },
  { name: 'session', label: 'session 5h', ceiling: () => 'session' },
];

const frame = async (): Promise<string> => {
  const p = paths();
  const control = readControl(p.control);
  const status = await readStatus();
  const cycles = readCycles(p.cycles);
  const now = Date.now();
  const width = Math.max(40, Math.min(process.stdout.columns ?? 100, 120));
  const barWidth = width - 28;

  const lines: string[] = [];
  const paused = control.pauseUntil === null ? '' : ` · paused until ${control.pauseUntil.slice(11, 16)}`;
  lines.push(
    `${bold('drovr')}  ${dim(`mode ${control.mode}${paused} · ${new Date(now).toTimeString().slice(0, 8)}`)}`,
  );

  const ceilings = ceilingsFor(control);
  if (ceilings === null) {
    lines.push('', paint(31, '  mode is off — no cycles will start'), '');
  } else {
    const pool = poolFrom(status, ceilings, now);
    const cost = estimateCycleCost(cycles, control.seedCycleCost);
    const running = inFlight(cycles);
    const hoursLeft = hoursToWeeklyReset(status, now);
    const windowStart = hoursLeft === null ? now : now - (168 - hoursLeft) * 3_600_000;
    const spent = spentSince(cycles, windowStart);

    lines.push('', `  ${bold('ALLOCATION')}  ${dim(`${pool.usableAccounts} accounts`)}`, `  ${legend()}`, '');
    for (const bucket of BUCKETS) {
      const allocation = allocationFor({
        status,
        pool,
        bucket: bucket.name,
        spentByPrograms: spent[bucket.name],
        runningCycles: running.length,
        cycleCost: cost,
        now,
      });
      lines.push(
        `  ${bucket.label.padEnd(11)}${bar(allocation, barWidth)} ` +
          `${dim(`you ${asPercent(allocation.yoursSpent + allocation.yoursReserved, allocation.total)}`)}`,
      );
    }

    const resetIn = hoursLeft === null ? '—' : `${Math.floor(hoursLeft)}h`;
    lines.push(
      '',
      dim(
        `  cycle cost ≈ fable ${cost.fable.toFixed(3)} · general ${cost.general.toFixed(3)} · ` +
          `session ${cost.session.toFixed(3)}   weekly resets in ${resetIn}`,
      ),
    );
  }

  const programs = byPriority(control.programs, now, control.deadlineHorizonDays);
  const nameWidth = Math.max(8, ...programs.map((program) => program.name.length));
  const running = inFlight(cycles);

  lines.push('', `  ${bold('PROGRAMS')}  ${dim(`${running.length}/${control.maxConcurrentCycles} in flight`)}`);
  const projected: CycleRecord[] = [];
  for (const program of programs) {
    const live = running.find((cycle) => cycle.program === program.name);
    const decision = decide({
      status,
      control,
      cycles: [...cycles, ...projected],
      program: program.name,
      now,
    });
    lines.push(
      programLine({
        name: program.name,
        priority: effectivePriority(program, now, control.deadlineHorizonDays),
        decision,
        running: live,
        pid: holder(p.programLock(program.name)),
        now,
        nameWidth,
      }),
    );
    if (decision.verdict === 'GO' && program.enabled && live === undefined) {
      projected.push({ ...PLACEHOLDER, program: program.name, startedAt: new Date(now).toISOString() });
    }
  }

  const recent = cycles.filter((cycle) => cycle.endedAt !== null).slice(-6).reverse();
  if (recent.length > 0) {
    lines.push('', `  ${bold('RECENT')}`);
    lines.push(...recent.map((cycle) => ledgerLine(cycle, nameWidth)));
  }

  lines.push('', dim('  ctrl-c to exit'));
  return lines.join('\n');
};

const PLACEHOLDER: CycleRecord = {
  v: 1,
  kind: 'delivery',
  program: '',
  startedAt: '',
  endedAt: null,
  exit: 'running',
  poolBefore: { fable: 0, general: 0, session: 0 },
  poolAfter: null,
  startupTokens: null,
  yield: null,
  asksRaised: 0,
};

/** Runs until interrupted; the terminal is restored on every exit path. */
export const watch = async (intervalSeconds: number): Promise<void> => {
  const restore = (): void => {
    process.stdout.write(`${ESC}?25h`);
  };
  process.stdout.write(`${ESC}?25l`);
  process.on('SIGINT', () => {
    restore();
    process.stdout.write('\n');
    process.exit(0);
  });
  process.on('uncaughtException', (error: unknown) => {
    restore();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  const draw = async (): Promise<void> => {
    const rendered = await frame();
    process.stdout.write(`${ESC}2J${ESC}H${rendered}\n`);
  };

  await draw();
  // The interval itself keeps the event loop alive; unref-ing it would exit at once.
  setInterval(() => {
    draw().catch((error: unknown) => {
      restore();
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }, Math.max(2, intervalSeconds) * 1000);
};
