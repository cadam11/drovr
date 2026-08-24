import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'tech.propra.drovr';
/** A second, independent launchd agent: same file, different label, so a bootout of
 * one never touches the other and each fails or reloads on its own. */
export const SNAPSHOT_LABEL = 'tech.propra.drovr.snapshot';

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

/** The two agents drovr installs. Only the tick interval is operator-configurable
 * (`drovr service install [seconds]`); the snapshot cadence is fixed — it is not a
 * decision loop, just a cheap poll-and-publish, and CADENCE in panel.ts already
 * backs it off to 5m on its own once no cycle is in flight. */
export const AGENTS: { label: string; command: string; intervalSeconds: number }[] = [
  { label: LABEL, command: 'tick', intervalSeconds: 600 },
  { label: SNAPSHOT_LABEL, command: 'snapshot', intervalSeconds: 20 },
];

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

export const snapshotServiceState = (): ServiceState => serviceStateFor(SNAPSHOT_LABEL);

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

/**
 * Writes and reloads both agents' plists in one call, so `service install` can
 * never end up with one agent updated and the other left on a stale definition.
 * The tick interval is the only operator-configurable one; see AGENTS' comment.
 */
export const installAgents = (input: {
  tickIntervalSeconds: number;
  nodeBin: string;
  cliPath: string;
  logDir: string;
  path: string;
}): { label: string; outcome: 'reloaded' | 'loaded' | 'failed' }[] =>
  AGENTS.map((agent) => {
    const intervalSeconds = agent.label === LABEL ? input.tickIntervalSeconds : agent.intervalSeconds;
    const target = plistPathFor(agent.label);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      plist({
        label: agent.label, command: agent.command, intervalSeconds,
        nodeBin: input.nodeBin, cliPath: input.cliPath, logDir: input.logDir, path: input.path,
      }),
      'utf8',
    );
    return { label: agent.label, outcome: reloadAgent(agent.label) };
  });

/**
 * Every branch says what is wrong and the exact command that fixes it. Referring to
 * a command some earlier invocation printed is useless to a reader who did not see it.
 */
export const describeService = (
  state: ServiceState,
  lastTickAt: number | null,
  now: number,
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
    return `loaded${every}, but no tick has recorded a decision yet${failed}`;
  }

  const minutes = Math.round((now - lastTickAt) / 60_000);
  const ago = minutes < 60 ? `${minutes} minutes ago` : `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
  const stalled =
    state.intervalSeconds !== null && now - lastTickAt > state.intervalSeconds * 3000
      ? ` — that is overdue for a ${state.intervalSeconds}s interval, so the agent may be stalled`
      : '';
  return `loaded${every}. Last tick recorded a decision ${ago}${stalled}${failed}`;
};

/**
 * describeService's counterpart for the snapshot agent. Not shared with it: the
 * vocabulary (tick/decision vs publish) differs enough on every branch that a
 * shared helper would need as many parameters as this function has lines.
 */
export const describeSnapshotAgent = (
  state: ServiceState,
  lastPublishedAt: number | null,
  now: number,
): string => {
  if (!state.installed) {
    return 'no launchd agent has been written, so nothing publishes on a schedule. Fix: drovr service install';
  }
  if (!state.loaded) {
    return `the launchd agent file exists but launchd has not loaded it, so it will never publish. Fix: ${bootstrapCommand(SNAPSHOT_LABEL)}`;
  }

  const every = state.intervalSeconds === null ? '' : ` and fires every ${state.intervalSeconds}s`;
  const exitCode =
    state.lastExitStatus === null || state.lastExitStatus < 256
      ? state.lastExitStatus
      : state.lastExitStatus >> 8;
  const failed =
    exitCode !== null && exitCode !== 0
      ? `. Warning: the last run failed (exit ${exitCode}) — check ${join(homedir(), '.drovr/logs/snapshot.err')}`
      : '';

  if (lastPublishedAt === null) {
    return `loaded${every}, but nothing has published yet${failed}`;
  }

  const minutes = Math.round((now - lastPublishedAt) / 60_000);
  const ago = minutes < 60 ? `${minutes} minutes ago` : `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
  const stalled =
    state.intervalSeconds !== null && now - lastPublishedAt > state.intervalSeconds * 3000
      ? ` — that is overdue for a ${state.intervalSeconds}s interval, so the agent may be stalled`
      : '';
  return `loaded${every}. Last published ${ago}${stalled}${failed}`;
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
