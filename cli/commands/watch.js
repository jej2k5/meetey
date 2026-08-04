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

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { dirname } from "path";
import { green, yellow, red, step } from "../utils.js";
import {
  LOGS_DIR, WATCH_LABEL, WATCH_PLIST, WATCH_SCRIPT, BINARY_PATH,
} from "../paths.js";

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

function plist(nodePath) {
  // A LaunchAgent, not a LaunchDaemon: it needs the user's GUI session to show a
  // dialog, and it must never run for a user who is not logged in.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(WATCH_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(WATCH_SCRIPT)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(`${LOGS_DIR}/watch.log`)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(`${LOGS_DIR}/watch.log`)}</string>
</dict>
</plist>
`;
}

const uid = () => process.getuid();

function isLoaded() {
  try {
    execFileSync("launchctl", ["print", `gui/${uid()}/${WATCH_LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bootout() {
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid()}/${WATCH_LABEL}`], { stdio: "ignore" });
  } catch {
    // Not loaded. That is the state we wanted.
  }
}

export function watch(sub) {
  switch (sub) {
    case "enable":  return enable();
    case "disable": return disable();
    case "status":  return status();
    case "logs":    return logs();
    default:
      console.log(`
Usage: meetey watch <enable|disable|status|logs>

  enable    Watch for meetings and offer to record them
  disable   Stop watching
  status    Is the watcher running?
  logs      Show recent watcher activity

The watcher never records on its own. When it notices a meeting it asks, naming
the window, and records only if you say yes.
`);
      return;
  }
}

function enable() {
  if (!existsSync(BINARY_PATH)) {
    red("meetey is not installed. Run: npx jej2k5/meetey install");
    process.exit(1);
  }
  if (!existsSync(WATCH_SCRIPT)) {
    red(`Watch agent not found at ${WATCH_SCRIPT}. Run: npx jej2k5/meetey update`);
    process.exit(1);
  }

  const nodePath = process.execPath;

  step("Installing the watch agent");
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(dirname(WATCH_PLIST), { recursive: true });
  writeFileSync(WATCH_PLIST, plist(nodePath));
  green(`Wrote ${WATCH_PLIST}`);

  step("Starting it");
  bootout(); // Replace any previous version rather than stacking.
  execFileSync("launchctl", ["bootstrap", `gui/${uid()}`, WATCH_PLIST], { stdio: "ignore" });
  green("Watcher running");

  console.log(`
Meetey will now ask before recording when it notices a meeting in Chrome, Zoom,
or Teams. It records audio only; screen capture still has to be requested per
recording through /meetey start.

It starts nothing without you clicking Record.

  meetey watch status    Check it
  meetey watch logs      See what it has noticed
  meetey watch disable   Turn it off
`);
}

function disable() {
  step("Stopping the watch agent");
  bootout();
  if (existsSync(WATCH_PLIST)) {
    unlinkSync(WATCH_PLIST);
    green(`Removed ${WATCH_PLIST}`);
  }
  green("Watcher disabled. Any recording already running is unaffected.");
}

function status() {
  const installed = existsSync(WATCH_PLIST);
  const running = isLoaded();

  if (!installed && !running) {
    yellow("Watcher is off. Enable it with: meetey watch enable");
    return;
  }
  if (installed && running) {
    green("Watcher is running.");
  } else if (installed) {
    yellow("Watcher is installed but not running. Try: meetey watch enable");
  } else {
    yellow("Watcher is running but its plist is missing. Try: meetey watch disable, then enable.");
  }
  console.log(`  plist: ${WATCH_PLIST}`);
  console.log(`  log:   ${LOGS_DIR}/watch.log`);
}

function logs() {
  const path = `${LOGS_DIR}/watch.log`;
  if (!existsSync(path)) {
    yellow("No watcher log yet.");
    return;
  }
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  console.log(lines.slice(-40).join("\n"));
}
