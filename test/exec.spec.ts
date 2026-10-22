import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecTimedOut, explainSpawn, runBounded } from '../src/exec.ts';

/**
 * A real subprocess, not a mock: the property under test is that `execFile`'s timeout is
 * actually being passed and actually kills the child. Asserting that against a fake would
 * assert nothing — the defect being guarded here was a missing option, which every mock
 * in the world would have happily accepted.
 */
test('runBounded kills a child that outlives its ceiling', async () => {
  const started = Date.now();
  await assert.rejects(
    () => runBounded('sleep', ['30'], { timeoutMs: 300 }),
    (error: unknown) => {
      assert.ok(error instanceof ExecTimedOut, `expected ExecTimedOut, got ${String(error)}`);
      assert.match((error as Error).message, /sleep 30 did not return within 0s and was killed/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, 'it returned on the ceiling, not on the sleep');
});

test('runBounded returns stdout for a child that finishes in time', async () => {
  const { stdout } = await runBounded('printf', ['%s', 'hello'], { timeoutMs: 5_000 });
  assert.equal(stdout, 'hello');
});

test('runBounded names the command in a timeout, or the label when given one', async () => {
  await assert.rejects(
    () => runBounded('sleep', ['30'], { timeoutMs: 200, label: 'teamclaude status --json' }),
    /teamclaude status --json did not return within/,
  );
});

/**
 * A missing binary must stay distinguishable from a hung one: they have completely
 * different fixes, and under launchd the ENOENT case is the common one.
 */
test('runBounded reports a missing binary as a PATH problem, not a timeout', async () => {
  await assert.rejects(
    () => runBounded('drovr-no-such-binary', [], { timeoutMs: 5_000 }),
    (error: unknown) => {
      assert.ok(!(error instanceof ExecTimedOut));
      assert.match((error as Error).message, /is not on PATH/);
      return true;
    },
  );
});

/**
 * Callers lift a reason out of the child's own stdout (aice prints its error there), so a
 * non-ENOENT failure has to come back as the original error object rather than a new one.
 */
test('runBounded preserves the child stdout on an ordinary non-zero exit', async () => {
  await assert.rejects(
    () => runBounded('sh', ['-c', 'printf %s "the reason"; exit 3'], { timeoutMs: 5_000 }),
    (error: unknown) => {
      assert.equal((error as { stdout?: string }).stdout, 'the reason');
      assert.equal((error as { code?: number }).code, 3);
      return true;
    },
  );
});

test('explainSpawn passes a non-ENOENT error through unchanged', () => {
  const original = new Error('something else');
  assert.equal(explainSpawn('orca', original), original);
});
