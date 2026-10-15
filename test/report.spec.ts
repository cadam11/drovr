import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReportArgs, readReport, reportFromPoll, reportSource, writeReport } from '../src/cycle.ts';
import { parseControl } from '../src/control.ts';
import { paths } from '../src/paths.ts';

/** The local source for a program with no host: today's file under DROVR_HOME. */
const alpha = () => reportSource(parseControl({ programs: [{ name: 'alpha', cwd: '/x' }] }).programs[0]!);

const NOW = Date.parse('2026-08-28T12:00:00Z');

/** Real files under a throwaway DROVR_HOME, same policy as keys.spec.ts. */
const freshHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'drovr-report-'));
  process.env.DROVR_HOME = dir;
  return dir;
};

test('parseReportArgs builds a full report from flags', () => {
  const { program, report } = parseReportArgs([
    'sunnyt', '--exit', 'seam', '--startup-tokens', '14000',
    '--tickets-moved', '2', '--prs-opened', '1', '--commits', '6', '--asks-raised', '1',
  ], NOW);
  assert.equal(program, 'sunnyt');
  assert.deepEqual(report, {
    exit: 'seam',
    startupTokens: 14000,
    yield: { ticketsMoved: 2, prsOpened: 1, commits: 6 },
    asksRaised: 1,
    pauseUntil: null,
    cadence: null,
  });
});

test('no yield flags means yield unknown, not zero', () => {
  const { report } = parseReportArgs(['sunnyt', '--exit', 'context'], NOW);
  assert.deepEqual(report, {
    exit: 'context', startupTokens: null, yield: null, asksRaised: 0, pauseUntil: null, cadence: null,
  });
});

test('one yield flag defaults the other two to zero', () => {
  const { report } = parseReportArgs(['sunnyt', '--exit', 'seam', '--commits', '3'], NOW);
  assert.deepEqual(
    (report as { yield: unknown }).yield,
    { ticketsMoved: 0, prsOpened: 0, commits: 3 },
  );
});

test('a missing program or --exit is refused with usage', () => {
  assert.throws(() => parseReportArgs([], NOW), /usage: drovr report/);
  assert.throws(() => parseReportArgs(['--exit', 'seam'], NOW), /usage: drovr report/);
  assert.throws(() => parseReportArgs(['sunnyt'], NOW), /--exit is required/);
});

test('an unknown flag is refused, never silently dropped', () => {
  // A typo that skipped a field would defeat the reason the command exists.
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--startup_tokens', '14000'], NOW),
    /unknown flag --startup_tokens/,
  );
});

test('a non-numeric value is refused naming its flag', () => {
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--commits', 'lots'], NOW),
    /--commits needs a number, got "lots"/,
  );
});

test('writeReport round-trips through readReport', async () => {
  freshHome();
  const written = writeReport('alpha', {
    exit: 'seam',
    startupTokens: 9000,
    yield: { ticketsMoved: 1, prsOpened: 0, commits: 4 },
    asksRaised: 0,
  });
  assert.deepEqual(await readReport(alpha()), written);
});

test('writeReport refuses an invalid report before anything touches disk', () => {
  freshHome();
  assert.throws(() => writeReport('alpha', { exit: 'done' }), /not a valid cycle report/);
  assert.equal(existsSync(paths().lastCycle('alpha')), false);
});

test('writeReport leaves no staging file behind', () => {
  freshHome();
  writeReport('alpha', { exit: 'context' });
  assert.deepEqual(readdirSync(paths().programState('alpha')), ['last-cycle.json']);
});

test('a poll reads a torn file as not-yet, readReport as an error', async () => {
  freshHome();
  writeReport('alpha', { exit: 'seam' });
  // What a poll sees when it catches a direct writer mid-write.
  writeFileSync(paths().lastCycle('alpha'), '{ "exit": "seam", "startupTo', 'utf8');
  const source = alpha();
  assert.equal(reportFromPoll(await source.read(), source.label), null);
  await assert.rejects(readReport(source), SyntaxError);
});

test('a poll still throws on a complete report with the wrong shape', async () => {
  freshHome();
  writeReport('alpha', { exit: 'seam' });
  // Complete, parseable, and in breach of the contract — not a torn write.
  writeFileSync(paths().lastCycle('alpha'), '{ "exit": "finished" }\n', 'utf8');
  const source = alpha();
  assert.throws(() => reportFromPoll('{ "exit": "finished" }', source.label), /not a valid cycle report/);
});

test('the local source reads an absent report as null and clears one that exists', async () => {
  freshHome();
  const source = alpha();
  assert.equal(await source.read(), null);
  writeReport('alpha', { exit: 'seam' });
  await source.clear();
  assert.equal(existsSync(paths().lastCycle('alpha')), false);
});

test('--pause-until takes a duration or an ISO date, bounded and future-only', () => {
  const asDuration = parseReportArgs(['sunnyt', '--exit', 'seam', '--pause-until', '48h'], NOW);
  assert.equal(
    (asDuration.report as { pauseUntil: string }).pauseUntil,
    new Date(NOW + 48 * 3_600_000).toISOString(),
  );
  const asDate = parseReportArgs(
    ['sunnyt', '--exit', 'seam', '--pause-until', '2026-08-30T09:00:00Z'], NOW,
  );
  assert.equal(
    (asDate.report as { pauseUntil: string }).pauseUntil,
    new Date(Date.parse('2026-08-30T09:00:00Z')).toISOString(),
  );
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--pause-until', '2026-08-01'], NOW),
    /already in the past/,
  );
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--pause-until', '90d'], NOW),
    /more than 35 days/,
  );
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--pause-until', 'whenever'], NOW),
    /needs a duration .* or an ISO date/,
  );
});

test('--cadence is shape-checked and bounded', () => {
  const { report } = parseReportArgs(['sunnyt', '--exit', 'seam', '--cadence', '7d'], NOW);
  assert.equal((report as { cadence: string }).cadence, '7d');
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--cadence', 'weekly'], NOW),
    /--cadence must look like/,
  );
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--cadence', '60d'], NOW),
    /longer than 35 days/,
  );
});
