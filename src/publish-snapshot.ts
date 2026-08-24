import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { readControl } from './control.ts';
import { explainSpawn } from './exec.ts';
import { inFlight, readCycles } from './ledger.ts';
import { payload, payloadHash, shouldPublish } from './panel.ts';
import { paths } from './paths.ts';
import { collectState } from './state.ts';

const run = promisify(execFile);

/** aice rejects any JSON outside assets/, and only 0.16.0+ knows --ttl. */
const DATA_PATH = 'assets/snapshot.json';
const AICE_FLOOR = [0, 16, 0];
const DROVR_REPO = '/Users/cadam/code/drovr';

export const publishArgs = (file: string): string[] => [
  'exec', DROVR_REPO,
  'aice', 'publish', file,
  '--as', DATA_PATH,
  '--ttl', '1d',
  '--force',
  '--agent', 'drovr',
];

/** Plain top-to-bottom comparison — no cleverness to decode on the next read. */
const behind = (found: number[], floor: number[]): boolean => {
  for (let index = 0; index < floor.length; index += 1) {
    if (found[index]! !== floor[index]!) return found[index]! < floor[index]!;
  }
  return false;
};

export const assertAiceVersion = (reported: string): void => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(reported);
  if (match === null) throw new Error(`could not read the aice version from "${reported.trim()}"`);
  const found = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!behind(found, AICE_FLOOR)) return;
  throw new Error(
    `aice ${found.join('.')} has no --ttl; drovr needs >= ${AICE_FLOOR.join('.')}. Run: aice update`,
  );
};

type Marker = { hash: string; publishedAt: number };

const readMarker = (path: string): Marker | null => {
  try {
    const parsed: Marker = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.hash === 'string' && typeof parsed.publishedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
};

const writeMarker = (path: string, marker: Marker): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker)}\n`, 'utf8');
};

const aiceVersion = async (): Promise<string> => {
  const { stdout } = await run('aice', ['version']).catch((error: unknown) => {
    throw explainSpawn('aice', error);
  });
  return stdout;
};

const publishToAice = async (file: string): Promise<void> => {
  await run('direnv', publishArgs(file), { cwd: DROVR_REPO }).catch((error: unknown) => {
    throw explainSpawn('direnv', error);
  });
};

/**
 * The whole publish, allowed to throw. Split from `publishSnapshot` so the outer
 * function's only job is deciding what a failure means for the caller, not doing
 * the I/O itself.
 */
const attemptPublish = async (): Promise<'published' | 'skipped'> => {
  assertAiceVersion(await aiceVersion());

  const p = paths();
  // Preview-read failures inside collectState are surfaced here, not dropped: this
  // runs unattended from launchd, where console.error is the only place a
  // diagnostic can land (see state.ts:collectState's onWarning contract).
  const state = await collectState(undefined, console.error);
  const json = payload(state);
  const nextHash = payloadHash(json);
  const marker = readMarker(p.snapshotState);
  // control.maxCycleHours, not inFlight's own 24h default — otherwise this could
  // disagree with decide() and buildState about which cycles are still running.
  const maxCycleHours = readControl(p.control).maxCycleHours;
  const cycleRunning = inFlight(readCycles(p.cycles), Date.now(), maxCycleHours).length > 0;

  const go = shouldPublish({
    previousHash: marker?.hash ?? null,
    nextHash,
    cycleRunning,
    lastPublishedAt: marker?.publishedAt ?? null,
    now: Date.now(),
  });
  if (!go) return 'skipped';

  const file = join(p.base, 'snapshot.json');
  writeFileSync(file, json, 'utf8');
  await publishToAice(file);
  writeMarker(p.snapshotState, { hash: nextHash, publishedAt: Date.now() });
  return 'published';
};

/**
 * Fails soft on every path: a panel that stops updating must never stop a cycle
 * from starting. The 1d ttl turns a prolonged outage into a 404, which the page
 * reports honestly, rather than a convincing dead frame.
 *
 * Never throws — but 'failed' is distinct from 'skipped' so a caller can tell
 * "nothing changed" from "publishing is broken": a launchd tick can ignore either
 * and carry on, while `drovr snapshot` invoked directly needs the difference to
 * honour the CLI's own exit-code contract (see help.ts's AGENT_NOTES.exitCodes).
 */
export const publishSnapshot = async (): Promise<'published' | 'skipped' | 'failed'> => {
  try {
    return await attemptPublish();
  } catch (error) {
    console.error(`snapshot publish failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
};
