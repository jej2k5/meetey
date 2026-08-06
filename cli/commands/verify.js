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

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { green, yellow, red } from "../utils.js";
import { BINARY_PATH, MODEL_PATH } from "../paths.js";
import { resolveWhisper } from "../../mcp-server/whisper.js";

/**
 * Proves this machine can record and transcribe, by doing both.
 *
 * Everything that has actually cost a recording lived below the level a unit test
 * reaches: a permission that was never granted, a PATH without Homebrew on it, a
 * stream that started and delivered nothing. Ten seconds of the real thing catches
 * all of it, before a meeting rather than after.
 *
 * Returns true when the machine is ready.
 */
export function verify({ quiet = false } = {}) {
  if (!existsSync(BINARY_PATH)) {
    red("meetey-capture is not installed. Run: npx jej2k5/meetey install");
    return false;
  }

  // The capture half: permission, stream, bytes on disk, header validity.
  const capture = spawnSync(BINARY_PATH, ["--verify"], { stdio: quiet ? "pipe" : "inherit" });
  const captureOk = capture.status === 0;
  if (quiet && !captureOk) process.stdout.write(capture.stdout?.toString() ?? "");

  // The transcribe half, which the binary knows nothing about.
  const problems = [];
  const whisper = resolveWhisper();
  if (whisper) {
    green(`  ✓ whisper-cli  ${whisper}`);
  } else {
    red("  ✗ whisper-cli  not found — run: brew install whisper-cpp");
    problems.push("whisper-cli is missing, so nothing will be transcribed");
  }

  if (existsSync(MODEL_PATH)) {
    green(`  ✓ Whisper model  ${MODEL_PATH}`);
  } else {
    red(`  ✗ Whisper model  missing at ${MODEL_PATH} — run: npx jej2k5/meetey install`);
    problems.push("the Whisper model is missing");
  }

  console.log("");
  if (captureOk && problems.length === 0) {
    green("This machine can record and transcribe.");
    return true;
  }
  yellow("Not ready yet:");
  if (!captureOk) console.log("  - capture cannot run (see above)");
  for (const problem of problems) console.log(`  - ${problem}`);
  return false;
}
