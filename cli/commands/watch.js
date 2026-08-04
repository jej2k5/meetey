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

import { green, yellow, red, step } from "../utils.js";
import { MEETEY_DIR, HOME, BINARY_PATH } from "../paths.js";
// The same code the MCP server runs, so `meetey watch enable` and `/meetey watch
// on` cannot drift into behaving differently.
import {
  watchStatus, enableWatch, disableWatch, watchLog,
} from "../../mcp-server/watch-agent.js";

const ctx = { meeteyDir: MEETEY_DIR, home: HOME };

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

You can also drive this from Claude Code with /meetey watch.
`);
  }
}

function enable() {
  step("Starting the watch agent");
  const result = enableWatch({ ...ctx, nodePath: process.execPath, captureBinary: BINARY_PATH });
  if (result.error) {
    red(result.error);
    process.exit(1);
  }
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
  const result = disableWatch(ctx);
  if (result.error) {
    red(result.error);
    process.exit(1);
  }
  green(result.message);
}

function status() {
  const state = watchStatus(ctx);
  (state.enabled ? green : yellow)(state.message);
  console.log(`  plist: ${state.plistPath}`);
  console.log(`  log:   ${state.logPath}`);
}

function logs() {
  const result = watchLog({ ...ctx, lines: 40 });
  if (result.message && result.lines.length === 0) {
    yellow(result.message);
    return;
  }
  console.log(result.lines.join("\n"));
}
