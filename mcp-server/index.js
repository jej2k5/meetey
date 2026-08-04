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
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import { assessQuality, formatDuration, wavDurationMs } from "./quality.js";
import {
  deleteRecording, getRecording, listRecordings, searchRecordings, systemStatus,
} from "./library.js";
import { readActive, writeActive, clearActive } from "./session-state.js";
import { watchStatus, enableWatch, disableWatch, watchLog } from "./watch-agent.js";

// --- Config ---

const HOME = homedir();
const MEETEY_DIR = process.env.MEETEY_HOME ?? join(HOME, ".meetey");
const RECORDINGS_DIR = process.env.MEETEY_OUTPUT_DIR ?? join(MEETEY_DIR, "recordings");
const MODEL_PATH = process.env.MEETEY_MODEL ?? join(MEETEY_DIR, "models", "ggml-base.en.bin");

const scriptDir = new URL(".", import.meta.url).pathname;
const CAPTURE_BINARY = process.env.MEETEY_BINARY ??
  resolve(scriptDir, "../meetey-capture/.build/release/meetey-capture");

// Admin surface only — these are inspected, never written, by this server.
const CLAUDE_JSON = join(HOME, ".claude.json");
const SKILL_PATH = join(HOME, ".claude", "skills", "meetey", "SKILL.md");
const KEYBINDINGS = join(HOME, ".claude", "keybindings.json");

mkdirSync(RECORDINGS_DIR, { recursive: true });

// --- State ---

let activeRecording = null; // { process, outputPath, sessionId, startedAt }
/// A recording whose process ended without being asked to — auto-stop, a crash,
/// or the app vanishing. Held so `stop_recording` can still hand back the files:
/// reporting "no active recording" would strand a perfectly good WAV that the
/// user has no other obvious way to reach.
let finishedRecording = null;

// --- Helpers ---

const APP_NAMES = {
  "com.google.Chrome": "Chrome",
  "us.zoom.xos": "Zoom",
  "com.microsoft.teams": "Teams",
};

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

function listDisplays() {
  if (!existsSync(CAPTURE_BINARY)) {
    return { error: `meetey-capture binary not found at ${CAPTURE_BINARY}. Run: npx jej2k5/meetey install` };
  }
  try {
    const displays = JSON.parse(runCaptureBinary(["--list-displays"]).trim());
    return { displays, message: displays.length === 1 ? "Only one display — no need to ask." : undefined };
  } catch (e) {
    return { error: e.message };
  }
}

function listWindows({ bundleID } = {}) {
  if (!existsSync(CAPTURE_BINARY)) {
    return { error: `meetey-capture binary not found at ${CAPTURE_BINARY}. Run: npx jej2k5/meetey install` };
  }
  try {
    const args = ["--list-windows"];
    if (bundleID) args.push("--app", bundleID);
    const windows = JSON.parse(runCaptureBinary(args).trim());
    if (windows.length === 0) {
      return { windows: [], message: "No capturable windows found for that app." };
    }
    return {
      windows,
      // ScreenCaptureKit works at the window level and has no concept of a tab.
      // Saying so here keeps the skill from implying a precision it cannot deliver.
      message:
        "Titles come from each window's active tab. A single Chrome tab cannot be " +
        "captured on its own — to isolate a meeting, drag its tab into its own window " +
        "and select that.",
    };
  } catch (e) {
    return { error: e.message };
  }
}

const watchContext = () => ({ meeteyDir: MEETEY_DIR, home: HOME });

function watcherStatus() {
  return watchStatus(watchContext());
}

function enableWatcher() {
  // process.execPath is the node running this server, which the installer
  // resolved absolutely when it registered us — safe to bake into the plist.
  return enableWatch({
    ...watchContext(),
    nodePath: process.execPath,
    captureBinary: CAPTURE_BINARY,
  });
}

function disableWatcher() {
  return disableWatch(watchContext());
}

function watcherLog({ lines = 40 } = {}) {
  return watchLog({ ...watchContext(), lines });
}

