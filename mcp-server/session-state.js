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
 * The single answer to "is a recording running right now", shared across
 * processes.
 *
 * The MCP server holds its own recording in memory, which was sufficient while
 * it was the only thing that could start one. The watch agent is a separate
 * process, so without a file on disk a recording it started is invisible to
 * `/meetey stop` — and both could happily record the same meeting twice.
 *
 * Liveness is the pid, never the file. A capture that crashes, or a machine that
 * sleeps through a stop, leaves the file behind; treating that as an active
 * recording would block every future one until someone deleted it by hand.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export function activeStatePath(meeteyDir) {
  return join(meeteyDir, "state", "active.json");
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return e.code === "EPERM";
  }
}

/** Returns the running recording, or null. Clears the file if it went stale. */
export function readActive(meeteyDir) {
  const path = activeStatePath(meeteyDir);
  if (!existsSync(path)) return null;

  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    clearActive(meeteyDir);
    return null;
  }

  if (!isAlive(record?.pid)) {
    clearActive(meeteyDir);
    return null;
  }
  return record;
}

export function writeActive(meeteyDir, record) {
  const path = activeStatePath(meeteyDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}

export function clearActive(meeteyDir) {
  try {
    unlinkSync(activeStatePath(meeteyDir));
  } catch {
    // Already gone is the desired state.
  }
}

/**
 * A recording that has finished and nobody has written up yet.
 *
 * The active-state file answers "is something recording"; deleting it when the
 * capture ends is correct. But a recording started by the watch agent then ends
 * in a *different process* from the MCP server, so without this there is nothing
 * left for `/meetey stop` to find — it reports no active recording and strands a
 * finished WAV whose notification just told the user to go collect it.
 *
 * Holds the most recent uncollected recording. Earlier ones are not lost: they
 * appear in `list_recordings` as recordings with audio and no notes.
 */
export function pendingStatePath(meeteyDir) {
  return join(meeteyDir, "state", "pending.json");
}

export function writePending(meeteyDir, record) {
  const path = pendingStatePath(meeteyDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}

/** Reads without consuming. Use `clearPending` once the recording is written up. */
export function readPending(meeteyDir) {
  const path = pendingStatePath(meeteyDir);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    // The audio is the point. If it is gone the record is noise.
    if (!record?.outputPath || !existsSync(record.outputPath)) {
      clearPending(meeteyDir);
      return null;
    }
    return record;
  } catch {
    clearPending(meeteyDir);
    return null;
  }
}

export function clearPending(meeteyDir) {
  try {
    unlinkSync(pendingStatePath(meeteyDir));
  } catch {
    // Already gone is the desired state.
  }
}
