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

import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import {
  configuredWorkerPath,
  resolveCodingAgentExecutable,
} from "../src/lifecycle.js";
import { currentImageExecution } from "../src/image-execution.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("resolves only the requested CLI from PATH", () => {
  const bin = mkdtempSync(join(tmpdir(), "bridge-only-codex-"));
  scratch.push(bin);
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(codex, 0o755);
  const previous = process.env.PATH;
  const previousHome = process.env.HOME;
  try {
    process.env.PATH = bin;
    process.env.HOME = bin;
    expect(resolveCodingAgentExecutable("codex")).toBe(codex);
    expect(() => resolveCodingAgentExecutable("claude")).toThrow(/claude/);
    expect(() => resolveCodingAgentExecutable("claude")).not.toThrow(/codex/);
  } finally {
    process.env.PATH = previous;
    process.env.HOME = previousHome;
  }
});

it("configuredWorkerPath returns only the matching CLI path", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-path-"));
  scratch.push(dir);
  mkdirSync(dir, { recursive: true });
  const config = parseConfig({
    dataDir: dir,
    workspace: dir,
    worker: "codex",
    codexPath: process.execPath,
  });
  expect(configuredWorkerPath(config, "codex")).toBe(process.execPath);
  expect(configuredWorkerPath(config, "claude")).toBeUndefined();
  expect(configuredWorkerPath(config)).toBe(process.execPath);
});

it("image execution refuses to fall back across CLI types", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-img-path-"));
  scratch.push(dir);
  const config = parseConfig({
    dataDir: dir,
    workspace: dir,
    worker: "codex",
    codexPath: process.execPath,
  });
  expect(currentImageExecution(config, "default", "codex").path).toBe(
    process.execPath,
  );
  expect(() => currentImageExecution(config, "default", "claude")).toThrow(
    /claude/,
  );
});
