import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatusPayload, type Evaluation, type StatusPayload } from '../src/status-payload.ts';
import { decide, cyclesFundableFrom } from '../src/decide.ts';
import { poolFrom } from '../src/capacity.ts';
import { byPriority, ceilingsFor } from '../src/control.ts';
import { chargeForRunning, estimateCycleCost, inFlight, snapshot, type CycleRecord } from '../src/ledger.ts';
import { account, control, healthy, HOUR, NOW, status } from './fixtures.ts';

const service = {
  state: { installed: true, loaded: true, pid: null, lastExitStatus: 0, intervalSeconds: 600 },
  lastTickAt: NOW - 60_000,
  lockHolder: null,
};

const twoPrograms = () =>
  control({ programs: [{ name: 'demo', cwd: '/tmp/demo' }, { name: 'off', cwd: '/tmp/off', enabled: false }] });

/** The same evaluation order the CLI and the tick use: priority order, every program, no I/O. */
const evaluate = (input: { control: ReturnType<typeof control>; status: ReturnType<typeof healthy>; cycles: CycleRecord[] }): Evaluation[] =>
  byPriority(input.control.programs, NOW, input.control.deadlineHorizonDays).map((program) => ({
    program,
    decision: decide({ status: input.status, control: input.control, cycles: input.cycles, program: program.name, now: NOW }),
    pid: null,
  }));

const build = (overrides: Partial<Parameters<typeof buildStatusPayload>[0]> = {}): StatusPayload => {
  const base = { control: twoPrograms(), storedMode: 'normal' as const, status: healthy(), cycles: [] as CycleRecord[], now: NOW, service };
  const merged = { ...base, ...overrides };
  return buildStatusPayload({ ...merged, evaluations: evaluate(merged) });
};

test('the payload stamps generatedAt as ISO and carries the tick interval', () => {
  const payload = build();
  assert.equal(payload.generatedAt, new Date(NOW).toISOString());
  assert.equal(payload.service.intervalSeconds, 600);
  assert.equal(payload.service.lastTickAt, new Date(NOW - 60_000).toISOString());
});

test('allocation has the five TUI segments per bucket, summing to the total, with units', () => {
  const payload = build();
  assert.notEqual(payload.allocation, null);
  if (payload.allocation === null) return;
  // Hoisted: assert.ok is an assertion function, and narrowing a property inside the loop trips TS7022.
  const allocation = payload.allocation;
  for (const bucket of ['fable', 'general', 'session'] as const) {
    const a = allocation[bucket];
    const sum = a.yoursSpent + a.programsSpent + a.programsReserved + a.programsAvailable + a.yoursReserved;
    assert.ok(Math.abs(sum - a.total) < 0.01, `${bucket}: ${sum} != ${a.total}`);
    assert.equal(a.bucket, bucket);
  }
  assert.match(allocation.units, /account-units/);
});

test('capacityNote is the pool context once, and equals every program poolNote', () => {
  const payload = build();
  assert.notEqual(payload.capacityNote, null);
  assert.match(payload.capacityNote ?? '', /is tightest, more room in/);
  for (const program of payload.programs.filter((entry) => entry.poolNote !== null)) {
    assert.equal(program.poolNote, payload.capacityNote);
  }
});

test('cyclesFundable charges an in-flight cycle by observed drain, as decide() does', () => {
  const ctl = twoPrograms();
  const drained = status([
    account({ name: 'a', fable: 0.4, general: 0.4, session: 0.1 }),
    account({ name: 'b', fable: 0.1, general: 0.1, session: 0.0 }),
  ]);
  const running: CycleRecord = {
    v: 1, kind: 'delivery', program: 'demo', startedAt: new Date(NOW - 2 * HOUR).toISOString(), endedAt: null,
    exit: 'running', poolBefore: { fable: 1.9, general: 1.9, session: 1.9 }, poolAfter: null,
    startupTokens: null, yield: null, asksRaised: 0, pauseUntil: null, sessionId: null, closing: null,
  };
  const payload = build({ control: ctl, status: drained, cycles: [running] });
  const ceilings = ceilingsFor(ctl);
  assert.notEqual(ceilings, null);
  if (ceilings === null) return;
  const pool = poolFrom(drained, ceilings, NOW);
  const cost = estimateCycleCost([running], ctl.seedCycleCost);
  const flight = inFlight([running], NOW, ctl.maxCycleHours);
  const expected = cyclesFundableFrom(pool, cost, chargeForRunning(flight, snapshot(pool), cost)).cycles;
  assert.equal(payload.capacity?.cyclesFundable, Math.round(expected * 10_000) / 10_000);
  assert.equal(payload.inFlight.length, 1);
  assert.equal(payload.inFlight[0]?.program, 'demo');
});

test('every program is listed in priority order; a disabled one is STOP with the disabled reason', () => {
  const payload = build();
  assert.deepEqual(payload.programs.map((entry) => entry.name), ['demo', 'off']);
  const off = payload.programs[1];
  assert.equal(off?.enabled, false);
  assert.equal(off?.verdict, 'STOP');
  assert.match(off?.reason ?? '', /disabled/);
  assert.equal(off?.verdictMeaning, 'needs a human: mode is off, or this program produced no yield for several cycles');
});

test('mode off carries null pool, capacity, allocation and capacityNote', () => {
  const payload = build({ control: control({ mode: 'off', programs: [{ name: 'demo', cwd: '/tmp/demo' }] }) });
  assert.equal(payload.pool, null);
  assert.equal(payload.capacity, null);
  assert.equal(payload.allocation, null);
  assert.equal(payload.capacityNote, null);
  assert.equal(payload.modeMeaning, 'no cycles will start');
});

test('a six-program payload is a small fraction of the 64 KB the Lambda accepts', () => {
  const six = control({ programs: Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, cwd: `/tmp/p${i}` })) });
  const text = JSON.stringify(build({ control: six }));
  assert.ok(text.length < 16_384, `${text.length} bytes`);
});

test('a mode the phone switched to away is named as such, with the stored mode', () => {
  const away = control({ mode: 'away', programs: [{ name: 'demo', cwd: '/tmp/demo' }] });
  const payload = build({ control: away, storedMode: 'normal' });
  assert.equal(payload.modeFromPhone, true);
  assert.match(payload.modeMeaning, /away is the phone's toggle for this pass, the stored mode is normal/);
  assert.equal(build().modeFromPhone, false);
});
