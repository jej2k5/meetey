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

import { execSync, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { green, yellow, red } from "../utils.js";
import {
  BINARY_PATH, MODEL_PATH, SERVER_DIR, SKILL_PATH, CLAUDE_JSON, KEYBINDINGS,
  WATCH_PLIST, WATCH_SCRIPT, MEETEY_DIR, PKG_DIR,
} from "../paths.js";
import { checkForUpdate, isDisabled } from "../../mcp-server/update-check.js";

function check(label, ok, detail = "") {
  const icon = ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
  console.log(`  ${icon}  ${label}${detail ? `  \x1b[2m(${detail})\x1b[0m` : ""}`);
  return ok;
}

export async function status() {
  console.log("\n\x1b[1mMeetey status\x1b[0m\n");

  // Binary
  const binaryOk = existsSync(BINARY_PATH);
  check("meetey-capture binary", binaryOk, binaryOk ? BINARY_PATH : "run: npx jej2k5/meetey install");

  // Binary signature
  if (binaryOk) {
    try {
      execFileSync("codesign", ["--verify", BINARY_PATH], { stdio: "ignore" });
      check("binary code-signed", true);
    } catch {
      check("binary code-signed", false, "run: npx jej2k5/meetey update");
    }
  }

  // Whisper CLI
  let whisperPath;
  try { whisperPath = execSync("which whisper-cli", { encoding: "utf8" }).trim(); } catch {}
  check("whisper-cli", !!whisperPath, whisperPath || "run: brew install whisper-cpp");

  // Model
  const modelOk = existsSync(MODEL_PATH);
  check("Whisper model (ggml-base.en.bin)", modelOk, modelOk ? MODEL_PATH : "run: npx jej2k5/meetey install");

  // Watch agent — optional, and off unless deliberately enabled.
  const watchInstalled = existsSync(WATCH_SCRIPT);
  const watchEnabled = existsSync(WATCH_PLIST);
  // Not a check() — off is a valid state, and the default one.
  const watchNote = watchEnabled
    ? "on — asks before recording"
    : watchInstalled
      ? "off — enable: npx jej2k5/meetey watch enable"
      : "off — run update to install it";
  console.log(`  \x1b[2m\u25cb\x1b[0m  meeting watcher (optional)  \x1b[2m(${watchNote})\x1b[0m`);

  // MCP server
  const serverOk = existsSync(`${SERVER_DIR}/index.js`);
  check("MCP server files", serverOk, serverOk ? SERVER_DIR : "run: npx jej2k5/meetey install");

  // MCP registration
  let mcpRegistered = false;
  if (existsSync(CLAUDE_JSON)) {
    try {
      const claude = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
      mcpRegistered = !!claude?.mcpServers?.meetey;
    } catch {}
  }
  check("MCP server registered in ~/.claude.json", mcpRegistered, mcpRegistered ? "" : "run: npx jej2k5/meetey install");

  // Skill
  const skillOk = existsSync(SKILL_PATH);
  check("/meetey skill installed", skillOk, skillOk ? SKILL_PATH : "run: npx jej2k5/meetey install");

  // Keybindings
  let hotkeysOk = false;
  if (existsSync(KEYBINDINGS)) {
    try {
      const bindings = JSON.parse(readFileSync(KEYBINDINGS, "utf8"));
      hotkeysOk = bindings.some(b => b.action === "sendMessage" && b.value?.includes("meetey"));
    } catch {}
  }
  check("Claude Code shortcuts", hotkeysOk, hotkeysOk ? "Ctrl+Shift+R / Ctrl+Shift+S, while Claude Code is focused" : "run: npx jej2k5/meetey install");

  await reportVersion();
}

function readVersion(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function reportVersion() {
  const installed = readVersion(`${SERVER_DIR}/package.json`);
  const running = readVersion(`${PKG_DIR}/package.json`);
  if (!installed) return;

  console.log("");
  console.log(`  installed: ${installed}`);

  // Free, and catches an update that was started and did not finish — the CLI
  // you are running is newer than what it put on disk.
  if (running && installed !== running) {
    yellow(`  this package is ${running} — run: npx jej2k5/meetey update`);
    return;
  }

  if (isDisabled()) {
    console.log("  update check disabled (MEETEY_NO_UPDATE_CHECK=1)");
    return;
  }

  const update = await checkForUpdate({ meeteyDir: MEETEY_DIR, currentVersion: installed });
  if (!update) return;

  if (update.updateAvailable) {
    yellow(`  update available: ${installed} → ${update.latest}`);
    console.log("    npx jej2k5/meetey update");
  } else if (update.error) {
    // Not a failure worth shouting about; the check is a convenience.
    console.log(`  couldn't check for updates (${update.error})`);
  } else {
    green("  up to date");
  }

  console.log();
}
