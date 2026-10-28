/*!
 * Copyright (c) 2026 Signature Management Consultants SLU
 * Author: @ancongui (https://github.com/ancongui)
 * Modified by Firefly Software Foundation for Firefly Agent Bridge (2026).
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueStore } from "../src/store.js";
import { Tokens } from "../src/auth.js";
import { Workflows } from "../src/workflows.js";
import { Scheduler } from "../src/scheduler.js";
import { createHttpService } from "../src/http.js";
import { parseConfig } from "../src/config.js";
import { runJobsCommand } from "../src/jobs-cli.js";
import type { CliStreams } from "../src/cluster-cli.js";

let dir: string;
let store: QueueStore;
let app: ReturnType<typeof createHttpService>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-jobs-cli-"));
  store = new QueueStore(join(dir, "db.sqlite"));
  const auth = new Tokens(store);
  const ownerToken = auth.create({
    id: "owner",
    owner: true,
    profiles: ["default"],
  }).token;
  writeFileSync(join(dir, "owner.token"), ownerToken, { mode: 0o600 });
  const instanceId = randomUUID();
  const flows = new Workflows(store, []);
  const scheduler = new Scheduler(
    store,
    flows,
    () => {
      throw new Error("not started");
    },
    dir,
    1,
  );
  const config = parseConfig({
    dataDir: dir,
    workspace: dir,
    claudePath: process.execPath,
  });
  app = createHttpService(
    {
      store,
      auth,
      flows,
      scheduler,
      config,
      diagnostics: () => ({ instanceId, pid: process.pid }),
    },
    { serveUi: false },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  writeFileSync(
    join(dir, "service.json"),
    JSON.stringify({
      address,
      instanceId,
      protocolVersion: 2,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
});

afterEach(async () => {
  await app?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

function captureStreams(): CliStreams & { output: () => string } {
  let out = "";
  return {
    stdout: {
      write(chunk: string) {
        out += chunk;
        return true;
      },
    },
    stderr: { write: () => true },
    env: {},
    output: () => out,
  };
}

it("prints jobs help without connecting when asked", async () => {
  const s = captureStreams();
  await runJobsCommand(dir, ["help"], s);
  expect(s.output()).toContain("jobs commands");
  expect(s.output()).toContain("list");
});

it("lists jobs as JSON over the owner connection", async () => {
  const s = captureStreams();
  await runJobsCommand(dir, ["list"], s);
  const body = JSON.parse(s.output());
  expect(body).toHaveProperty("jobs");
  expect(Array.isArray(body.jobs)).toBe(true);
});