// Give a stopping capture time to finalize the WAV header, and — when video is
// on — to drain the encode queue and write the frame manifest.
function waitFor(ms, done) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function startRecording({
  bundleID,
  stopAfter,
  captureVideo = false,
  fps,
  maxFrames,
  sceneThreshold,
  displayID,
  windowID,
  autoStop = true,
  stopWhenCallEnds = true,
  menuBar = true,
  label,
}) {
  if (activeRecording) {
    return { error: "A recording is already active. Call stop_recording first." };
  }
  // Another process may hold one — the watch agent, or a different Claude Code
  // session. Recording the same meeting twice is worse than not starting.
  const elsewhere = readActive(MEETEY_DIR);
  if (elsewhere) {
    return {
      error:
        `A recording is already active (session ${elsewhere.sessionId}, started ` +
        `${elsewhere.startedBy === "watch" ? "by the watch agent" : "elsewhere"} ` +
        `at ${elsewhere.startedAt}). Call stop_recording first.`,
    };
  }
  if (!existsSync(CAPTURE_BINARY)) {
    return { error: `meetey-capture binary not found at ${CAPTURE_BINARY}. Run: npx jej2k5/meetey install` };
  }

  const id = sessionId();
  const outputPath = wavPath(id);
  const args = ["--app", bundleID, "--output", outputPath];
  if (stopAfter) args.push("--stop-after", String(stopAfter));

  // On by default. It only ends a recording on signals that cannot mean anything
  // else — the app quit, or the explicitly-chosen window closed — and the failure
  // it prevents (a recording left running for hours after everyone hung up) is
  // both common and costly.
  if (autoStop !== false) args.push("--auto-stop");

  // Ends the recording when the meeting app releases the microphone, cutting the
  // file back to when that happened. It never stops anything early: a candidate
  // end is only committed after a long quiet period, and only if the audio we
  // recorded confirms nobody was still talking.
  if (stopWhenCallEnds !== false) args.push("--stop-when-call-ends");

  // A menu bar item with a Stop Recording command. As much a standing "this is
  // recording" indicator as a control — every other signal Meetey gives is a
  // moment in time, and this one lasts the whole meeting.
  if (menuBar !== false) {
    args.push("--menu-bar", "--label", label || APP_NAMES[bundleID] || "Meeting");
  }

  // Video is opt-in per recording. There is deliberately no env var or config
  // file that can turn it on by default — it must be requested every time.
  const framesDir = captureVideo ? framesPath(id) : null;
  if (captureVideo) {
    args.push("--video", "--frames-dir", framesDir);
    if (fps) args.push("--fps", String(fps));
    if (maxFrames) args.push("--max-frames", String(maxFrames));
    if (sceneThreshold) args.push("--scene-threshold", String(sceneThreshold));
    // Source narrowing only means something when there is a frame to narrow, and
    // an audio-only recording keeps the filter the transcript path has always
    // used. Passing these without captureVideo would put audio at risk for a
    // capture that isn't happening.
    if (displayID !== undefined) args.push("--display", String(displayID));
    if (windowID !== undefined) args.push("--window", String(windowID));
  }

  const child = spawn(CAPTURE_BINARY, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });

  const recording = {
    process: child,
    outputPath,
    framesDir,
    sessionId: id,
    startedAt: new Date().toISOString(),
    autoStopReason: null,
  };

  child.stderr.on("data", (d) => {
    const text = d.toString();
    process.stderr.write(text);
    // The binary explains itself on the way out; keep the reason so the skill can
    // tell the user why a recording they didn't stop is no longer running.
    const reason = text.match(/auto-stop — (.+)/);
    if (reason) recording.autoStopReason = reason[1].trim();
  });

  child.on("exit", () => {
    if (activeRecording?.sessionId === id) {
      finishedRecording = { ...recording, process: null, stoppedAt: new Date().toISOString() };
      activeRecording = null;
      clearActive(MEETEY_DIR);
    }
  });

  activeRecording = recording;
  writeActive(MEETEY_DIR, {
    pid: child.pid,
    sessionId: id,
    outputPath,
    framesDir,
    startedAt: recording.startedAt,
    startedBy: "mcp",
    bundleID,
  });

  return {
    sessionId: id,
    outputPath,
    bundleID,
    capturingVideo: captureVideo,
    framesDir,
    displayID,
    windowID,
    startedAt: activeRecording.startedAt,
    message: captureVideo
      ? "Recording started with screen capture. Call stop_recording when the meeting ends."
      : "Recording started (audio only). Call stop_recording when the meeting ends.",
  };
}

