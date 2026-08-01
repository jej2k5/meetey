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

import { existsSync, readFileSync, readdirSync, statSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

const WAV_RE = /^(meetey-\d+)\.wav$/;
const FRAMES_RE = /^(meetey-\d+)-frames$/;

/** Minimal YAML front matter reader — flat `key: value` only, no dependency. */
export function parseFrontMatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const out = {};
  for (const line of text.slice(3, end).split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    // Strip trailing inline comments and surrounding quotes.
    out[match[1]] = match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Session IDs are `meetey-<Date.now()>`; tolerate a seconds-based id too. */
function sessionDate(sessionId) {
  const raw = Number(sessionId.replace("meetey-", ""));
  if (!Number.isFinite(raw)) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dirBytes(dir) {
  let total = 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = dirBytes(full);
      total += nested.bytes;
      count += nested.count;
    } else {
      total += statSync(full).size;
      count += 1;
    }
  }
  return { bytes: total, count };
}

function fileEntry(path) {
  if (!existsSync(path)) return null;
  return { path, bytes: statSync(path).size };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Builds the library index by joining three independently-named things: WAVs and
 * frame directories keyed by session id, and markdown whose front matter points
 * back at a session. Notes written before 1.1.0 share the WAV's stem instead, so
 * that shape is matched too rather than silently dropped from the library.
 */
export function scanLibrary(recordingsDir) {
  if (!existsSync(recordingsDir)) return [];

  const sessions = new Map();
  const touch = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        sessionId: id,
        title: null,
        recordedAt: null,
        durationLabel: null,
        quality: null,
        model: null,
        hasVideo: false,
        keyframeCount: null,
        truncated: null,
        files: { audio: null, notes: null, transcript: null, frames: null },
      });
    }
    return sessions.get(id);
  };

  const entries = readdirSync(recordingsDir, { withFileTypes: true });

  for (const entry of entries) {
    const full = join(recordingsDir, entry.name);

    const wav = entry.isFile() && entry.name.match(WAV_RE);
    if (wav) {
      touch(wav[1]).files.audio = fileEntry(full);
      continue;
    }

    const frames = entry.isDirectory() && entry.name.match(FRAMES_RE);
    if (frames) {
      const record = touch(frames[1]);
      const { bytes, count } = dirBytes(full);
      record.hasVideo = true;
      record.files.frames = { path: full, bytes, fileCount: count };
      const indexPath = join(full, "index.json");
      if (existsSync(indexPath)) {
        try {
          const index = JSON.parse(readFileSync(indexPath, "utf8"));
          record.keyframeCount = index.frameCount ?? (index.frames ?? []).length;
          record.truncated = index.truncated === true;
        } catch { /* a malformed index shouldn't hide the recording */ }
      }
      continue;
    }
  }

  // Second pass: markdown carries the human metadata and has to find its session.
  // Notes go first so that transcripts can fall back to their sibling's mapping.
  const markdown = entries.filter((e) => e.isFile() && e.name.endsWith(".md"));
  const notesStemToSession = new Map();
  const unclaimedTranscripts = [];

  const resolveId = (name, front) => {
    if (front.session) return front.session;
    // Pre-1.1.0 notes sat alongside the WAV: `meetey-<epoch>.md`.
    const legacy = name.match(/^(meetey-\d+)(-transcript)?\.md$/);
    return legacy ? legacy[1] : null;
  };

  for (const pass of ["notes", "transcript"]) {
    for (const entry of markdown) {
      const isTranscript = entry.name.endsWith("-transcript.md");
      if ((pass === "transcript") !== isTranscript) continue;

      const full = join(recordingsDir, entry.name);
      let text;
      try { text = readFileSync(full, "utf8"); } catch { continue; }
      const front = parseFrontMatter(text);
      let id = resolveId(entry.name, front);

      if (isTranscript) {
        // A transcript is named for its notes file, so the convention resolves it
        // even when the file itself carries no front matter.
        if (!id) {
          const stem = entry.name.slice(0, -"-transcript.md".length);
          id = notesStemToSession.get(stem) ?? null;
        }
        if (!id) { unclaimedTranscripts.push({ name: entry.name, path: full }); continue; }
        touch(id).files.transcript = fileEntry(full);
        continue;
      }

      if (!id) continue;
      const record = touch(id);
      record.files.notes = fileEntry(full);
      notesStemToSession.set(entry.name.slice(0, -".md".length), id);

      record.recordedAt = front.recorded ?? record.recordedAt;
      record.durationLabel = front.duration ?? record.durationLabel;
      record.quality = front.quality ?? record.quality;
      record.model = front.model ?? record.model;

      const heading = text.match(/^##\s+(.+)$/m);
      if (heading) record.title = heading[1].trim();
    }
  }

  // A transcript whose notes file is gone would otherwise vanish from search.
  for (const orphan of unclaimedTranscripts) {
    const id = `orphan:${orphan.name}`;
    const record = touch(id);
    record.title = `${orphan.name} (transcript with no notes)`;
    record.orphan = true;
    record.files.transcript = fileEntry(orphan.path);
  }

  return [...sessions.values()]
    .map((record) => {
      const date = record.recordedAt ? new Date(record.recordedAt) : sessionDate(record.sessionId);
      const valid = date && !Number.isNaN(date.getTime());
      const bytes = Object.values(record.files)
        .filter(Boolean)
        .reduce((sum, f) => sum + (f.bytes ?? 0), 0);
      return {
        ...record,
        title: record.title ?? "Untitled",
        recordedAt: valid ? date.toISOString() : null,
        date: valid ? date.toISOString().slice(0, 10) : null,
        totalBytes: bytes,
        totalSize: formatBytes(bytes),
        hasNotes: record.files.notes !== null,
      };
    })
    .sort((a, b) => (b.recordedAt ?? "").localeCompare(a.recordedAt ?? ""));
}

