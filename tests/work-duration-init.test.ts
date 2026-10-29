/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async () => ({
  ...(await vi.importActual<typeof import("node:os")>("node:os")),
  homedir: () => fixture.home,
}));
import { initialize } from "../src/lifecycle.js";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bridge-duration-init-fictional-"));
  fixture.home = join(directory, "home");
  mkdirSync(join(fixture.home, ".local/bin"), { recursive: true });
  writeFileSync(
    join(fixture.home, ".local/bin/codex"),
    "#!/bin/sh\nexit 99\n",
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
it("fresh initialization explicitly selects uncapped version one without launching a provider", async () => {
  const config = await initialize(join(directory, "new-instance"));
  expect(config.profiles.default?.workDuration).toEqual({
    version: 1,
    timeoutMs: null,
  });
});
it("opening existing owner configuration preserves marker absence and exact file bytes", async () => {
  const path = join(directory, "old-instance");
  mkdirSync(path);
  const raw =
    JSON.stringify(
      {
        dataDir: path,
        workspace: join(path, "jobs"),
        worker: "codex",
        codexPath: join(fixture.home, ".local/bin/codex"),
        profiles: { default: { timeoutMs: 300000 } },
      },
      null,
      4,
    ) + "\n";
  writeFileSync(join(path, "config.json"), raw, { mode: 0o600 });
  const config = await initialize(path);
  expect(config.profiles.default).not.toHaveProperty("workDuration");
  expect(readFileSync(join(path, "config.json"), "utf8")).toBe(raw);
});
