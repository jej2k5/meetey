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
 * Finding `whisper-cli`.
 *
 * Calling it by bare name works from Claude Code, which inherits a login shell's
 * PATH, and fails from the watch agent, which does not. launchd gives a job
 * `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else, while Homebrew installs to
 * `/opt/homebrew/bin` or `/usr/local/bin` — so every recording the agent made
 * failed to transcribe with ENOENT, in a log nobody reads, while the same call
 * succeeded from the editor.
 *
 * Resolve to an absolute path instead of trusting the environment.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

const KNOWN_LOCATIONS = [
  "/opt/homebrew/bin/whisper-cli", // Homebrew, Apple Silicon
  "/usr/local/bin/whisper-cli", // Homebrew, Intel
  "/usr/bin/whisper-cli",
];

let cached;

/** Absolute path to whisper-cli, or null when it cannot be found. */
export function resolveWhisper() {
  if (cached !== undefined) return cached;

  if (process.env.MEETEY_WHISPER && existsSync(process.env.MEETEY_WHISPER)) {
    return (cached = process.env.MEETEY_WHISPER);
  }
  for (const path of KNOWN_LOCATIONS) {
    if (existsSync(path)) return (cached = path);
  }
  // Last resort: whatever PATH we do have. Succeeds under Claude Code, and is
  // exactly what fails under launchd — hence the explicit list above.
  try {
    const found = execFileSync("/usr/bin/which", ["whisper-cli"], { encoding: "utf8" }).trim();
    if (found && existsSync(found)) return (cached = found);
  } catch {
    // Not on PATH either.
  }
  return (cached = null);
}

/** Testing seam; also lets a long-lived agent notice a later install. */
export function clearWhisperCache() {
  cached = undefined;
}
