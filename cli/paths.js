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

import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const HOME      = homedir();
export const PKG_DIR   = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MEETEY_DIR     = join(HOME, ".meetey");
export const MODELS_DIR     = join(MEETEY_DIR, "models");
export const RECORDINGS_DIR = join(MEETEY_DIR, "recordings");
export const SERVER_DIR     = join(MEETEY_DIR, "mcp-server");
export const DAEMON_DIR     = join(MEETEY_DIR, "daemon");
export const CAPTURE_DIR    = join(MEETEY_DIR, "meetey-capture");
export const LOGS_DIR       = join(MEETEY_DIR, "logs");
export const BINARY_PATH    = join(CAPTURE_DIR, ".build", "release", "meetey-capture");
export const MODEL_PATH     = join(MODELS_DIR, "ggml-base.en.bin");
export const SKILL_PATH     = join(HOME, ".claude", "skills", "meetey", "SKILL.md");
export const CLAUDE_JSON    = join(HOME, ".claude.json");
export const KEYBINDINGS    = join(HOME, ".claude", "keybindings.json");

export const WATCH_LABEL    = "com.meetey.watch";
export const WATCH_PLIST    = join(HOME, "Library", "LaunchAgents", `${WATCH_LABEL}.plist`);
export const WATCH_SCRIPT   = join(DAEMON_DIR, "watch.js");

export const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
