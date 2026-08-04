/*
 * Copyright 2026 John Joseph
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Turning the watch agent on and off.
 *
 * Lives here rather than in `cli/` because both the `meetey watch` command and
 * the MCP server need it, and only `mcp-server/` and `daemon/` are copied into
 * `~/.meetey` at install time — the CLI runs from the npx package and is not on
 * the user's machine afterwards.
 *
 * Every path is derived from arguments rather than read from the environment, so
 * the CLI's notion of where meetey lives and the server's cannot drift apart.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { dirname, join } from "path";

export const WATCH_LABEL = "com.meetey.watch";

export function watchPaths({ meeteyDir, home }) {
  return {
    label: WATCH_LABEL,
    plistPath: join(home, "Library", "LaunchAgents", `${WATCH_LABEL}.plist`),
    scriptPath: join(meeteyDir, "daemon", "watch.js"),
    logPath: join(meeteyDir, "logs", "watch.log"),
    logsDir: join(meeteyDir, "logs"),
  };
}

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

function plistBody({ nodePath, scriptPath, logPath }) {
  // A LaunchAgent, not a LaunchDaemon: `display dialog` needs the user's GUI
  // session, and this must never run for a user who is not logged in.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(WATCH_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function isLoaded() {
  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid()}/${WATCH_LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bootout() {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}/${WATCH_LABEL}`], { stdio: "ignore" });
  } catch {
    // Not loaded, which is the state we were aiming for anyway.
  }
}

export function watchStatus({ meeteyDir, home }) {
  const paths = watchPaths({ meeteyDir, home });
  const installed = existsSync(paths.plistPath);
  const running = isLoaded();
  const available = existsSync(paths.scriptPath);

  return {
    enabled: installed && running,
    available,
    plistInstalled: installed,
    agentRunning: running,
    plistPath: paths.plistPath,
    logPath: paths.logPath,
    message: !available
      ? "The watch agent is not installed. Run: npx jej2k5/meetey update"
      : installed && running
        ? "The watcher is running. It asks before recording anything."
        : installed
          ? "The watcher is installed but not running — enable it again to restart it."
          : "The watcher is off.",
  };
}

export function enableWatch({ meeteyDir, home, nodePath, captureBinary }) {
  const paths = watchPaths({ meeteyDir, home });

  if (!existsSync(paths.scriptPath)) {
    return { error: `Watch agent not found at ${paths.scriptPath}. Run: npx jej2k5/meetey update` };
  }
  if (captureBinary && !existsSync(captureBinary)) {
    return { error: `meetey-capture binary not found at ${captureBinary}. Run: npx jej2k5/meetey install` };
  }

  try {
    mkdirSync(paths.logsDir, { recursive: true });
    mkdirSync(dirname(paths.plistPath), { recursive: true });
    writeFileSync(paths.plistPath, plistBody({
      nodePath,
      scriptPath: paths.scriptPath,
      logPath: paths.logPath,
    }));

    // Replace any previous version rather than stacking two agents.
    bootout();
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, paths.plistPath], { stdio: "ignore" });
  } catch (e) {
    return { error: `Could not start the watcher: ${e.message.split("\n")[0]}` };
  }

  return {
    enabled: true,
    plistPath: paths.plistPath,
    logPath: paths.logPath,
    message:
      "The watcher is on. It will ask before recording when it notices a meeting in " +
      "Chrome, Zoom, or Teams. Audio only — screen capture is still requested per recording.",
  };
}

export function disableWatch({ meeteyDir, home }) {
  const paths = watchPaths({ meeteyDir, home });
  try {
    bootout();
    if (existsSync(paths.plistPath)) unlinkSync(paths.plistPath);
  } catch (e) {
    return { error: `Could not stop the watcher: ${e.message.split("\n")[0]}` };
  }
  return {
    enabled: false,
    // Stopping the watcher is not stopping a recording. Conflating the two would
    // have someone turn this off mid-meeting and assume their capture ended.
    message: "The watcher is off. Any recording already in progress keeps running.",
  };
}

export function watchLog({ meeteyDir, home, lines = 40 }) {
  const paths = watchPaths({ meeteyDir, home });
  if (!existsSync(paths.logPath)) return { lines: [], message: "The watcher has no log yet." };
  const all = readFileSync(paths.logPath, "utf8").trimEnd().split("\n");
  return { lines: all.slice(-lines), logPath: paths.logPath };
}
