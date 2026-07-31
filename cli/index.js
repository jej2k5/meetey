#!/usr/bin/env node
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

const [,, command, ...args] = process.argv;

const HELP = `
Usage: npx jej2k5/meetey <command>

Commands:
  install   Install meetey — builds the Swift binary, downloads the Whisper
            model, registers the MCP server and /meetey skill in Claude Code
  update    Rebuild the Swift binary and refresh the MCP server and skill
  status    Show what's installed and whether everything is wired up correctly

Examples:
  npx jej2k5/meetey install
  npx jej2k5/meetey update
  npx jej2k5/meetey status
`;

switch (command) {
  case "install": {
    const { install } = await import("./commands/install.js");
    await install();
    break;
  }
  case "update": {
    const { update } = await import("./commands/update.js");
    await update();
    break;
  }
  case "status": {
    const { status } = await import("./commands/status.js");
    status();
    break;
  }
  case "--version":
  case "-v": {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
    console.log(pkg.version);
    break;
  }
  default:
    console.log(command ? `Unknown command: ${command}\n` : "");
    console.log(HELP);
    process.exit(command ? 1 : 0);
}
