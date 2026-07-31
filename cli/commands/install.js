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
import { existsSync, mkdirSync, cpSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { green, yellow, red, step, run, which, downloadFile } from "../utils.js";
import {
  PKG_DIR, MEETEY_DIR, MODELS_DIR, RECORDINGS_DIR,
  SERVER_DIR, CAPTURE_DIR, BINARY_PATH, MODEL_PATH, MODEL_URL,
  SKILL_PATH, CLAUDE_JSON, KEYBINDINGS,
} from "../paths.js";

export async function install() {
  // --- macOS version check ---
  step("Checking macOS version");
  const ver = (await import("child_process")).execSync("sw_vers -productVersion", { encoding: "utf8" }).trim();
  const major = parseInt(ver.split(".")[0], 10);
  if (major < 13) { red(`Meetey requires macOS 13+. You have ${ver}.`); process.exit(1); }
  green(`macOS ${ver} — OK`);

  // --- Homebrew ---
  step("Checking Homebrew");
  if (!which("brew")) {
    yellow("Homebrew not found. Installing...");
    run('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
  } else {
    green("Homebrew found");
  }

  // --- whisper-cli ---
  step("Checking whisper-cli");
  if (!which("whisper-cli")) {
    yellow("Installing whisper-cpp via Homebrew...");
    run("brew install whisper-cpp");
  } else {
    green(`whisper-cli found at ${which("whisper-cli")}`);
  }

  // --- Whisper model ---
  step("Checking Whisper model");
  mkdirSync(MODELS_DIR, { recursive: true });
  if (existsSync(MODEL_PATH)) {
    green(`Model already present at ${MODEL_PATH}`);
  } else {
    yellow("Downloading ggml-base.en.bin (~142 MB)...");
    await downloadFile(MODEL_URL, MODEL_PATH);
    green(`Model saved to ${MODEL_PATH}`);
  }

  // --- Build Swift binary ---
  step("Building meetey-capture");
  mkdirSync(RECORDINGS_DIR, { recursive: true });
  cpSync(join(PKG_DIR, "meetey-capture"), CAPTURE_DIR, { recursive: true, force: true });
  run("swift build -c release", { cwd: CAPTURE_DIR });
  green("Swift build complete");

  // --- Code-sign ---
  step("Code-signing meetey-capture");
  execFileSync("codesign", [
    "--force", "--sign", "-",
    "--options", "runtime",
    "--entitlements", join(CAPTURE_DIR, "entitlements.plist"),
    BINARY_PATH,
  ]);
  green(`Signed: ${BINARY_PATH}`);

  // --- Copy MCP server ---
  step("Installing MCP server");
  cpSync(join(PKG_DIR, "mcp-server"), SERVER_DIR, { recursive: true, force: true });
  run("npm install --silent", { cwd: SERVER_DIR });
  green(`MCP server installed to ${SERVER_DIR}`);

  // --- Register MCP server in ~/.claude.json ---
  step("Registering MCP server in Claude Code");
  registerMcpServer();
  green("MCP server registered");

  // --- Install /meetey skill ---
  step("Installing /meetey skill");
  installSkill();
  green(`Skill installed to ${SKILL_PATH}`);

  // --- Register keybindings ---
  step("Registering hotkeys");
  registerKeybindings();
  green("Keybindings registered");

  // --- Done ---
  printPermissionReminder();
  green("Meetey installed! Start a meeting and run /meetey in Claude Code, or press Ctrl+Shift+R.");
}

export function registerMcpServer() {
  if (!existsSync(CLAUDE_JSON)) writeFileSync(CLAUDE_JSON, "{}\n");
  const claude = JSON.parse(readFileSync(CLAUDE_JSON, "utf8"));
  claude.mcpServers = claude.mcpServers ?? {};
  claude.mcpServers.meetey = mcpEntry();
  writeFileSync(CLAUDE_JSON, JSON.stringify(claude, null, 2) + "\n");
}

export function installSkill() {
  mkdirSync(dirname(SKILL_PATH), { recursive: true });
  if (existsSync(SKILL_PATH)) unlinkSync(SKILL_PATH);
  cpSync(join(PKG_DIR, "skill", "SKILL.md"), SKILL_PATH);
}

export function registerKeybindings() {
  let bindings = [];
  try { bindings = JSON.parse(readFileSync(KEYBINDINGS, "utf8")); } catch {}
  bindings = bindings.filter(b => !(b.action === "sendMessage" && b.value?.includes("meetey")));
  bindings.push(
    { binding: "ctrl+shift+r", action: "sendMessage", value: "/meetey start" },
    { binding: "ctrl+shift+s", action: "sendMessage", value: "/meetey stop"  },
  );
  mkdirSync(dirname(KEYBINDINGS), { recursive: true });
  writeFileSync(KEYBINDINGS, JSON.stringify(bindings, null, 2) + "\n");
}

function mcpEntry() {
  return {
    type: "stdio",
    command: which("node"),
    args: [join(SERVER_DIR, "index.js")],
    env: {
      MEETEY_BINARY: BINARY_PATH,
      MEETEY_MODEL: MODEL_PATH,
      MEETEY_OUTPUT_DIR: RECORDINGS_DIR,
    },
  };
}

function printPermissionReminder() {
  console.log(`
\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[33m ACTION REQUIRED: Grant Screen Recording permission\x1b[0m
\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
\x1b[33m 1. Open System Settings → Privacy & Security → Screen Recording\x1b[0m
\x1b[33m 2. Enable your terminal app (Terminal, iTerm2, Warp, etc.)\x1b[0m
\x1b[33m 3. Re-launch your terminal if prompted\x1b[0m
\x1b[33m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m
`);
}
