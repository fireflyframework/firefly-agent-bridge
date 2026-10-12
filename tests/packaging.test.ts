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
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "firefly-mcpb-"));
  mkdirSync(join(dir, "server"));
  mkdirSync(join(dir, "assets"));
  const manifest = JSON.parse(
    readFileSync("integrations/desktop/manifest.json", "utf8"),
  );
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "server/firefly-bridge"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  copyFileSync("assets/logo.png", join(dir, "assets/logo.png"));
  copyFileSync(
    "assets/screenshots/dashboard-desktop.png",
    join(dir, "assets/dashboard.png"),
  );
  writeFileSync(join(dir, "LICENSE"), "Apache-2.0");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function pack() {
  const module = await import("../scripts/desktop-bundle.js").catch(
    () => undefined,
  );
  expect(
    module?.packDesktopBundle,
    "a standards-validated internal MCPB builder must exist",
  ).toBeDefined();
  return module!.packDesktopBundle;
}
it("rejects malformed manifests before creating a desktop archive", async () => {
  writeFileSync(join(dir, "manifest.json"), '{"manifest_version":"0.3"}');
  const builder = await pack();
  expect(() => builder(dir, join(dir, "output.mcpb"))).toThrow(/manifest/i);
});
it("requires the declared native binary and bundled image resources", async () => {
  rmSync(join(dir, "server/firefly-bridge"));
  const builder = await pack();
  expect(() => builder(dir, join(dir, "output.mcpb"))).toThrow(/entry|binary/i);
});
it("creates deterministic ZIP bundles containing the actual manifest, runtime and notices", async () => {
  const builder = await pack();
  const output = join(tmpdir(), "firefly-test-" + Date.now() + ".mcpb");
  try {
    builder(dir, output);
    const first = readFileSync(output);
    builder(dir, output);
    expect(readFileSync(output)).toEqual(first);
    expect(first.subarray(0, 2).toString()).toBe("PK");
    const { unzipSync } = await import("fflate");
    const files = unzipSync(first);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "server/firefly-bridge",
        "LICENSE",
        "assets/logo.png",
      ]),
    );
    expect(
      JSON.parse(Buffer.from(files["manifest.json"]!).toString()).name,
    ).toBe("firefly-agent-bridge");
  } finally {
    rmSync(output, { force: true });
  }
});

it("rejects entry points escaping the bundle root", async () => {
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.server.entry_point = "../outside";
  writeFileSync(path, JSON.stringify(manifest));
  const builder = await pack();
  expect(() => builder(dir, join(dir, "output.mcpb"))).toThrow(
    /inside|manifest/i,
  );
});
