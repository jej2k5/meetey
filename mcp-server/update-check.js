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
 * Whether a newer Meetey has been released.
 *
 * The only part of Meetey that talks to a server, so it is worth being precise
 * about what that means: an anonymous GET for the repository's latest release
 * tag. No identifier, no version, no telemetry — the request carries nothing
 * about the machine making it, and the answer is a version string.
 *
 * Lives here rather than in `cli/` because `/meetey doctor` reports the result
 * too, and only `mcp-server/` and `daemon/` are copied into `~/.meetey`. The
 * split of responsibility is deliberate: **the CLI performs the check, the MCP
 * server only reads the cache.** A background tool inside an editor should not
 * make network calls of its own.
 *
 * Set `MEETEY_NO_UPDATE_CHECK=1` to disable it entirely.
 */

import { get } from "https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const RELEASES_URL = "https://api.github.com/repos/jej2k5/meetey/releases/latest";
const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/** Retried sooner than a success, but not on every invocation — an offline
 *  laptop should not attempt a lookup every time someone runs `status`. */
const FAILURE_TTL_MS = 60 * 60 * 1000;

export function updateCachePath(meeteyDir) {
  return join(meeteyDir, "state", "update-check.json");
}

export function isDisabled() {
  return process.env.MEETEY_NO_UPDATE_CHECK === "1";
}

/** Reads the last result. Never touches the network. */
export function readUpdateCache(meeteyDir) {
  const path = updateCachePath(meeteyDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeUpdateCache(meeteyDir, record) {
  try {
    const path = updateCachePath(meeteyDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  } catch {
    // A cache that cannot be written costs one extra lookup, never a failure.
  }
}

/**
 * Compares `1.4.1`-style versions, tolerating a leading `v`.
 * Returns 1 when `a` is newer, -1 when older, 0 when equal.
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function fetchLatestTag(timeoutMs) {
  return new Promise((resolve) => {
    const request = get(
      RELEASES_URL,
      {
        headers: {
          // GitHub rejects requests without one.
          "User-Agent": "meetey-update-check",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ error: `GitHub returned ${res.statusCode}` });
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try {
            const tag = JSON.parse(body).tag_name;
            resolve(tag ? { tag } : { error: "no tag in response" });
          } catch {
            resolve({ error: "could not parse the response" });
          }
        });
      },
    );

    // Any failure here is uninteresting — offline, DNS, proxy, rate limit. The
    // check is a convenience and must never be the reason a command is slow or
    // fails.
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve({ error: "timed out" });
    });
    request.on("error", (e) => resolve({ error: e.message }));
  });
}

/**
 * Returns the cached answer when it is fresh, otherwise looks it up.
 * Resolves to null only when checking is disabled.
 */
export async function checkForUpdate({ meeteyDir, currentVersion, force = false, timeoutMs = 2000 }) {
  if (isDisabled()) return null;

  const cached = readUpdateCache(meeteyDir);
  if (cached && !force) {
    const ttl = cached.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    if (Date.now() - new Date(cached.checkedAt).getTime() < ttl) {
      return { ...cached, current: currentVersion, fromCache: true, ...verdict(cached.latest, currentVersion) };
    }
  }

  const result = await fetchLatestTag(timeoutMs);
  const record = {
    checkedAt: new Date().toISOString(),
    latest: result.tag ? String(result.tag).replace(/^v/, "") : null,
    error: result.error ?? null,
  };
  writeUpdateCache(meeteyDir, record);
  return { ...record, current: currentVersion, fromCache: false, ...verdict(record.latest, currentVersion) };
}

function verdict(latest, current) {
  if (!latest || !current) return { updateAvailable: false };
  return { updateAvailable: compareVersions(latest, current) > 0 };
}
