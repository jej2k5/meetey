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
 * The watch agent: notices a meeting, asks whether to record it, and records it
 * if told to.
 *
 * It never starts a recording on its own. Every recording this agent produces
 * was authorised by someone choosing a capture mode in a dialog naming the
 * specific window — which is what makes it safe for detection to be imperfect. A
 * false positive costs one dismissed dialog; the human is the adjudicator, not
 * the pattern list.
 *
 * Screen capture is offered here rather than withheld. The agent proposes; the
 * person decides, in the same breath as authorising the audio. Withholding the
 * option did not make anything safer — it just meant a meeting worth capturing
 * visually could not be, without abandoning the prompt and starting over.
 *
 * Run by launchd as a LaunchAgent (see `meetey watch enable`), which is a user
 * session agent rather than a system daemon — `display dialog` needs a GUI
 * session, and this must never run for a user who is not logged in.
 */

import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { readActive, writeActive, clearActive, writePending, activeStatePath } from "../mcp-server/session-state.js";
import { writeHealth, watchPaths } from "../mcp-server/watch-agent.js";
import { resolveWhisper } from "../mcp-server/whisper.js";
import { writeSessionTranscript } from "../mcp-server/transcript.js";

const HOME = homedir();
const MEETEY_DIR = process.env.MEETEY_HOME ?? join(HOME, ".meetey");
const RECORDINGS_DIR = process.env.MEETEY_OUTPUT_DIR ?? join(MEETEY_DIR, "recordings");
const MODEL_PATH = process.env.MEETEY_MODEL ?? join(MEETEY_DIR, "models", "ggml-base.en.bin");

const scriptDir = new URL(".", import.meta.url).pathname;
const CAPTURE_BINARY = process.env.MEETEY_BINARY ??
  resolve(scriptDir, "../meetey-capture/.build/release/meetey-capture");

const POLL_MS = Number(process.env.MEETEY_WATCH_POLL_MS ?? 10_000);
/** How long a dialog waits before giving up, so an away-from-desk user isn't
 *  ambushed by a stale prompt when they come back. */
const PROMPT_TIMEOUT_S = 120;

/**
 * Windows that look like a live meeting.
 *
 * Deliberately generous. Missing a meeting means the user never gets asked and
 * loses the recording entirely; over-matching means one dialog they dismiss.
 * The confirmation is what lets these stay loose — do not "tighten" them into
 * silence.
 */
const MEETING_PATTERNS = [
  { bundleID: "com.google.Chrome", test: (t) => /google meet|^meet\s*[–—-]|zoom\.us\/(j|wc)\/|teams\.microsoft\.com|whereby|meet\.jit\.si/i.test(t) },
  { bundleID: "us.zoom.xos", test: (t) => /zoom (meeting|webinar)/i.test(t) },
  { bundleID: "com.microsoft.teams", test: (t) => /meeting|\bcall\b/i.test(t) },
];

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const healthCtx = { meeteyDir: MEETEY_DIR, home: HOME };

/**
 * Windows already skipped, so the agent asks once and then stays quiet.
 *
 * Persisted because launchd restarts this process on crash, logout, and reboot,
 * and an in-memory set means a meeting you already declined gets re-offered
 * partway through.
 */
const DECLINED_PATH = join(MEETEY_DIR, "state", "watch-declined.json");

function loadDeclined() {
  try {
    return new Set(JSON.parse(readFileSync(DECLINED_PATH, "utf8")));
  } catch {
    return new Set();
  }
}

function saveDeclined() {
  try {
    mkdirSync(dirname(DECLINED_PATH), { recursive: true });
    writeFileSync(DECLINED_PATH, JSON.stringify([...declined]) + "\n");
  } catch {
    // Losing this costs one redundant prompt, never a recording.
  }
}

const declined = loadDeclined();
/** True while a dialog is on screen — polling must not stack prompts. */
let prompting = false;
/** The capture this agent started, if any. Held so shutdown can end it properly. */
let activeCapture = null;

