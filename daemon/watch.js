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
 * was authorised by someone clicking "Record" in a dialog naming the specific
 * window — which is what makes it safe for detection to be imperfect. A false
 * positive costs one dismissed dialog; the human is the adjudicator, not the
 * pattern list.
 *
 * Run by launchd as a LaunchAgent (see `meetey watch enable`), which is a user
 * session agent rather than a system daemon — `display dialog` needs a GUI
 * session, and this must never run for a user who is not logged in.
 */

import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { readActive, writeActive, clearActive } from "../mcp-server/session-state.js";

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

/** Windows currently declined, so the agent asks once and then stays quiet. */
const declined = new Set();
/** True while a dialog is on screen — polling must not stack prompts. */
let prompting = false;

function listWindows() {
  if (!existsSync(CAPTURE_BINARY)) return [];
  try {
    const out = execFileSync(CAPTURE_BINARY, ["--list-windows"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim());
  } catch (e) {
    // Screen Recording permission not granted yet, or the binary is mid-rebuild.
    // Either way this is a transient condition, not a reason to exit — launchd
    // would just restart us into the same state.
    log(`could not list windows: ${e.message.split("\n")[0]}`);
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

/**
 * A real modal with buttons, from a plain CLI. Notification *action buttons*
 * need a signed .app bundle; `display dialog` does not.
 */
function askToRecord(window) {
  const title = (window.title ?? "").slice(0, 120);
  const message =
    `Meetey noticed a meeting:\n\n${title}\n\n` +
    `Record it? Audio only — screen content is never captured without a separate prompt.`;

  const script =
    `display dialog "${escapeAppleScript(message)}" ` +
    `buttons {"Not now", "Record"} default button "Record" ` +
    `with title "Meetey" with icon note giving up after ${PROMPT_TIMEOUT_S}`;

  try {
    const out = execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: (PROMPT_TIMEOUT_S + 15) * 1000,
    });
    // Timing out is not consent. `giving up after` returns gave up:true with the
    // default button still named, so it has to be checked before the button.
    if (/gave up:true/.test(out)) return false;
    return /button returned:Record/.test(out);
  } catch {
    // Non-zero means the user hit Escape, or no GUI session is available.
    return false;
  }
}

function transcribeInBackground(wavPath) {
  if (!existsSync(MODEL_PATH)) {
    log("whisper model missing — leaving the WAV untranscribed");
    return;
  }
  log(`transcribing ${wavPath}`);
  try {
    // Produces <wav>.json, which the MCP server's `transcribe` reuses rather
    // than re-running whisper. The expensive part is done before anyone asks.
    execFileSync("whisper-cli", [
      "-f", wavPath,
      "-m", MODEL_PATH,
      "-l", "en",
      "--output-json",
      "--no-prints",
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 60 * 60 * 1000 });
    log("transcription ready");
  } catch (e) {
    log(`transcription failed: ${e.message.split("\n")[0]}`);
  }
}

function startRecording(window) {
  const sessionId = `meetey-${Date.now()}`;
  const outputPath = join(RECORDINGS_DIR, `${sessionId}.wav`);
  mkdirSync(RECORDINGS_DIR, { recursive: true });

  // Audio only, always. Screen capture stays opt-in per recording through the
  // skill, which asks its own question — an agent must not be the thing that
  // decides to start capturing someone's screen.
  const args = [
    "--app", window.bundleID,
    "--output", outputPath,
    "--auto-stop",
  ];

  const child = spawn(CAPTURE_BINARY, args, { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(d));

  writeActive(MEETEY_DIR, {
    pid: child.pid,
    sessionId,
    outputPath,
    framesDir: null,
    startedAt: new Date().toISOString(),
    startedBy: "watch",
    windowTitle: window.title ?? "",
    bundleID: window.bundleID,
  });
  log(`recording ${sessionId} — ${window.title}`);

  child.on("exit", () => {
    clearActive(MEETEY_DIR);
    log(`recording ${sessionId} ended`);
    if (existsSync(outputPath)) transcribeInBackground(outputPath);
  });
}

async function tick() {
  if (prompting) return;

  // Someone is already recording — this agent, or a /meetey start in an open
  // Claude Code session. Two captures of one meeting is worse than none.
  if (readActive(MEETEY_DIR)) return;

  const windows = listWindows();
  const meeting = findMeeting(windows);

  // Forget declines for windows that are gone, so the next meeting in a reused
  // window asks again.
  const live = new Set(windows.map(keyFor));
  for (const key of declined) if (!live.has(key)) declined.delete(key);

  if (!meeting || declined.has(keyFor(meeting))) return;

  prompting = true;
  try {
    if (askToRecord(meeting)) {
      startRecording(meeting);
    } else {
      declined.add(keyFor(meeting));
      log(`declined — ${meeting.title}`);
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

  if (failures.length === 0) {
    console.log(`selftest: PASS (${shouldMatch.length} matched, ${shouldNotMatch.length} correctly ignored)`);
    process.exit(0);
  }
  for (const f of failures) console.error(`selftest: FAIL — ${f}`);
  process.exit(1);
}

if (process.argv.includes("--selftest")) {
  selfTest();
} else {
  log(`meetey watch started (poll ${POLL_MS}ms)`);
  // A recording is stopped by the meeting ending, never by the agent exiting.
  process.on("SIGTERM", () => { log("meetey watch stopping"); process.exit(0); });
  setInterval(() => { tick().catch((e) => log(`tick failed: ${e.message}`)); }, POLL_MS);
  tick().catch((e) => log(`tick failed: ${e.message}`));
}
