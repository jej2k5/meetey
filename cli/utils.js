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

import { execSync } from "child_process";
import { createWriteStream } from "fs";
import { get } from "https";

export const green  = (s) => console.log(`\x1b[32m${s}\x1b[0m`);
export const yellow = (s) => console.log(`\x1b[33m${s}\x1b[0m`);
export const red    = (s) => console.error(`\x1b[31m${s}\x1b[0m`);
export const step   = (s) => console.log(`\n\x1b[1m==> ${s}\x1b[0m`);

export function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", ...opts });
}

export function which(bin) {
  try { return execSync(`which ${bin}`, { encoding: "utf8" }).trim(); } catch { return null; }
}

export function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = createWriteStream(dest);
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(1)} MB`);
      });
      res.pipe(file);
      file.on("finish", () => { process.stdout.write("\n"); file.close(resolve); });
      file.on("error", reject);
    }).on("error", reject);
  });
}
