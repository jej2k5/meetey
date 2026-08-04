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
import { existsSync, cpSync } from "fs";
import { join } from "path";
import { green, yellow, red, step, run } from "../utils.js";
import { PKG_DIR, CAPTURE_DIR, BINARY_PATH, SERVER_DIR, DAEMON_DIR, SKILL_PATH } from "../paths.js";
import { registerMcpServer, installSkill, registerKeybindings } from "./install.js";

export async function update() {
  // --- Verify installed ---
  if (!existsSync(BINARY_PATH)) {
    red("meetey-capture binary not found. Run: npx jej2k5/meetey install");
    process.exit(1);
  }

  // --- Rebuild Swift binary ---
  step("Rebuilding meetey-capture");
  cpSync(join(PKG_DIR, "meetey-capture"), CAPTURE_DIR, { recursive: true, force: true });
  run("swift build -c release", { cwd: CAPTURE_DIR });
  green("Swift build complete");

  step("Code-signing meetey-capture");
  execFileSync("codesign", [
    "--force", "--sign", "-",
    "--options", "runtime",
    "--entitlements", join(CAPTURE_DIR, "entitlements.plist"),
    BINARY_PATH,
  ]);
  green(`Signed: ${BINARY_PATH}`);

  // --- Update MCP server ---
  step("Updating MCP server");
  cpSync(join(PKG_DIR, "mcp-server"), SERVER_DIR, { recursive: true, force: true });
  run("npm install --silent", { cwd: SERVER_DIR });
  green("MCP server updated");

  // The watch agent ships alongside but stays dormant: nothing runs it until
  // `meetey watch enable`, and that opt-in is the whole consent story.
  //
  // Guarded because a half-applied update is worse than a missing optional
  // component: this runs after the MCP server has already been replaced, so
  // throwing here would leave the install broken rather than merely incomplete.
  step("Installing the watch agent");
  if (existsSync(join(PKG_DIR, "daemon"))) {
    cpSync(join(PKG_DIR, "daemon"), DAEMON_DIR, { recursive: true, force: true });
    green(`Watch agent installed to ${DAEMON_DIR} (off until: meetey watch enable)`);
  } else {
    yellow("Watch agent not present in this package — skipping (meetey watch will be unavailable)");
  }

  // --- Re-register (command/paths may have changed) ---
  step("Re-registering MCP server");
  registerMcpServer();
  green("MCP server registration refreshed");

  // --- Update skill ---
  step("Updating /meetey skill");
  installSkill();
  green(`Skill updated at ${SKILL_PATH}`);

  // --- Update keybindings ---
  step("Updating Claude Code shortcuts");
  registerKeybindings();
  green("Shortcuts updated (they work while Claude Code is focused)");

  green("\nMeetey updated. Restart Claude Code to pick up changes.");
}
