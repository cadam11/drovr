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
