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
    healthPath: join(meeteyDir, "state", "watch-health.json"),
  };
}

/**
 * What the agent can currently see.
 *
 * Written by the agent itself, every poll — and it has to be the agent, not a
 * check run from the CLI. Screen Recording permission is granted per responsible
 * process: a `--list-windows` run from a terminal is attributed to the terminal,
 * while the same binary run from a LaunchAgent is attributed to the agent's node.
 * They differ, so a check performed by the installer can pass while the thing it
 * just installed is blind.
 */
export function writeHealth({ meeteyDir, home }, health) {
  const { healthPath } = watchPaths({ meeteyDir, home });
  try {
    mkdirSync(dirname(healthPath), { recursive: true });
    writeFileSync(healthPath, JSON.stringify(health, null, 2) + "\n");
  } catch {
    // Health reporting must never take the agent down.
  }
}

export function readHealth({ meeteyDir, home }) {
  const { healthPath } = watchPaths({ meeteyDir, home });
  if (!existsSync(healthPath)) return null;
  try {
    return JSON.parse(readFileSync(healthPath, "utf8"));
  } catch {
    return null;
  }
}

function clearHealth({ meeteyDir, home }) {
  const { healthPath } = watchPaths({ meeteyDir, home });
  try {
    unlinkSync(healthPath);
  } catch {
    // Already gone.
  }
}

/** Blocking sleep-poll, matching the technique the MCP server already uses. */
function waitFor(ms, done) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return done();
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
  <!-- Without this a crash-looping agent restarts every 10s and fills the log. -->
  <key>ThrottleInterval</key><integer>30</integer>
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

  const health = readHealth({ meeteyDir, home });

  return {
    enabled: installed && running,
    available,
    plistInstalled: installed,
    agentRunning: running,
    // "Loaded" is what launchctl knows. Whether it can see anything is a
    // different question, and the one that actually goes wrong.
    canSeeWindows: health?.canSeeWindows ?? null,
    lastCheck: health?.at ?? null,
    plistPath: paths.plistPath,
    logPath: paths.logPath,
    message: watchMessage({
      available,
      installed,
      running,
      canSeeWindows: health?.canSeeWindows ?? null,
    }),
  };
}

/**
 * The one-line verdict. Pure, so every combination can be exercised — including
 * running-but-blind, which is the state that matters most and the one hardest to
 * reproduce, since it needs a real LaunchAgent and a revoked permission.
 */
export function watchMessage({ available, installed, running, canSeeWindows }) {
  if (!available) return "The watch agent is not installed. Run: npx jej2k5/meetey update";
  if (installed && running && canSeeWindows === false) {
    return "The watcher is running but cannot see any windows — it will never notice a meeting. " +
      "Node needs Screen Recording permission in System Settings → Privacy & Security.";
  }
  if (installed && running) return "The watcher is running. It asks before recording anything.";
  if (installed) return "The watcher is installed but not running — enable it again to restart it.";
  return "The watcher is off.";
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
    // Stale health from a previous run would be mistaken for this one's verdict.
    clearHealth({ meeteyDir, home });
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

  // Wait for the agent to report what it can actually see. Declaring success
  // without this is how a watcher ends up installed, running, and permanently
  // blind — the failure logs one line every ten seconds and shows the user
  // nothing at all.
  const reported = waitFor(25_000, () => readHealth({ meeteyDir, home }) !== null);
  const health = readHealth({ meeteyDir, home });

  if (!reported || !health?.canSeeWindows) {
    // Leave nothing behind that looks enabled but cannot work.
    bootout();
    try { unlinkSync(paths.plistPath); } catch { /* nothing to remove */ }

    return {
      error: !reported
        ? "The watcher started but never reported in. Check the log: " + paths.logPath
        : "The watcher cannot see any windows, so it would never notice a meeting.",
      permissionNeeded: !reported ? undefined : true,
      detail: health?.error ?? undefined,
      fix:
        "Node needs Screen Recording permission, separately from meetey-capture. " +
        "System Settings → Privacy & Security → Screen Recording → enable node, " +
        "then run this again.",
      enabled: false,
    };
  }

  return {
    enabled: true,
    plistPath: paths.plistPath,
    logPath: paths.logPath,
    message:
      "The watcher is on and can see your windows. It will ask before recording when it " +
      "notices a meeting in Chrome, Zoom, or Teams, offering audio only or audio + screen.",
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
