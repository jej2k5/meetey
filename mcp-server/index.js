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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// --- Config ---

const HOME = homedir();
const MEETEY_DIR = join(HOME, ".meetey");
const RECORDINGS_DIR = process.env.MEETEY_OUTPUT_DIR ?? join(MEETEY_DIR, "recordings");
const MODEL_PATH = process.env.MEETEY_MODEL ?? join(MEETEY_DIR, "models", "ggml-base.en.bin");

const scriptDir = new URL(".", import.meta.url).pathname;
const CAPTURE_BINARY = process.env.MEETEY_BINARY ??
  resolve(scriptDir, "../meetey-capture/.build/release/meetey-capture");

mkdirSync(RECORDINGS_DIR, { recursive: true });

// --- State ---

let activeRecording = null; // { process, outputPath, sessionId, startedAt }

// --- Helpers ---

function sessionId() {
  return `meetey-${Date.now()}`;
}

function wavPath(id) {
  return join(RECORDINGS_DIR, `${id}.wav`);
}

function runCaptureBinary(args) {
  return execFileSync(CAPTURE_BINARY, args, { encoding: "utf8" });
}

// --- Tool handlers ---

function listApps() {
  if (!existsSync(CAPTURE_BINARY)) {
    return { error: `meetey-capture binary not found at ${CAPTURE_BINARY}. Run: npx jej2k5/meetey install` };
  }
  try {
    const output = runCaptureBinary(["--list-apps"]);
    const apps = JSON.parse(output.trim());
    if (apps.length === 0) {
      return { apps: [], message: "No supported meeting apps are running (Chrome, Zoom, Teams)." };
    }
    return { apps };
  } catch (e) {
    return { error: e.message };
  }
}

function startRecording({ bundleID, stopAfter }) {
  if (activeRecording) {
    return { error: "A recording is already active. Call stop_recording first." };
  }
  if (!existsSync(CAPTURE_BINARY)) {
    return { error: `meetey-capture binary not found at ${CAPTURE_BINARY}. Run: npx jej2k5/meetey install` };
  }

  const id = sessionId();
  const outputPath = wavPath(id);
  const args = ["--app", bundleID, "--output", outputPath];
  if (stopAfter) args.push("--stop-after", String(stopAfter));

  const child = spawn(CAPTURE_BINARY, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });

  child.stderr.on("data", (d) => process.stderr.write(d));

  child.on("exit", (code) => {
    if (activeRecording?.sessionId === id) {
      activeRecording = null;
    }
  });

  activeRecording = { process: child, outputPath, sessionId: id, startedAt: new Date().toISOString() };

  return {
    sessionId: id,
    outputPath,
    bundleID,
    startedAt: activeRecording.startedAt,
    message: `Recording started. Call stop_recording when the meeting ends.`,
  };
}

function stopRecording() {
  if (!activeRecording) {
    return { error: "No active recording." };
  }

  const { process: child, outputPath, sessionId: id, startedAt } = activeRecording;

  child.kill("SIGTERM");
  activeRecording = null;

  // Give the process a moment to finalize the WAV header
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !existsSync(outputPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  return {
    sessionId: id,
    outputPath,
    startedAt,
    stoppedAt: new Date().toISOString(),
    message: `Recording saved to ${outputPath}. Call transcribe with this path.`,
  };
}

function transcribe({ wavPath: filePath }) {
  if (!existsSync(filePath)) {
    return { error: `WAV file not found: ${filePath}` };
  }
  if (!existsSync(MODEL_PATH)) {
    return { error: `Whisper model not found at ${MODEL_PATH}. Run: npx jej2k5/meetey install` };
  }

  try {
    execFileSync("whisper-cli", [
      "-f", filePath,
      "-m", MODEL_PATH,
      "-l", "en",
      "--output-json",
      "--no-prints",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const jsonPath = filePath.replace(/\.wav$/, ".wav.json");
    if (!existsSync(jsonPath)) {
      return { error: "whisper-cli ran but produced no JSON output." };
    }

    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    const transcript = (raw.transcription ?? raw.segments ?? [])
      .map((s) => s.text ?? s.sentence ?? "")
      .join(" ")
      .trim();

    return { transcript, jsonPath };
  } catch (e) {
    return { error: e.message };
  }
}

function getStatus() {
  if (!activeRecording) {
    return { active: false };
  }
  return {
    active: true,
    sessionId: activeRecording.sessionId,
    outputPath: activeRecording.outputPath,
    startedAt: activeRecording.startedAt,
  };
}

// --- MCP server ---

const server = new Server(
  { name: "meetey", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_apps",
      description: "List running apps that Meetey can capture audio from (Chrome, Zoom, Teams).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "start_recording",
      description: "Start capturing audio from a meeting app.",
      inputSchema: {
        type: "object",
        required: ["bundleID"],
        properties: {
          bundleID: {
            type: "string",
            description: "App bundle ID. Use list_apps to get valid values.",
          },
          stopAfter: {
            type: "number",
            description: "Auto-stop after this many seconds of recording (optional).",
          },
        },
      },
    },
    {
      name: "stop_recording",
      description: "Stop the active recording and return the path to the WAV file.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "transcribe",
      description: "Transcribe a WAV file using whisper.cpp running locally.",
      inputSchema: {
        type: "object",
        required: ["wavPath"],
        properties: {
          wavPath: { type: "string", description: "Absolute path to the WAV file." },
        },
      },
    },
    {
      name: "get_status",
      description: "Check whether a recording is currently active.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  let result;
  switch (name) {
    case "list_apps":      result = listApps(); break;
    case "start_recording": result = startRecording(args); break;
    case "stop_recording":  result = stopRecording(); break;
    case "transcribe":      result = transcribe(args); break;
    case "get_status":      result = getStatus(); break;
    default:
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }

  const isError = Boolean(result.error);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("Meetey MCP server running\n");
