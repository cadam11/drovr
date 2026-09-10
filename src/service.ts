import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'tech.propra.drovr';

export const plistPathFor = (label: string): string =>
  join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

/** Kept for every existing caller that means "the tick agent's plist" by default. */
export const plistPath = (): string => plistPathFor(LABEL);

/**
 * launchd starts with a bare PATH that does not include tool dirs like
 * ~/Library/pnpm, where teamclaude lives. Baking in the installing shell's PATH
 * is what makes teamclaude, herdr, aice and direnv resolvable from a tick.
 */
export const agentPath = (): string => {
  const standard = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const inherited = (process.env.PATH ?? '').split(':').filter((entry) => entry !== '');
  return [...new Set([...inherited, ...standard])].join(':');
};

/** StartInterval, not a long-lived daemon: every firing is a fresh, crash-isolated process. */
export const plist = (input: {
  label: string;
  command: string;
  nodeBin: string;
  cliPath: string;
  intervalSeconds: number;
  logDir: string;
  path: string;
}): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${input.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${input.nodeBin}</string>
    <string>${input.cliPath}</string>
    <string>${input.command}</string>
  </array>
  <key>StartInterval</key><integer>${input.intervalSeconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${join(input.logDir, `${input.command}.log`)}</string>
  <key>StandardErrorPath</key><string>${join(input.logDir, `${input.command}.err`)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${input.path}</string></dict>
</dict>
</plist>
`;

export type ServiceState = {
  /** The plist exists on disk. */
  installed: boolean;
  /** launchd has it loaded and will fire it. */
  loaded: boolean;
  /** Set only while a tick is actually executing; ticks are short, so usually null. */
  pid: number | null;
  lastExitStatus: number | null;
  intervalSeconds: number | null;
};

const launchctlList = (label: string): string | null => {
  try {
    return execFileSync('launchctl', ['list', label], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // A non-zero exit means launchd does not know the label — that is an answer, not a failure.
    return null;
  }
};

const numberFrom = (source: string, key: string): number | null => {
  const match = new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`).exec(source);
  return match === null ? null : Number.parseInt(match[1]!, 10);
};

const intervalFromPlist = (path: string): number | null => {
  if (!existsSync(path)) return null;
  const match = /<key>StartInterval<\/key><integer>(\d+)<\/integer>/.exec(readFileSync(path, 'utf8'));
  return match === null ? null : Number.parseInt(match[1]!, 10);
};

export const serviceStateFor = (label: string): ServiceState => {
  const path = plistPathFor(label);
  const listing = launchctlList(label);
  return {
    installed: existsSync(path),
    loaded: listing !== null,
    pid: listing === null ? null : numberFrom(listing, 'PID'),
    lastExitStatus: listing === null ? null : numberFrom(listing, 'LastExitStatus'),
    intervalSeconds: intervalFromPlist(path),
  };
};

/** Kept for every existing caller that means "the tick agent's state" by default. */
export const serviceState = (): ServiceState => serviceStateFor(LABEL);

/**
 * launchd being loaded only proves it is scheduled. Ticks are short-lived, so the
 * honest liveness signal is when one last actually ran.
 */
export const bootstrapCommand = (label: string = LABEL): string =>
  `launchctl bootstrap gui/$(id -u) ${plistPathFor(label)}`;

export const bootoutCommand = (label: string = LABEL): string =>
  `launchctl bootout gui/$(id -u)/${label}`;

const launchctl = (args: string[]): boolean => {
  try {
    execFileSync('launchctl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
};

/**
 * launchd holds the plist it loaded, not the file on disk, so rewriting the file
 * changes nothing until the agent is booted out and back in. Installing over a
 * loaded agent without reloading looks like it worked and silently keeps running
 * the old definition — which is exactly how a stale PATH survived a fix. Takes an
 * explicit label so the two agents can never be reloaded into each other's slot.
 */
export const reloadAgent = (label: string): 'reloaded' | 'loaded' | 'failed' => {
  const domain = `gui/${process.getuid?.() ?? ''}`;
  const wasLoaded = launchctlList(label) !== null;
  if (wasLoaded) launchctl(['bootout', `${domain}/${label}`]);
  const ok = launchctl(['bootstrap', domain, plistPathFor(label)]);
  if (!ok) return 'failed';
  return wasLoaded ? 'reloaded' : 'loaded';
};

/** Writes the tick plist and reloads it — launchd holds the plist it loaded, not the
 * file on disk, so a rewrite alone changes nothing (see reloadAgent). */
export const installAgent = (input: {
  tickIntervalSeconds: number;
  nodeBin: string;
  cliPath: string;
  logDir: string;
  path: string;
}): 'reloaded' | 'loaded' | 'failed' => {
  const target = plistPathFor(LABEL);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    plist({
      label: LABEL, command: 'tick', intervalSeconds: input.tickIntervalSeconds,
      nodeBin: input.nodeBin, cliPath: input.cliPath, logDir: input.logDir, path: input.path,
    }),
    'utf8',
  );
  return reloadAgent(LABEL);
};

/**
 * Every branch says what is wrong and the exact command that fixes it. Referring to
 * a command some earlier invocation printed is useless to a reader who did not see it.
 */
export const describeService = (
  state: ServiceState,
  lastTickAt: number | null,
  now: number,
  /**
   * The live tick-lock holder, when there is one. Passed in rather than read here so this
   * stays pure and the caller keeps its own I/O — and because "overdue" and "wedged" are
   * different diagnoses with different fixes: an agent launchd never fired needs a
   * bootstrap, a live process holding the lock needs killing. Saying only "may be stalled"
   * makes the reader guess between them.
   */
  lockedBy?: { pid: number; heldMs: number | null } | null,
): string => {
  if (!state.installed) {
    return 'no launchd agent has been written, so nothing runs on a schedule. Fix: drovr service install';
  }
  if (!state.loaded) {
    return `the launchd agent file exists but launchd has not loaded it, so no tick will ever fire. Fix: ${bootstrapCommand()}`;
  }

  const every = state.intervalSeconds === null ? '' : ` and fires every ${state.intervalSeconds}s`;
  // launchd reports the raw wait() status, so a plain exit 1 shows up as 256.
  const exitCode =
    state.lastExitStatus === null || state.lastExitStatus < 256
      ? state.lastExitStatus
      : state.lastExitStatus >> 8;
  const failed =
    exitCode !== null && exitCode !== 0
      ? `. Warning: the last tick failed (exit ${exitCode}) — check ${join(homedir(), '.drovr/logs/tick.err')}`
      : '';

  if (lastTickAt === null) {
    return `loaded${every}, but no tick has completed yet${failed}`;
  }

  const minutes = Math.round((now - lastTickAt) / 60_000);
  const ago = minutes < 60 ? `${minutes} minutes ago` : `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
  const overdue = state.intervalSeconds !== null && now - lastTickAt > state.intervalSeconds * 3000;
  const stalled = overdue
    ? ` — that is overdue for a ${state.intervalSeconds}s interval, so the agent may be stalled`
    : '';
  // Only when it is actually late: a lock held during a healthy pass is the normal state
  // and reporting it would cry wolf on every other invocation.
  const wedged =
    overdue && lockedBy !== undefined && lockedBy !== null
      ? `. A live process still holds the tick lock (pid ${lockedBy.pid}` +
        `${lockedBy.heldMs === null ? '' : `, held ${Math.round(lockedBy.heldMs / 60_000)}m`}), ` +
        `so ticks are being skipped rather than not firing. Fix: kill ${lockedBy.pid}`
      : '';
  return `loaded${every}. Last tick completed ${ago}${stalled}${wedged}${failed}`;
};

/** The same facts as a discriminated value, for a caller that needs to branch rather than read. */
export const serviceHealth = (
  state: ServiceState,
  lastTickAt: number | null,
  now: number,
): 'not-installed' | 'not-loaded' | 'no-ticks-yet' | 'stalled' | 'healthy' => {
  if (!state.installed) return 'not-installed';
  if (!state.loaded) return 'not-loaded';
  if (lastTickAt === null) return 'no-ticks-yet';
  if (state.intervalSeconds !== null && now - lastTickAt > state.intervalSeconds * 3000) {
    return 'stalled';
  }
  return 'healthy';
};