export function listRecordings(recordingsDir, { since, until, hasVideo, quality, limit } = {}) {
  let records = scanLibrary(recordingsDir);

  if (since) records = records.filter((r) => r.date && r.date >= since);
  if (until) records = records.filter((r) => r.date && r.date <= until);
  if (hasVideo === true) records = records.filter((r) => r.hasVideo);
  if (hasVideo === false) records = records.filter((r) => !r.hasVideo);
  if (quality) records = records.filter((r) => r.quality === quality);

  const total = records.length;
  if (limit && limit > 0) records = records.slice(0, limit);

  const bytes = records.reduce((sum, r) => sum + r.totalBytes, 0);
  return {
    count: records.length,
    totalMatching: total,
    totalSize: formatBytes(bytes),
    recordings: records,
  };
}

export function getRecording(recordingsDir, { sessionId, date }) {
  const records = scanLibrary(recordingsDir);
  const matches = sessionId
    ? records.filter((r) => r.sessionId === sessionId)
    : records.filter((r) => r.date === date);

  if (matches.length === 0) {
    return { error: `No recording found for ${sessionId ? `session ${sessionId}` : `date ${date}`}.` };
  }
  if (matches.length > 1) {
    return {
      error: `${matches.length} recordings on ${date}. Call again with a sessionId.`,
      candidates: matches.map((r) => ({ sessionId: r.sessionId, title: r.title, recordedAt: r.recordedAt })),
    };
  }

  const record = matches[0];
  const notes = record.files.notes ? readFileSync(record.files.notes.path, "utf8") : null;
  return { ...record, notes };
}

/**
 * Searches notes and transcripts, and reports the `[mm:ss]` on the matching line
 * when there is one — the point is to land on the moment, not just the meeting.
 */
export function searchRecordings(recordingsDir, query, { limit = 40, scope = "all" } = {}) {
  if (!query || !query.trim()) return { error: "Provide a search query." };

  const needle = query.toLowerCase();
  const records = scanLibrary(recordingsDir);
  const matches = [];

  for (const record of records) {
    const targets = [];
    if (scope !== "transcripts" && record.files.notes) targets.push(["notes", record.files.notes.path]);
    if (scope !== "notes" && record.files.transcript) targets.push(["transcript", record.files.transcript.path]);

    for (const [kind, path] of targets) {
      let lines;
      try { lines = readFileSync(path, "utf8").split("\n"); } catch { continue; }

      lines.forEach((line, i) => {
        if (!line.toLowerCase().includes(needle)) return;
        const stamp = line.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
        matches.push({
          sessionId: record.sessionId,
          title: record.title,
          date: record.date,
          in: kind,
          offset: stamp ? stamp[1] : null,
          line: line.trim().slice(0, 300),
          lineNumber: i + 1,
          path,
        });
      });
    }
  }

  return {
    query,
    matchCount: matches.length,
    truncated: matches.length > limit,
    matches: matches.slice(0, limit),
  };
}

/**
 * Destructive, so it describes by default and only acts on an explicit confirm.
 * The caller has to have seen the file list before anything is removed.
 */
