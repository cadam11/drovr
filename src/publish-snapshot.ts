import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { explainSpawn, runBounded } from './exec.ts';
import { payload, payloadHash, shouldPublish } from './panel.ts';
import { paths } from './paths.ts';
import { collectState } from './state.ts';


/**
 * The snapshot agent fires every 20 seconds, so it is the highest-frequency spawner in
 * drovr — and it publishes over the network. An unbounded publish here does not wedge the
 * tick (a separate launchd agent) but it does stall the panel behind a call that will
 * never return, which the page reports as a dead Mac.
 */
const VERSION_TIMEOUT_MS = 20_000;
const SNAPSHOT_PUBLISH_TIMEOUT_MS = 60_000;

/** aice rejects any JSON outside assets/, and only 0.16.0+ knows --ttl. */
const DATA_PATH = 'assets/snapshot.json';
const AICE_FLOOR = [0, 16, 0];
/** The panel and its data live on the drovr install, which this repo's own .envrc names. */
export const DROVR_REPO = '/Users/cadam/code/drovr';

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

export type Marker = { hash: string; publishedAt: number };

/** Exported for `drovr service status`, which reports the snapshot agent's own
 * liveness signal (last publish) the same way describeService reports the tick's. */
export const readMarker = (path: string): Marker | null => {
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

export type RunMarker = { lastRunAt: number };

/** Liveness for `drovr service status`: this is "did the agent fire", not "did it
 * publish" — shouldPublish (panel.ts) deliberately skips most invocations, so
 * publishedAt alone reads a healthy agent as stalled (see CLAUDE.md I1). */
export const readRunMarker = (path: string): RunMarker | null => {
  try {
    const parsed: RunMarker = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.lastRunAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
};

const touchRunMarker = (path: string, now: number): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ lastRunAt: now })}\n`, 'utf8');
};

const aiceVersion = async (): Promise<string> => {
  const { stdout } = await runBounded('aice', ['version'], { timeoutMs: VERSION_TIMEOUT_MS }).catch((error: unknown) => {
    throw explainSpawn('aice', error);
  });
  return stdout;
};

const publishToAice = async (file: string): Promise<void> => {
  await runBounded('direnv', publishArgs(file), {
    timeoutMs: SNAPSHOT_PUBLISH_TIMEOUT_MS,
    cwd: DROVR_REPO,
  }).catch((error: unknown) => {
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
  // shouldPublish no longer takes cycleRunning: the heartbeat (panel.ts) now
  // governs liveness regardless of whether a cycle is in flight, and the old
  // fast/slow split by cycleRunning had nowhere to live once quietSeconds was
  // deleted — a rate limit that still branched on it but did nothing with the
  // result would be exactly the dead-but-looks-live pattern that caused C1.
  const go = shouldPublish({
    previousHash: marker?.hash ?? null,
    nextHash,
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
  const runMarkerPath = paths().snapshotRun;
  try {
    const outcome = await attemptPublish();
    touchRunMarker(runMarkerPath, Date.now());
    return outcome;
  } catch (error) {
    console.error(`snapshot publish failed: ${error instanceof Error ? error.message : String(error)}`);
    try {
      touchRunMarker(runMarkerPath, Date.now());
    } catch {
      // Best-effort liveness stamp; the publish failure itself is already reported above.
    }
    return 'failed';
  }
};
