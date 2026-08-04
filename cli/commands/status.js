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
  WATCH_PLIST, WATCH_SCRIPT,
} from "../paths.js";

function check(label, ok, detail = "") {
  const icon = ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
  console.log(`  ${icon}  ${label}${detail ? `  \x1b[2m(${detail})\x1b[0m` : ""}`);
  return ok;
}

export function status() {
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
      ? "off — enable: meetey watch enable"
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
  check("Hotkeys registered", hotkeysOk, hotkeysOk ? "Ctrl+Shift+R / Ctrl+Shift+S" : "run: npx jej2k5/meetey install");

  console.log();
}
