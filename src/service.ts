import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'tech.propra.drovr';

export const plistPath = (): string =>
  join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

/** StartInterval, not a long-lived daemon: every tick is a fresh, crash-isolated process. */
export const plist = (input: { nodeBin: string; cliPath: string; intervalSeconds: number; logDir: string }): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${input.nodeBin}</string>
    <string>${input.cliPath}</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key><integer>${input.intervalSeconds}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${join(input.logDir, 'drovr.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(input.logDir, 'drovr.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
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

const launchctlList = (): string | null => {
  try {
    return execFileSync('launchctl', ['list', LABEL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

export const serviceState = (): ServiceState => {
  const path = plistPath();
  const listing = launchctlList();
  return {
    installed: existsSync(path),
    loaded: listing !== null,
    pid: listing === null ? null : numberFrom(listing, 'PID'),
    lastExitStatus: listing === null ? null : numberFrom(listing, 'LastExitStatus'),
    intervalSeconds: intervalFromPlist(path),
  };
};

/**
 * launchd being loaded only proves it is scheduled. Ticks are short-lived, so the
 * honest liveness signal is when one last actually ran.
 */
export const bootstrapCommand = (): string => `launchctl bootstrap gui/$(id -u) ${plistPath()}`;

export const bootoutCommand = (): string => `launchctl bootout gui/$(id -u)/${LABEL}`;

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
  const failed =
    state.lastExitStatus !== null && state.lastExitStatus !== 0
      ? `. Warning: the last tick exited with status ${state.lastExitStatus} — check ~/.drovr/logs/drovr.err.log`
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
