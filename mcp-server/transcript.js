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
 * Turning whisper's output into the transcript file.
 *
 * Lives here so the watch agent and the MCP server produce byte-identical
 * transcripts. The agent writes one the moment a recording ends — the meeting is
 * then legible without Claude, without authentication, and without anyone
 * remembering to run anything. Notes still need Claude; a transcript does not,
 * and making it wait for one is how a recording ends up sitting unread.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

/** `[mm:ss]`, or `[h:mm:ss]` once past the hour. Matches the notes format. */
export function formatTimestamp(ms) {
  if (ms === null || ms === undefined) return "[--:--]";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `[${h}:${pad(m)}:${pad(s)}]` : `[${pad(m)}:${pad(s)}]`;
}

/**
 * Reads whisper's JSON into `{ text, fromMs, toMs }` segments.
 *
 * whisper.cpp has used both `transcription` and `segments` as the top-level key
 * and both `text` and `sentence` per segment, so accept either rather than break
 * on a version change.
 */
export function readWhisperSegments(jsonPath) {
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    const segments = raw.transcription ?? raw.segments ?? [];
    return segments
      .map((s) => ({
        text: (s.text ?? s.sentence ?? "").trim(),
        fromMs: s.offsets?.from ?? null,
        toMs: s.offsets?.to ?? null,
      }))
      .filter((s) => s.text.length > 0);
  } catch {
    return null;
  }
}

/**
 * The transcript document. `notes` is omitted when none exist yet — which is the
 * normal case for one written the moment a recording ends.
 */
export function renderTranscript({ sessionId, segments, notes }) {
  const front = ["---", `session: ${sessionId}`];
  if (notes) front.push(`notes: ${notes}`);
  front.push("---", "");

  const body = segments.length
    ? segments.map((s) => `**${formatTimestamp(s.fromMs)}** ${s.text}`)
    : ["*No speech was recognised in this recording.*"];

  return front.concat(body).join("\n") + "\n";
}

/**
 * Writes the transcript for a session that has no notes yet.
 *
 * Named for the session rather than a meeting title, because the title is
 * inferred by Claude and does not exist at this point. The library matches this
 * name back to its recording, and the skill renames it when notes are written so
 * there is never a second copy.
 */
export function writeSessionTranscript({ recordingsDir, sessionId, jsonPath }) {
  const segments = readWhisperSegments(jsonPath);
  if (!segments) return { written: false, reason: "no whisper output to read" };

  const path = `${recordingsDir}/${sessionId}-transcript.md`;
  writeFileSync(path, renderTranscript({ sessionId, segments }));
  return { written: true, path, segments: segments.length };
}
