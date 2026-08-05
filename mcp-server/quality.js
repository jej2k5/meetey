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

import { openSync, readSync, writeSync, closeSync, statSync } from "fs";

// whisper.cpp emits these as segment text when it hears no usable speech.
// They are the strongest signal that a recording captured the wrong thing.
const FILLER = /^[\s\[\(]*(blank_audio|silence|music|inaudible|no speech|sound|applause|laughter|noise)[\s\]\)._-]*$/i;

/**
 * Exact recording length from the WAV header, rather than subtracting the
 * start/stop wall-clock timestamps — those include process spin-up and the
 * SIGTERM drain, and drift by a second or two either way.
 *
 * Assumes the canonical 44-byte header that WAVWriter emits. Returns null for
 * anything else rather than guessing.
 */
/**
 * Repairs a WAV whose header was never finalised.
 *
 * The capture writes a placeholder header at the start and fills in the two size
 * fields when it stops. A capture killed before that leaves every sample on disk
 * behind a header claiming zero bytes of audio — the recording looks empty to any
 * player, and to whisper, despite being entirely intact.
 *
 * Only touches a header that declares zero. A plausible size is left alone; a file
 * that is merely shorter than expected is not ours to rewrite.
 */
export function repairWavHeader(path) {
  let fd;
  try {
    fd = openSync(path, "r+");
    const header = Buffer.alloc(44);
    if (readSync(fd, header, 0, 44, 0) < 44) return { repaired: false, reason: "too short to be a WAV" };
    if (header.toString("ascii", 0, 4) !== "RIFF") return { repaired: false, reason: "not a RIFF file" };

    const declared = header.readUInt32LE(40);
    const actual = statSync(path).size - 44;
    if (actual <= 0) return { repaired: false, reason: "no audio data" };
    if (declared !== 0) return { repaired: false };

    const sizes = Buffer.alloc(4);
    sizes.writeUInt32LE(36 + actual);
    writeSync(fd, sizes, 0, 4, 4);
    sizes.writeUInt32LE(actual);
    writeSync(fd, sizes, 0, 4, 40);
    return { repaired: true, dataBytes: actual };
  } catch (e) {
    return { repaired: false, reason: e.message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function wavDurationMs(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(44);
    if (readSync(fd, header, 0, 44, 0) < 44) return null;
    if (header.toString("ascii", 0, 4) !== "RIFF") return null;
    if (header.toString("ascii", 8, 12) !== "WAVE") return null;
    if (header.toString("ascii", 36, 40) !== "data") return null;

    const byteRate = header.readUInt32LE(28);
    const dataBytes = header.readUInt32LE(40);
    if (!byteRate || !dataBytes) return null;
    return Math.round((dataBytes / byteRate) * 1000);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** "45 min", "1 hr 12 min", "38 sec" */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** Offset within the recording, as [mm:ss] or [h:mm:ss] past an hour. */
export function formatOffset(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Cheap, deterministic read on whether the transcript is trustworthy.
 *
 * This exists because a bad transcript and a good one produce summaries in the
 * same confident voice. Without a signal here, the only way to tell them apart
 * is to read the transcript — which is the thing the summary exists to replace.
 *
 * Rate is measured against *spoken* time, not wall-clock, so a meeting with long
 * silences isn't penalised for being quiet.
 */
export function assessQuality(segments, durationMs) {
  const total = Array.isArray(segments) ? segments.length : 0;

  if (total === 0) {
    return {
      level: "unusable",
      reason: "No speech was transcribed.",
      segmentCount: 0,
      wordCount: 0,
      spokenWordsPerMinute: 0,
      degradedRatio: 1,
      silenceRatio: 1,
    };
  }

  // Each segment counts toward the ratio at most once. A fragment that is also
  // a repeat is one bad segment, not two — summing the categories independently
  // lets the ratio exceed 1.0 and print as ">100% of segments".
  let degraded = 0;
  let words = 0;
  let spokenMs = 0;
  let previous = null;

  for (const segment of segments) {
    const text = (segment.text ?? "").trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    words += wordCount;

    const key = text.toLowerCase();
    const isFiller = FILLER.test(text);
    const isStunted = wordCount > 0 && wordCount < 3;
    const isRepeat = previous !== null && key === previous && key.length > 0;
    if (isFiller || isStunted || isRepeat) degraded++;
    previous = key;

    if (Number.isFinite(segment.fromMs) && Number.isFinite(segment.toMs)) {
      spokenMs += Math.max(0, segment.toMs - segment.fromMs);
    }
  }

  const degradedRatio = degraded / total;
  const spokenMinutes = spokenMs / 60000;
  const spokenWordsPerMinute = spokenMinutes > 0 ? Math.round(words / spokenMinutes) : 0;
  const silenceRatio = durationMs > 0 ? Math.max(0, 1 - spokenMs / durationMs) : 0;

  // Natural conversational speech runs ~120-160 wpm measured over spoken time.
  // Well under that means whisper is emitting fragments, not sentences.
  let level = "good";
  let reason = null;

  if (degradedRatio >= 0.35 || spokenWordsPerMinute < 70) {
    level = "poor";
    reason = degradedRatio >= 0.35
      ? `${Math.round(degradedRatio * 100)}% of segments were silence markers, fragments, or repeats`
      : `speech ran at ${spokenWordsPerMinute} words/min, well below conversational pace`;
  } else if (degradedRatio >= 0.15 || spokenWordsPerMinute < 110) {
    level = "fair";
    reason = degradedRatio >= 0.15
      ? `${Math.round(degradedRatio * 100)}% of segments were fragments or repeats`
      : `speech ran at ${spokenWordsPerMinute} words/min`;
  }

  return {
    level,
    reason,
    segmentCount: total,
    wordCount: words,
    spokenWordsPerMinute,
    degradedRatio: Number(degradedRatio.toFixed(3)),
    silenceRatio: Number(silenceRatio.toFixed(3)),
  };
}
