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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bridge-docs-build-"));
  for (const name of ["docs", "assets", "examples", "tests/clients"])
    mkdirSync(join(directory, name), { recursive: true });
  for (const name of ["LICENSE", "NOTICE", "SECURITY.md"])
    writeFileSync(join(directory, name), "Fixture attribution\n");
  writeFileSync(
    join(directory, "README.md"),
    "# Repository overview\n\n[Install](docs/installation.md)\n",
  );
  writeFileSync(
    join(directory, "docs/installation.md"),
    "# Install the bridge\n",
  );
  writeFileSync(
    join(directory, "assets/docs.css"),
    ":root { color-scheme: light dark; }\n",
  );
  writeFileSync(
    join(directory, "mkdocs.yml"),
    `site_name: Documentation fixture
docs_dir: docs
site_dir: work/docs-site
theme:
  name: material
  font: false
nav:
  - Home: index.md
  - Install: installation.md
extra_css:
  - assets/docs.css
`,
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function build() {
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("scripts/docs-build.ts"),
    ],
    {
      cwd: directory,
      env: process.env,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return readFileSync(join(directory, "work/docs-site/index.html"), "utf8");
}

it("publishes the curated landing page with working guide and asset links", () => {
  writeFileSync(
    join(directory, "docs/index.md"),
    "# Start with your bridge\n\n[Install the service](installation.md)\n",
  );
  const html = build();
  expect(html).toMatch(/<h1[^>]*>Start with your bridge/);
  expect(html).not.toMatch(/<h1[^>]*>Repository overview/);
  expect(html).toMatch(/href="installation\/">Install the service<\/a>/);
  expect(html).toContain('href="assets/docs.css"');
  expect(
    readFileSync(
      join(directory, "work/docs-site/installation/index.html"),
      "utf8",
    ),
  ).toMatch(/<h1[^>]*>Install the bridge/);
  expect(
    readFileSync(join(directory, "work/docs-site/assets/docs.css"), "utf8"),
  ).toContain("color-scheme: light dark");
});

it("uses the README when no curated landing exists and resolves its guide links", () => {
  const html = build();
  expect(html).toMatch(/<h1[^>]*>Repository overview/);
  expect(html).toMatch(/href="installation\/">Install<\/a>/);
});