function stopRecording() {
  if (!activeRecording) {
    // Owned by another process — the watch agent, or a second Claude Code
    // session. We have a pid rather than a child handle, but SIGTERM is SIGTERM.
    const elsewhere = readActive(MEETEY_DIR);
    if (elsewhere) {
      try {
        process.kill(elsewhere.pid, "SIGTERM");
      } catch {
        // Gone between the liveness check and here. The files are still on disk.
      }
      waitFor(3000, () => existsSync(elsewhere.outputPath));
      if (elsewhere.framesDir) {
        waitFor(10000, () => existsSync(join(elsewhere.framesDir, "index.json")));
      }
      clearActive(MEETEY_DIR);
      const result = buildStopResult(elsewhere, {
        autoStopped: false,
        stoppedAt: new Date().toISOString(),
      });
      if (elsewhere.startedBy === "watch") {
        result.startedBy = "watch";
        result.windowTitle = elsewhere.windowTitle;
      }
      return result;
    }

    // Already over — the process ended on its own, so there is nothing to
    // signal. Hand back what it left behind.
    if (!finishedRecording) return { error: "No active recording." };
    const done = finishedRecording;
    finishedRecording = null;
    return buildStopResult(done, { autoStopped: true, stoppedAt: done.stoppedAt });
  }

  const recording = activeRecording;
  const { process: child, outputPath, framesDir } = recording;

  child.kill("SIGTERM");
  activeRecording = null;
  // This stop supersedes anything held from an earlier self-terminated run.
  finishedRecording = null;
  clearActive(MEETEY_DIR);

  waitFor(3000, () => existsSync(outputPath));
  if (framesDir) waitFor(10000, () => existsSync(join(framesDir, "index.json")));

  return buildStopResult(recording, { autoStopped: false, stoppedAt: new Date().toISOString() });
}

