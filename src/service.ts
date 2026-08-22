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
export const describeService = (state: ServiceState, lastTickAt: number | null, now: number): string => {
  if (!state.installed) return 'not installed — run `drovr service install`';
  if (!state.loaded) return 'installed but not loaded — run the launchctl bootstrap line';

  const every = state.intervalSeconds === null ? '' : ` every ${state.intervalSeconds}s`;
  const failed =
    state.lastExitStatus !== null && state.lastExitStatus !== 0
      ? `, last tick exited ${state.lastExitStatus}`
      : '';

  if (lastTickAt === null) return `loaded${every}, no tick recorded yet${failed}`;

  const minutes = Math.round((now - lastTickAt) / 60_000);
  const ago = minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h${minutes % 60}m ago`;
  const overdue =
    state.intervalSeconds !== null && now - lastTickAt > state.intervalSeconds * 3000
      ? ' — overdue'
      : '';
  return `loaded${every}, last tick ${ago}${overdue}${failed}`;
};
