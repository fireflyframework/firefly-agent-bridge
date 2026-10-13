/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory: string;
let archive: string;
let checksums: string;
const bootstrap = resolve("integrations/claude-code/scripts/bootstrap.sh");
const asset = "firefly-agent-bridge-0.2.7-linux-x64.tar.gz";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bridge-bootstrap-test-"));
  const commands = join(directory, "bin");
  const source = join(directory, "source");
  mkdirSync(commands);
  mkdirSync(source);
  writeFileSync(
    join(source, "firefly-bridge"),
    '#!/usr/bin/env bash\nprintf "fixture-ready:%s\\n" "$1"\n',
    { mode: 0o755 },
  );
  archive = join(directory, asset);
  checksums = join(directory, "SHA256SUMS");
  const packed = spawnSync("tar", [
    "-czf",
    archive,
    "-C",
    source,
    "firefly-bridge",
  ]);
  expect(packed.status).toBe(0);
  writeFileSync(
    checksums,
    createHash("sha256").update(readFileSync(archive)).digest("hex") +
      "  " +
      asset +
      "\n",
  );
  writeFileSync(
    join(commands, "uname"),
    '#!/usr/bin/env bash\ncase "$1" in -s) printf Linux;; -m) printf x86_64;; esac\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(commands, "gh"),
    '#!/usr/bin/env bash\nprintf "unexpected-gh\\n" >&2\nexit 99\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(commands, "curl"),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$@" >> "$FIXTURE_CURL_LOG"
destination=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) destination="$2"; shift 2;;
    https://*) url="$1"; shift;;
    *) shift;;
  esac
done
case "$url" in
  */SHA256SUMS) cp "$FIXTURE_CHECKSUMS" "$destination";;
  */firefly-agent-bridge-0.2.7-linux-x64.tar.gz) cp "$FIXTURE_ARCHIVE" "$destination";;
  *) exit 8;;
esac
`,
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run() {
  return spawnSync("bash", [bootstrap, "status"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: join(directory, "bin") + ":" + process.env.PATH,
      XDG_CACHE_HOME: join(directory, "cache"),
      FIXTURE_ARCHIVE: archive,
      FIXTURE_CHECKSUMS: checksums,
      FIXTURE_CURL_LOG: join(directory, "curl.log"),
    },
  });
}
it("installs a checksum-verified public asset without a GitHub login", () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("fixture-ready:status\n");
  const downloads = readFileSync(join(directory, "curl.log"), "utf8");
  expect(downloads).toContain(
    "https://github.com/fireflyframework/firefly-agent-bridge/releases/download/v0.2.7/" +
      asset,
  );
  expect(downloads).toContain("--proto");
  expect(downloads).toContain("=https");
});
it("refuses an altered archive before executing or caching it", () => {
  writeFileSync(archive, "altered archive");
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Release checksum verification failed");
  expect(result.stdout).not.toContain("fixture-ready");
});
it("refuses a missing platform checksum", () => {
  writeFileSync(checksums, "");
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Release checksum is missing");
  expect(result.stdout).not.toContain("fixture-ready");
});
