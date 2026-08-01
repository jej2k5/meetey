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

function framesPath(id) {
  return join(RECORDINGS_DIR, `${id}-frames`);
}

function readFrameIndex(framesDir) {
  const indexPath = join(framesDir, "index.json");
  if (!existsSync(indexPath)) return null;
  try {
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    return {
      ...index,
      frames: (index.frames ?? []).map((f) => ({ ...f, path: join(framesDir, f.file) })),
    };
  } catch (e) {
    return { error: `Could not parse ${indexPath}: ${e.message}` };
  }
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

function startRecording({ bundleID, stopAfter, captureVideo = false, fps, maxFrames }) {
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

  // Video is opt-in per recording. There is deliberately no env var or config
  // file that can turn it on by default — it must be requested every time.
  const framesDir = captureVideo ? framesPath(id) : null;
  if (captureVideo) {
    args.push("--video", "--frames-dir", framesDir);
    if (fps) args.push("--fps", String(fps));
    if (maxFrames) args.push("--max-frames", String(maxFrames));
  }

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

  activeRecording = {
    process: child,
    outputPath,
    framesDir,
    sessionId: id,
    startedAt: new Date().toISOString(),
  };

  return {
    sessionId: id,
    outputPath,
    bundleID,
    capturingVideo: captureVideo,
    framesDir,
    startedAt: activeRecording.startedAt,
    message: captureVideo
      ? "Recording started with screen capture. Call stop_recording when the meeting ends."
      : "Recording started (audio only). Call stop_recording when the meeting ends.",
  };
}

function stopRecording() {
  if (!activeRecording) {
    return { error: "No active recording." };
  }

  const { process: child, outputPath, framesDir, sessionId: id, startedAt } = activeRecording;

  child.kill("SIGTERM");
  activeRecording = null;

  // Give the process a moment to finalize the WAV header, and — when video is
  // on — to drain the encode queue and write the frame manifest.
  const wait = (ms, done) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !done()) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  };
  wait(3000, () => existsSync(outputPath));
  if (framesDir) wait(10000, () => existsSync(join(framesDir, "index.json")));

  const result = {
    sessionId: id,
    outputPath,
    startedAt,
    stoppedAt: new Date().toISOString(),
    message: `Recording saved to ${outputPath}. Call transcribe with this path.`,
  };

  if (framesDir) {
    const index = readFrameIndex(framesDir);
    result.framesDir = framesDir;
    if (!index) {
      result.keyframeCount = 0;
      result.frameIndexMissing = true;
    } else if (index.error) {
      result.keyframeCount = 0;
      result.frameIndexError = index.error;
    } else {
      result.keyframeCount = index.frameCount ?? index.frames.length;
      result.truncated = index.truncated === true;
    }
    result.message += ` ${result.keyframeCount} keyframe(s) captured — call get_keyframes for screen content.`;
  }

  return result;
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
    const rawSegments = raw.transcription ?? raw.segments ?? [];

    // whisper.cpp reports offsets in milliseconds under `offsets`. Keeping them
    // is what lets the skill interleave keyframes with what was being said.
    const segments = rawSegments.map((s) => ({
      text: (s.text ?? s.sentence ?? "").trim(),
      fromMs: s.offsets?.from ?? null,
      toMs: s.offsets?.to ?? null,
    })).filter((s) => s.text.length > 0);

    const transcript = segments.map((s) => s.text).join(" ").trim();

    return { transcript, segments, jsonPath };
  } catch (e) {
    return { error: e.message };
  }
}

function getKeyframes({ framesDir, sessionId: id }) {
  const dir = framesDir ?? (id ? framesPath(id) : null);
  if (!dir) {
    return { error: "Provide either framesDir or sessionId." };
  }
  if (!existsSync(dir)) {
    return { error: `No keyframe directory at ${dir}. Was the recording started with captureVideo?` };
  }
  const index = readFrameIndex(dir);
  if (!index) return { error: `No index.json in ${dir}. The capture may not have finished cleanly.` };
  if (index.error) return { error: index.error };
  return index;
}

function getStatus() {
  if (!activeRecording) {
    return { active: false };
  }
  return {
    active: true,
    sessionId: activeRecording.sessionId,
    outputPath: activeRecording.outputPath,
    capturingVideo: activeRecording.framesDir !== null,
    framesDir: activeRecording.framesDir,
    startedAt: activeRecording.startedAt,
  };
}

// --- MCP server ---

const server = new Server(
  { name: "meetey", version: "1.1.0" },
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
      description: "Start capturing audio from a meeting app, and optionally screen keyframes.",
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
          captureVideo: {
            type: "boolean",
            description:
              "Also capture screen keyframes (slides, screen shares, code). Off by default. " +
              "Must be requested per recording — the user has to opt in each time, and should " +
              "be warned that everything the target app displays is captured, including other " +
              "tabs and notifications.",
          },
          fps: {
            type: "number",
            description: "Frames sampled per second when captureVideo is on (default 1).",
          },
          maxFrames: {
            type: "number",
            description: "Cap on keyframes per session when captureVideo is on (default 200).",
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
      description:
        "Transcribe a WAV file using whisper.cpp running locally. Returns the full " +
        "transcript plus timestamped segments.",
      inputSchema: {
        type: "object",
        required: ["wavPath"],
        properties: {
          wavPath: { type: "string", description: "Absolute path to the WAV file." },
        },
      },
    },
    {
      name: "get_keyframes",
      description:
        "Read the screen keyframes captured during a recording: file paths, millisecond " +
        "offsets, and locally-recognized text (OCR) for each. Only available when the " +
        "recording was started with captureVideo.",
      inputSchema: {
        type: "object",
        properties: {
          framesDir: { type: "string", description: "Frames directory from stop_recording." },
          sessionId: { type: "string", description: "Session ID, if framesDir is unknown." },
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
    case "get_keyframes":   result = getKeyframes(args); break;
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
