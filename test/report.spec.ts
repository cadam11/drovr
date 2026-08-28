import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReportArgs, pollReport, readReport, writeReport } from '../src/cycle.ts';
import { paths } from '../src/paths.ts';

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
  ]);
  assert.equal(program, 'sunnyt');
  assert.deepEqual(report, {
    exit: 'seam',
    startupTokens: 14000,
    yield: { ticketsMoved: 2, prsOpened: 1, commits: 6 },
    asksRaised: 1,
  });
});

test('no yield flags means yield unknown, not zero', () => {
  const { report } = parseReportArgs(['sunnyt', '--exit', 'context']);
  assert.deepEqual(report, { exit: 'context', startupTokens: null, yield: null, asksRaised: 0 });
});

test('one yield flag defaults the other two to zero', () => {
  const { report } = parseReportArgs(['sunnyt', '--exit', 'seam', '--commits', '3']);
  assert.deepEqual(
    (report as { yield: unknown }).yield,
    { ticketsMoved: 0, prsOpened: 0, commits: 3 },
  );
});

test('a missing program or --exit is refused with usage', () => {
  assert.throws(() => parseReportArgs([]), /usage: drovr report/);
  assert.throws(() => parseReportArgs(['--exit', 'seam']), /usage: drovr report/);
  assert.throws(() => parseReportArgs(['sunnyt']), /--exit is required/);
});

test('an unknown flag is refused, never silently dropped', () => {
  // A typo that skipped a field would defeat the reason the command exists.
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--startup_tokens', '14000']),
    /unknown flag --startup_tokens/,
  );
});

test('a non-numeric value is refused naming its flag', () => {
  assert.throws(
    () => parseReportArgs(['sunnyt', '--exit', 'seam', '--commits', 'lots']),
    /--commits needs a number, got "lots"/,
  );
});

test('writeReport round-trips through readReport', () => {
  freshHome();
  const written = writeReport('alpha', {
    exit: 'seam',
    startupTokens: 9000,
    yield: { ticketsMoved: 1, prsOpened: 0, commits: 4 },
    asksRaised: 0,
  });
  assert.deepEqual(readReport('alpha'), written);
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

test('pollReport reads a torn file as not-yet, readReport as an error', () => {
  freshHome();
  writeReport('alpha', { exit: 'seam' });
  // What a poll sees when it catches a direct writer mid-write.
  writeFileSync(paths().lastCycle('alpha'), '{ "exit": "seam", "startupTo', 'utf8');
  assert.equal(pollReport('alpha'), null);
  assert.throws(() => readReport('alpha'), SyntaxError);
});

test('pollReport still throws on a complete report with the wrong shape', () => {
  freshHome();
  writeReport('alpha', { exit: 'seam' });
  // Complete, parseable, and in breach of the contract — not a torn write.
  writeFileSync(paths().lastCycle('alpha'), '{ "exit": "finished" }\n', 'utf8');
  assert.throws(() => pollReport('alpha'), /not a valid cycle report/);
});