export function deleteRecording(recordingsDir, { sessionId, confirm = false, keepNotes = false }) {
  const record = scanLibrary(recordingsDir).find((r) => r.sessionId === sessionId);
  if (!record) return { error: `No recording found for session ${sessionId}.` };

  const targets = [];
  for (const [kind, file] of Object.entries(record.files)) {
    if (!file) continue;
    if (keepNotes && (kind === "notes" || kind === "transcript")) continue;
    targets.push({ kind, path: file.path, bytes: file.bytes });
  }

  const bytes = targets.reduce((sum, t) => sum + (t.bytes ?? 0), 0);

  if (!confirm) {
    return {
      dryRun: true,
      sessionId,
      title: record.title,
      date: record.date,
      wouldDelete: targets,
      wouldFree: formatBytes(bytes),
      message: "Nothing deleted. Call again with confirm: true to remove these permanently.",
    };
  }

  const deleted = [];
  const failed = [];
  for (const target of targets) {
    try {
      rmSync(target.path, { recursive: true, force: true });
      deleted.push(target.path);
    } catch (e) {
      failed.push({ path: target.path, error: e.message });
    }
  }

  return {
    sessionId,
    title: record.title,
    deleted,
    failed,
    freed: formatBytes(bytes),
    keptNotes: keepNotes,
  };
}

export function systemStatus({ recordingsDir, captureBinary, modelPath, claudeJsonPath, skillPath, keybindingsPath, activeRecording }) {
  const check = (ok, detail) => ({ ok, detail: detail ?? null });

  const binaryOk = existsSync(captureBinary);
  let signed = null;
  if (binaryOk) {
    try {
      execFileSync("codesign", ["--verify", captureBinary], { stdio: "ignore" });
      signed = true;
    } catch { signed = false; }
  }

  let whisper = null;
  try {
    whisper = execFileSync("which", ["whisper-cli"], { encoding: "utf8" }).trim() || null;
  } catch { whisper = null; }

  // The most common support issue by far, and the only way to know is to ask.
  let permission = "unknown";
  if (binaryOk) {
    try {
      execFileSync(captureBinary, ["--list-apps"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
      permission = "granted";
    } catch (e) {
      const output = `${e.stderr ?? ""}${e.message ?? ""}`;
      permission = /declined TCC|not authorized|permission/i.test(output) ? "denied" : "unknown";
    }
  }

  let mcpRegistered = false;
  if (existsSync(claudeJsonPath)) {
    try {
      mcpRegistered = Boolean(JSON.parse(readFileSync(claudeJsonPath, "utf8"))?.mcpServers?.meetey);
    } catch { /* unreadable config counts as not registered */ }
  }

  let hotkeys = false;
  if (existsSync(keybindingsPath)) {
    try {
      const bindings = JSON.parse(readFileSync(keybindingsPath, "utf8"));
      hotkeys = Array.isArray(bindings)
        && bindings.some((b) => b.action === "sendMessage" && String(b.value ?? "").includes("meetey"));
    } catch { /* malformed keybindings count as not registered */ }
  }

  const library = scanLibrary(recordingsDir);
  const bytes = library.reduce((sum, r) => sum + r.totalBytes, 0);
  const withVideo = library.filter((r) => r.hasVideo).length;

  const install = {
    captureBinary: check(binaryOk, binaryOk ? captureBinary : "run: npx jej2k5/meetey install"),
    codeSigned: check(signed === true, signed === false ? "run: npx jej2k5/meetey update" : null),
    whisperCli: check(Boolean(whisper), whisper ?? "run: brew install whisper-cpp"),
    whisperModel: check(existsSync(modelPath), existsSync(modelPath) ? modelPath : "run: npx jej2k5/meetey install"),
    mcpRegistered: check(mcpRegistered, mcpRegistered ? null : "run: npx jej2k5/meetey install"),
    skillInstalled: check(existsSync(skillPath), existsSync(skillPath) ? skillPath : "run: npx jej2k5/meetey install"),
    hotkeys: check(hotkeys, hotkeys ? "Ctrl+Shift+R / Ctrl+Shift+S" : "run: npx jej2k5/meetey install"),
    screenRecordingPermission: permission,
  };

  const problems = Object.entries(install)
    .filter(([key, value]) => key !== "screenRecordingPermission" && value.ok === false)
    .map(([key]) => key);
  if (permission === "denied") problems.push("screenRecordingPermission");

  return {
    healthy: problems.length === 0,
    problems,
    install,
    storage: {
      recordingsDir,
      recordings: library.length,
      withScreenCapture: withVideo,
      totalBytes: bytes,
      totalSize: formatBytes(bytes),
      oldest: library.length ? library[library.length - 1].date : null,
      newest: library.length ? library[0].date : null,
    },
    activeRecording: activeRecording ?? null,
  };
}
