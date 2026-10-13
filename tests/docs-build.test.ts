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
import { createHash } from "node:crypto";
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
markdown_extensions:
  - tables
  - attr_list
  - md_in_html
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
  const digest = createHash("sha256")
    .update(readFileSync(join(directory, "assets/docs.css")))
    .digest("hex")
    .slice(0, 16);
  expect(html).toContain('href="assets/docs.css?v=' + digest + '"');
  expect(html).toMatch(/assets\/docs-scene\/scene.js\?v=[a-f0-9]{16}/);
  expect(
    readFileSync(
      join(
        directory,
        "work/docs-site/assets/docs-scene/THIRD_PARTY_NOTICES.txt",
      ),
      "utf8",
    ),
  ).toContain("MIT License");
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

it("changes CSS URLs when source contents change while preserving relative links", () => {
  const before = build();
  writeFileSync(
    join(directory, "assets/docs.css"),
    ":root { color-scheme: dark; }\n",
  );
  const after = build();
  const css = /href="assets\/docs.css\?v=([a-f0-9]{16})"/;
  expect(before.match(css)?.[1]).toBeDefined();
  expect(after.match(css)?.[1]).not.toBe(before.match(css)?.[1]);
  const nested = readFileSync(
    join(directory, "work/docs-site/installation/index.html"),
    "utf8",
  );
  expect(nested).toContain("../assets/docs.css?v=" + after.match(css)?.[1]);
});

it("keeps themed screenshots inside table cells and preserves native phone dimensions", () => {
  mkdirSync(join(directory, "assets/screenshots"), { recursive: true });
  const png = Buffer.alloc(24);
  png.writeUInt32BE(390, 16);
  png.writeUInt32BE(844, 20);
  for (const name of ["connect-mobile-light.png", "connect-mobile-dark.png"])
    writeFileSync(join(directory, "assets/screenshots", name), png);
  writeFileSync(
    join(directory, "docs/index.md"),
    `# Phone comparison

| Connect | Next step |
| --- | --- |
| ![Connect & inspect](../assets/screenshots/connect-mobile-light.png) | Choose Jobs |
`,
  );
  writeFileSync(
    join(directory, "docs/installation.md"),
    "# Install\n\n![Phone](../assets/screenshots/connect-mobile-light.png)\n",
  );
  const html = build();
  const nested = readFileSync(
    join(directory, "work/docs-site/installation/index.html"),
    "utf8",
  );
  expect(nested).toContain(
    'href="../assets/screenshots/connect-mobile-light.png"',
  );
  expect(nested).toContain(
    'src="../assets/screenshots/connect-mobile-dark.png"',
  );
  expect(html).toMatch(
    /<td><a class="bridge-shot__link theme-light"[^>]*><img[^>]*><\/a><a class="bridge-shot__link theme-dark"[^>]*><img[^>]*><\/a><\/td>/,
  );
  expect(html).toContain('width="390" height="844"');
  expect(html).toContain('alt="Connect &amp; inspect"');
  expect(html).toContain("<td>Choose Jobs</td>");
  expect(html).not.toContain("<p>|");
});