function buildStopResult(recording, { autoStopped, stoppedAt }) {
  const { outputPath, framesDir, sessionId: id, startedAt, autoStopReason } = recording;

  const result = {
    sessionId: id,
    outputPath,
    startedAt,
    stoppedAt,
    message: `Recording saved to ${outputPath}. Call transcribe with this path.`,
  };

  if (autoStopped) {
    result.autoStopped = true;
    result.autoStopReason = autoStopReason;
    result.message = autoStopReason
      ? `Recording already stopped on its own — ${autoStopReason}. Saved to ${outputPath}. Call transcribe with this path.`
      : `Recording already stopped on its own. Saved to ${outputPath}. Call transcribe with this path.`;
  }

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
    const jsonPath = filePath.replace(/\.wav$/, ".wav.json");

    // The watch agent transcribes as soon as a recording ends, so by the time
    // anyone asks the work is usually already done. Re-running whisper on an
    // hour of audio to produce a byte-identical result is minutes wasted.
    const cached = existsSync(jsonPath) &&
      statSync(jsonPath).mtimeMs >= statSync(filePath).mtimeMs;

    if (!cached) {
      execFileSync("whisper-cli", [
        "-f", filePath,
        "-m", MODEL_PATH,
        "-l", "en",
        "--output-json",
        "--no-prints",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    }
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

    // Duration comes from the WAV header rather than the start/stop wall-clock
    // pair, which includes process spin-up and the SIGTERM drain.
    const durationMs = wavDurationMs(filePath);

    return {
      transcript,
      segments,
      jsonPath,
      model: basename(MODEL_PATH),
      durationMs,
      durationLabel: formatDuration(durationMs),
      quality: assessQuality(segments, durationMs),
    };
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
    const elsewhere = readActive(MEETEY_DIR);
    if (elsewhere) {
      return {
        active: true,
        sessionId: elsewhere.sessionId,
        outputPath: elsewhere.outputPath,
        capturingVideo: elsewhere.framesDir !== null,
        framesDir: elsewhere.framesDir,
        startedAt: elsewhere.startedAt,
        startedBy: elsewhere.startedBy,
        windowTitle: elsewhere.windowTitle,
        message:
          elsewhere.startedBy === "watch"
            ? "Started by the watch agent. stop_recording will stop it from here."
            : "Started by another Claude Code session. stop_recording will stop it from here.",
      };
    }
    if (finishedRecording) {
      return {
        active: false,
        autoStopped: true,
        sessionId: finishedRecording.sessionId,
        outputPath: finishedRecording.outputPath,
        framesDir: finishedRecording.framesDir,
        startedAt: finishedRecording.startedAt,
        stoppedAt: finishedRecording.stoppedAt,
        autoStopReason: finishedRecording.autoStopReason,
        message:
          "The recording stopped on its own and has not been transcribed yet. " +
          "Call stop_recording to collect it.",
      };
    }
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

// --- Admin handlers ---

function adminList(args = {}) {
  return listRecordings(RECORDINGS_DIR, args);
}

function adminGet(args = {}) {
  if (!args.sessionId && !args.date) {
    return { error: "Provide either sessionId or date (YYYY-MM-DD)." };
  }
  return getRecording(RECORDINGS_DIR, args);
}

function adminSearch(args = {}) {
  return searchRecordings(RECORDINGS_DIR, args.query, {
    limit: args.limit,
    scope: args.scope,
  });
}

function adminDelete(args = {}) {
  if (!args.sessionId) return { error: "Provide a sessionId." };
  if (activeRecording?.sessionId === args.sessionId) {
    return { error: "That recording is still active. Call stop_recording first." };
  }
  return deleteRecording(RECORDINGS_DIR, args);
}

function adminStatus() {
  return systemStatus({
    recordingsDir: RECORDINGS_DIR,
    captureBinary: CAPTURE_BINARY,
    modelPath: MODEL_PATH,
    claudeJsonPath: CLAUDE_JSON,
    skillPath: SKILL_PATH,
    keybindingsPath: KEYBINDINGS,
    activeRecording: activeRecording
      ? {
          sessionId: activeRecording.sessionId,
          startedAt: activeRecording.startedAt,
          capturingVideo: activeRecording.framesDir !== null,
        }
      : null,
  });
}

// --- MCP server ---

const server = new Server(
  { name: "meetey", version: "1.3.0" },
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
      name: "list_displays",
      description:
        "List attached displays. Only worth asking the user about when more than one is returned; " +
        "otherwise start_recording picks the display showing the target app.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_windows",
      description:
        "List the capturable windows of a meeting app, with the title of each. Use this to let the " +
        "user narrow screen capture to just the meeting window, which excludes the app's other " +
        "windows and its notification banners. ScreenCaptureKit cannot capture an individual " +
        "browser tab — window is the finest available granularity.",
      inputSchema: {
        type: "object",
        properties: {
          bundleID: {
            type: "string",
            description: "Restrict to one app. Omit to list windows of all supported apps.",
          },
        },
      },
    },
    {
      name: "watcher_status",
      description:
        "Is the meeting watcher on? The watcher is an optional background agent that notices " +
        "meetings in Chrome, Zoom, and Teams and asks before recording them. Off by default.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "enable_watcher",
      description:
        "Turn the meeting watcher on. It installs a login agent that persists across restarts " +
        "until disabled, so only call this when the user has actually asked for it — never to " +
        "be helpful after a missed recording. It records audio only, and always asks first.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "disable_watcher",
      description:
        "Turn the meeting watcher off. Does not stop a recording already in progress.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "watcher_log",
      description:
        "Recent watcher activity — what it noticed, what was recorded, what was declined. " +
        "The place to look when the watcher is on but never seems to ask.",
      inputSchema: {
        type: "object",
        properties: {
          lines: { type: "number", description: "How many recent lines (default 40)." },
        },
      },
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
          menuBar: {
            type: "boolean",
            description:
              "Show a menu bar indicator while recording, with a Stop Recording item (default " +
              "true). It is also the only continuously visible sign that recording is happening, " +
              "so leave it on unless the user asks otherwise.",
          },
          label: {
            type: "string",
            description:
              "What to call this recording in the menu bar — pass the window title from " +
              "list_windows when the user picked one. Falls back to the app name.",
          },
          stopWhenCallEnds: {
            type: "boolean",
            description:
              "End the recording when the meeting app releases the microphone, trimming it back " +
              "to that moment (default true). Waits 10 minutes and cross-checks the recorded " +
              "audio before acting, so a live meeting is not cut short. Has no effect on a " +
              "recording where no app ever used the microphone.",
          },
          autoStop: {
            type: "boolean",
            description:
              "End the recording by itself when the app quits, or when the window given as " +
              "windowID closes (default true, after a 30s grace period). It never tries to " +
              "infer that a call ended while the app is still running. Pass false to require " +
              "an explicit stop_recording.",
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
          sceneThreshold: {
            type: "number",
            description:
              "Grid cells (of 1024) that must change before a screen counts as different " +
              "(default 12). Raise it if a session produced too many near-identical keyframes.",
          },
          displayID: {
            type: "number",
            description:
              "Display to capture, from list_displays. Ignored unless captureVideo is on. " +
              "Defaults to the display showing the target app, so this is only needed to " +
              "override that.",
          },
          windowID: {
            type: "number",
            description:
              "Capture only this window of the app, from list_windows. Ignored unless " +
              "captureVideo is on. Keeps the app's other windows and its notification " +
              "banners out of frame entirely. Cannot select a browser tab — see list_windows.",
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
        "transcript, timestamped segments, exact recording duration, the model used, " +
        "and a deterministic quality assessment of the transcript.",
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
        "offsets, and locally-recognized text (OCR) for each. A frame may also carry " +
        "revisitsMs — later offsets at which that same screen came back, recorded instead " +
        "of storing a duplicate image. Only available when the recording was started " +
        "with captureVideo.",
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
    {
      name: "list_recordings",
      description:
        "Browse the meeting library: every past recording with its title, date, duration, " +
        "transcript quality, keyframe count, and disk size. Newest first. Use this to answer " +
        "'what meetings do I have' or to find a session ID for the other admin tools.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "string", description: "Only recordings on or after this date (YYYY-MM-DD)." },
          until: { type: "string", description: "Only recordings on or before this date (YYYY-MM-DD)." },
          hasVideo: { type: "boolean", description: "Filter to recordings with (true) or without (false) screen capture." },
          quality: {
            type: "string",
            enum: ["good", "fair", "poor", "unusable"],
            description: "Only recordings whose transcript scored this quality level.",
          },
          limit: { type: "number", description: "Return at most this many (still reports the full match count)." },
        },
      },
    },
    {
      name: "get_recording",
      description:
        "Full detail for one recording, including the complete notes markdown and the paths " +
        "to its audio, transcript, and keyframes. Identify it by sessionId, or by date when " +
        "there was only one meeting that day.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "e.g. meetey-1754049600000" },
          date: { type: "string", description: "YYYY-MM-DD, when the session ID isn't known." },
        },
      },
    },
    {
      name: "search_recordings",
      description:
        "Search across every meeting's notes and transcripts. Returns the matching line with " +
        "its [mm:ss] offset where there is one, so you land on the moment rather than just the " +
        "meeting. Use this for questions like 'what did we decide about the API cutover'.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Text to find (case-insensitive)." },
          scope: {
            type: "string",
            enum: ["all", "notes", "transcripts"],
            description: "Where to look. Default all. 'notes' is decisions and action items only.",
          },
          limit: { type: "number", description: "Max matches to return (default 40)." },
        },
      },
    },
    {
      name: "delete_recording",
      description:
        "Permanently delete a recording's audio, keyframes, notes, and transcript. Describes " +
        "what it would remove and deletes nothing unless confirm is true — always show the user " +
        "that list and get their agreement before confirming.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string", description: "Session to delete." },
          confirm: { type: "boolean", description: "Must be true to actually delete. Omit for a dry run." },
          keepNotes: { type: "boolean", description: "Delete the audio and keyframes but keep the notes and transcript." },
        },
      },
    },
    {
      name: "system_status",
      description:
        "Health of the whole install: capture binary and its signature, whisper-cli, the model, " +
        "MCP registration, skill, hotkeys, Screen Recording permission, plus disk used by the " +
        "library. Use this first when anything isn't working.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  let result;
  switch (name) {
    case "list_apps":      result = listApps(); break;
    case "list_displays":  result = listDisplays(); break;
    case "watcher_status": result = watcherStatus(); break;
    case "enable_watcher": result = enableWatcher(); break;
    case "disable_watcher": result = disableWatcher(); break;
    case "watcher_log":    result = watcherLog(args ?? {}); break;
    case "list_windows":   result = listWindows(args ?? {}); break;
    case "start_recording": result = startRecording(args); break;
    case "stop_recording":  result = stopRecording(); break;
    case "transcribe":      result = transcribe(args); break;
    case "get_keyframes":   result = getKeyframes(args); break;
    case "get_status":      result = getStatus(); break;
    case "list_recordings":   result = adminList(args); break;
    case "get_recording":     result = adminGet(args); break;
    case "search_recordings": result = adminSearch(args); break;
    case "delete_recording":  result = adminDelete(args); break;
    case "system_status":     result = adminStatus(); break;
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