function listWindows() {
  if (!existsSync(CAPTURE_BINARY)) return [];
  try {
    const out = execFileSync(CAPTURE_BINARY, ["--list-windows"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const windows = JSON.parse(out.trim());
    writeHealth(healthCtx, { at: new Date().toISOString(), canSeeWindows: true, windowCount: windows.length });
    return windows;
  } catch (e) {
    // Screen Recording permission not granted yet, or the binary is mid-rebuild.
    // Either way this is a transient condition, not a reason to exit — launchd
    // would just restart us into the same state.
    //
    // But it must not be silent: this is the failure that makes a freshly
    // enabled watcher look like it simply never sees a meeting.
    const detail = (e.stderr?.toString() || e.message || "").split("\n")[0];
    writeHealth(healthCtx, { at: new Date().toISOString(), canSeeWindows: false, error: detail });
    log(`could not list windows: ${detail}`);
    return [];
  }
}

export function findMeeting(windows) {
  for (const window of windows) {
    if (!window.isOnScreen) continue;
    const pattern = MEETING_PATTERNS.find((p) => p.bundleID === window.bundleID);
    if (pattern?.test(window.title ?? "")) return window;
  }
  return null;
}

/** Identity that survives a title changing mid-meeting (participants joining). */
const keyFor = (window) => `${window.bundleID}:${window.windowID}`;

function escapeAppleScript(text) {
  return text.replace(/[\\"]/g, (c) => `\\${c}`);
}

const APP_NAMES = {
  "com.google.Chrome": "Chrome",
  "us.zoom.xos": "Zoom",
  "com.microsoft.teams": "Teams",
};

export const DECLINE = "Skip";
export const AUDIO_ONLY = "Audio only";
export const AUDIO_AND_SCREEN = "Audio + screen";

/**
 * Reads the chosen mode out of osascript's reply.
 *
 * Exact string comparison rather than a regex: the "+" in "Audio + screen" is a
 * regex metacharacter, and a pattern that silently fails to match would start an
 * audio-only recording for someone who asked for their screen.
 *
 * Returns "audio", "screen", or null for declined / timed out / dismissed.
 */
export function parseDialogChoice(output) {
  // Timing out is not consent.
  if (/gave up:true/.test(output)) return null;
  const match = output.match(/button returned:([^,\n]*)/);
  const choice = match ? match[1].trim() : "";
  if (choice === AUDIO_ONLY) return "audio";
  if (choice === AUDIO_AND_SCREEN) return "screen";
  return null;
}

function askToRecord(window) {
  const app = APP_NAMES[window.bundleID] ?? "a meeting app";
  const title = (window.title ?? "").slice(0, 90);
  const message =
    `Meetey noticed a meeting in ${app}:\n\n${title}\n\n` +
    `Record it? "${AUDIO_AND_SCREEN}" captures only this window. It stops on ` +
    `its own when the call ends; run /meetey stop in Claude Code to write up ` +
    `the notes.`;

  // The default is the *safe* option, not the affirmative one. This alert
  // appears unprompted and can take focus mid-call, so an absent-minded Return
  // must not start recording a room full of people. Having a default at all
  // matters for keyboard users: without one no button holds focus, which can
  // leave the affirmative choices mouse-only when Full Keyboard Access is off.
  // It sits leftmost against the usual "default is rightmost" convention —
  // deliberate, because declining is the safe direction here.
  const script =
    `display dialog "${escapeAppleScript(message)}" ` +
    `buttons {"${DECLINE}", "${AUDIO_AND_SCREEN}", "${AUDIO_ONLY}"} ` +
    `default button "${DECLINE}" ` +
    `with title "Meetey" with icon note giving up after ${PROMPT_TIMEOUT_S}`;

  try {
    return parseDialogChoice(execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: (PROMPT_TIMEOUT_S + 15) * 1000,
    }));
  } catch {
    // Non-zero means the user hit Escape, or no GUI session is available.
    return null;
  }
}

function transcribeInBackground(wavPath) {
  if (!existsSync(MODEL_PATH)) {
    log("whisper model missing — leaving the WAV untranscribed");
    return;
  }
  const whisper = resolveWhisper();
  if (!whisper) {
    // Was ENOENT every time before this: launchd gives a job a minimal PATH with
    // no Homebrew in it, so a bare `whisper-cli` never resolved here even though
    // the identical call worked from Claude Code.
    log("whisper-cli not found — leaving the WAV for /meetey stop to transcribe");
    return;
  }
  log(`transcribing ${wavPath}`);

  // spawn, not execFileSync. Whisper on an hour of audio runs for minutes, and a
  // synchronous call blocks Node's event loop for all of it — the poll never
  // fires, so a meeting starting right after one ends is missed entirely. Two
  // calls back to back is the ordinary case, not an edge case.
  const child = spawn(whisper, [
    "-f", wavPath,
    "-m", MODEL_PATH,
    "-l", "en",
    "--output-json",
    "--no-prints",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  child.on("exit", (code) => {
    if (code !== 0) {
      log(`transcription failed (exit ${code})`);
      return;
    }
    // Turn it into something readable straight away. Notes need Claude; a
    // transcript does not, and leaving the meeting as a JSON blob until someone
    // opens an editor is how a recording ends up never being read at all.
    const result = writeSessionTranscript({
      recordingsDir: RECORDINGS_DIR,
      sessionId: basename(wavPath, ".wav"),
      jsonPath: `${wavPath}.json`,
    });
    log(result.written
      ? `transcript ready: ${result.path} (${result.segments} segments)`
      : `transcription ready but no transcript written: ${result.reason}`);
  });
  child.on("error", (e) => log(`transcription failed: ${e.message.split("\n")[0]}`));
}

function startRecording(window, mode) {
  const sessionId = `meetey-${Date.now()}`;
  const outputPath = join(RECORDINGS_DIR, `${sessionId}.wav`);
  const framesDir = mode === "screen" ? join(RECORDINGS_DIR, `${sessionId}-frames`) : null;
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  // Screen capture is still consented to per recording — the agent offers, the
  // person chooses, in the same dialog that authorises the audio. And it scopes
  // to the window the watcher actually detected, which is narrower than what
  // /meetey start captures by default.
  const args = [
    "--app", window.bundleID,
    "--output", outputPath,
    "--auto-stop",
    // Matters more here than anywhere: nobody is watching a recording the agent
    // started, so without this it runs until the app quits — which for Chrome
    // could be days.
    "--stop-when-call-ends",
    // And a recording nobody explicitly started is exactly the one that most
    // needs a visible indicator and a way to stop it without hunting for a
    // terminal.
    "--menu-bar", "--label", (window.title ?? "Meeting").slice(0, 60),
  ];

  if (framesDir) {
    args.push("--video", "--frames-dir", framesDir, "--window", String(window.windowID));
  }

  const child = spawn(CAPTURE_BINARY, args, { stdio: ["ignore", "ignore", "pipe"] });
  activeCapture = child;

  let autoStopReason = null;
  let confirmedStart = false;
  child.stderr.on("data", (d) => {
    const text = d.toString();
    process.stderr.write(text);
    if (/recording started/.test(text)) confirmedStart = true;
    const reason = text.match(/auto-stop — (.+)/);
    if (reason) autoStopReason = reason[1].trim();
    if (/call ended — trimming/.test(text)) autoStopReason = "the call ended";
  });

  // A spawn failure emits `error`, never `exit`. Without a listener that is an
  // unhandled error event, which would take the whole agent down.
  child.on("error", (e) => {
    activeCapture = null;
    clearActive(MEETEY_DIR);
    log(`capture failed to start: ${e.message.split("\n")[0]}`);
  });

  // Capture opens the stream and only then writes anything. If it never gets
  // that far it can sit holding the active-recording lock indefinitely, and the
  // log looks identical to a healthy recording — which is exactly how a silent
  // 35-minute non-recording goes unnoticed.
  setTimeout(() => {
    if (!confirmedStart && activeCapture === child) {
      log(`WARNING: ${sessionId} has not started capturing after 30s — it may be stuck in setup`);
    }
  }, 30_000).unref?.();

  const startedAt = new Date().toISOString();
  writeActive(MEETEY_DIR, {
    pid: child.pid,
    sessionId,
    outputPath,
    // Must be the real path, not null: stop_recording reads this to find the
    // keyframe manifest, so a wrong value here loses the screen content.
    framesDir,
    startedAt,
    startedBy: "watch",
    windowTitle: window.title ?? "",
    bundleID: window.bundleID,
  });
  log(`recording ${sessionId} (${mode === "screen" ? "audio + screen" : "audio"}) — ${window.title}`);

  child.on("exit", (code, signal) => {
    activeCapture = null;
    clearActive(MEETEY_DIR);
    // Say how it ended. "ended" alone reads the same whether it recorded an hour
    // or died during setup, which makes a failure indistinguishable from success.
    const how = signal ? `killed by ${signal}` : code === 0 ? "cleanly" : `exit ${code}`;
    log(`recording ${sessionId} ended (${how}${confirmedStart ? "" : ", never started capturing"})`);

    if (!existsSync(outputPath)) {
      log(`no audio file at ${outputPath} — nothing to transcribe`);
      return;
    }

    // Leave a record for /meetey stop to collect. Clearing the active state is
    // right — nothing is recording any more — but this recording ended in a
    // different process from the MCP server, so without this there is nothing
    // for the user to pick up, and the notification we just showed them told
    // them to go pick it up.
    writePending(MEETEY_DIR, {
      sessionId,
      outputPath,
      framesDir,
      startedAt,
      stoppedAt: new Date().toISOString(),
      startedBy: "watch",
      windowTitle: window.title ?? "",
      autoStopReason,
    });

    transcribeInBackground(outputPath);
  });
}

async function tick() {
  if (prompting) return;

  // Listed before the active-recording check so health keeps being reported
  // during a recording — otherwise `enable` run mid-recording waits for a
  // verdict that never comes.
  const windows = listWindows();

  // Someone is already recording — this agent, or a /meetey start in an open
  // Claude Code session. Two captures of one meeting is worse than none.
  if (readActive(MEETEY_DIR)) return;

  const meeting = findMeeting(windows);

  // Forget declines for windows that are gone, so the next meeting in a reused
  // window asks again.
  const live = new Set(windows.map(keyFor));
  let pruned = false;
  for (const key of declined) if (!live.has(key)) { declined.delete(key); pruned = true; }
  if (pruned) saveDeclined();

  if (!meeting || declined.has(keyFor(meeting))) return;

  prompting = true;
  try {
    const mode = askToRecord(meeting);
    if (mode) {
      startRecording(meeting, mode);
    } else {
      declined.add(keyFor(meeting));
      saveDeclined();
      log(`skipped — ${meeting.title}`);
    }
  } finally {
    prompting = false;
  }
}

/**
 * Detection is the part most likely to need tuning against real meetings, so it
 * is exercisable without one. `node watch.js --selftest`.
 */
function selfTest() {
  const w = (bundleID, title, extra = {}) =>
    ({ bundleID, title, windowID: 1, isOnScreen: true, ...extra });

  const shouldMatch = [
    w("com.google.Chrome", "Weekly Sync - Google Meet"),
    w("com.google.Chrome", "Meet – abc-defg-hij"),
    w("com.google.Chrome", "Launch review | Microsoft Teams — teams.microsoft.com"),
    w("us.zoom.xos", "Zoom Meeting"),
    w("us.zoom.xos", "Zoom Webinar"),
    w("com.microsoft.teams", "Standup | Meeting"),
  ];
  const shouldNotMatch = [
    w("com.google.Chrome", "Inbox (48) - Gmail"),
    w("com.google.Chrome", "meetey/README.md at main"),
    w("us.zoom.xos", "Zoom"),                    // the idle app window, not a call
    w("com.apple.Safari", "Zoom Meeting"),       // unsupported app
    w("com.google.Chrome", "Google Meet", { isOnScreen: false }), // minimised
  ];

  const failures = [];
  for (const window of shouldMatch) {
    if (!findMeeting([window])) failures.push(`missed: ${window.bundleID} "${window.title}"`);
  }
  for (const window of shouldNotMatch) {
    if (findMeeting([window])) failures.push(`false positive: ${window.bundleID} "${window.title}"`);
  }
  // The first on-screen match wins, so an unrelated window must not shadow one.
  const mixed = [w("com.google.Chrome", "Inbox (48) - Gmail"), w("us.zoom.xos", "Zoom Meeting")];
  if (findMeeting(mixed)?.bundleID !== "us.zoom.xos") {
    failures.push("did not find a meeting behind an unrelated window");
  }

  // Choice parsing. Getting this wrong records the wrong thing silently — the
  // "+" in "Audio + screen" is a regex metacharacter, so a pattern-based reader
  // would quietly fall through to audio for someone who asked for their screen.
  const choices = [
    [`button returned:${AUDIO_ONLY}, gave up:false`, "audio"],
    [`button returned:${AUDIO_AND_SCREEN}, gave up:false`, "screen"],
    [`button returned:${DECLINE}, gave up:false`, null],
    // A timeout names the default button; it is still not consent.
    [`button returned:${DECLINE}, gave up:true`, null],
    [`button returned:${AUDIO_AND_SCREEN}, gave up:true`, null],
    ["", null],
    ["something unexpected", null],
  ];
  for (const [output, expected] of choices) {
    const got = parseDialogChoice(output);
    if (got !== expected) {
      failures.push(`choice "${output}" parsed as ${got}, expected ${expected}`);
    }
  }

  if (failures.length === 0) {
    console.log(`selftest: PASS (${shouldMatch.length} matched, ${shouldNotMatch.length} correctly ignored, ${choices.length} dialog choices parsed)`);
    process.exit(0);
  }
  for (const f of failures) console.error(`selftest: FAIL — ${f}`);
  process.exit(1);
}

if (process.argv.includes("--selftest")) {
  selfTest();
} else {
  /**
 * The agent's menu bar presence, for exactly as long as the agent runs.
 *
 * A separate process because a status item needs AppKit, which Node has no
 * access to — meetey-capture already owns that code. It is subordinate: if it
 * fails to start or dies, the watcher carries on regardless. An indicator that
 * could take the watcher down would be worse than no indicator.
 */
function startIndicator() {
  if (!existsSync(CAPTURE_BINARY)) return null;
  const { plistPath } = watchPaths(healthCtx);
  const child = spawn(CAPTURE_BINARY, [
    "--watch-indicator",
    "--state-file", activeStatePath(MEETEY_DIR),
    "--plist", plistPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("error", (e) => log(`indicator failed to start: ${e.message.split("\n")[0]}`));
  return child;
}

log(`meetey watch started (poll ${POLL_MS}ms)`);
const indicator = startIndicator();
  // A recording is stopped by the meeting ending, never by the agent exiting.
  process.on("SIGTERM", () => {
  log("meetey watch stopping");
  // The indicator means "the watcher is running", so it must not outlive it.
  try { indicator?.kill("SIGTERM"); } catch { /* already gone */ }

  // A recording in flight has to be ended properly, not abandoned.
  //
  // `launchctl bootout` tears down the whole job, and the capture process is in
  // this process group, so it dies with us — mid-write, with no pending record
  // and nothing queued to transcribe. The audio is the one irreplaceable thing
  // here, so shutdown waits for the capture to finalize its WAV before exiting.
  if (activeCapture) {
    log("stopping the recording in progress before exiting");
    try { activeCapture.kill("SIGTERM"); } catch { /* already gone */ }
    activeCapture.once("exit", () => {
      log("recording finalized; exiting");
      process.exit(0);
    });
    // launchd escalates to SIGKILL after its own grace period; leaving early
    // would defeat the point, but hanging forever would too.
    setTimeout(() => {
      log("capture did not exit in time; exiting anyway");
      process.exit(0);
    }, 15_000);
    return;
  }

  process.exit(0);
});
  setInterval(() => { tick().catch((e) => log(`tick failed: ${e.message}`)); }, POLL_MS);
  tick().catch((e) => log(`tick failed: ${e.message}`));
}
