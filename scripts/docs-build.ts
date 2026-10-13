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

import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = resolve(".");
mkdirSync("work", { recursive: true });
const staging = mkdtempSync(resolve("work/docs-source-"));
cpSync("docs", staging, { recursive: true });
for (const directory of ["assets", "examples", "tests/clients"])
  cpSync(directory, join(staging, directory), { recursive: true });
for (const file of ["LICENSE", "NOTICE", "SECURITY.md"])
  cpSync(
    file,
    join(staging, file === "SECURITY.md" ? "security-policy.md" : file),
  );
const readmeLanding = !existsSync(join(staging, "index.md"));
if (readmeLanding) cpSync("README.md", join(staging, "index.md"));
const { readdirSync } = await import("node:fs");
for (const file of readdirSync(staging).filter((name) =>
  name.endsWith(".md"),
)) {
  let body = readFileSync(join(staging, file), "utf8");
  if (file === "security-policy.md")
    body =
      "---\ndescription: Report bridge vulnerabilities privately and follow the published security disclosure process for the project.\n---\n\n" +
      body;
  if (file === "index.md" && readmeLanding)
    body = body
      .replaceAll("docs/", "")
      .replace(
        /<p align="center"><img src="assets\/banner.png"[^>]*><\/p>/,
        "![Firefly Agent Bridge](assets/banner-light.png){ .theme-light }\n\n![Firefly Agent Bridge](assets/banner-dark.png){ .theme-dark }",
      );
  body = body
    .replaceAll("../README.md", "index.md")
    .replaceAll("../assets/", "assets/")
    .replaceAll("../examples/", "examples/")
    .replaceAll("../tests/", "tests/")
    .replaceAll("../SECURITY.md", "security-policy.md");
  // The documentation site adds theme variants to ordinary Markdown images.
  body = body.replace(
    /!\[([^\]]*)\]\((assets\/(diagrams|screenshots)\/[^)]+)\)/g,
    (original, alt, path) => {
      const themed = /-light(?=-|\.)/.test(path)
        ? path.replace(/-light(?=-|\.)/, "-dark")
        : path.replace(/\.(svg|png)$/, "-dark.$1");
      if (path.startsWith("assets/screenshots/")) {
        const escape = (value: string) =>
          value
            .replaceAll("&", "&amp;")
            .replaceAll('"', "&quot;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;");
        const link = (image: string, theme: string) => {
          const png = readFileSync(join(staging, image));
          const width = png.readUInt32BE(16);
          const height = png.readUInt32BE(20);
          const url = file === "index.md" ? image : "../" + image;
          return `<a class="bridge-shot__link ${theme}" href="${escape(url)}" aria-label="Open full screenshot: ${escape(alt)}"><img src="${escape(url)}" alt="${escape(alt)}" width="${width}" height="${height}" loading="lazy"></a>`;
        };
        // Keep theme pairs inline so image expansion cannot split table rows.
        return link(path, "theme-light") + link(themed, "theme-dark");
      }
      return (
        original +
        "{ .theme-light }\n\n![" +
        alt +
        "](" +
        themed +
        "){ .theme-dark }"
      );
    },
  );
  writeFileSync(join(staging, file), body);
}
const discoveryHook = join(
  dirname(fileURLToPath(import.meta.url)),
  "docs_discovery_hook.py",
);
const hook = join(
  dirname(fileURLToPath(import.meta.url)),
  "docs_scene_hook.py",
);
const yaml = readFileSync("mkdocs.yml", "utf8")
  .replace("docs_dir: docs", "docs_dir: " + JSON.stringify(staging))
  .replace(
    "site_dir: work/docs-site",
    "site_dir: " + JSON.stringify(resolve("work/docs-site")),
  );
const config = staging + ".yml";
writeFileSync(
  config,
  yaml +
    "\nhooks:\n  - " +
    JSON.stringify(hook) +
    "\n  - " +
    JSON.stringify(discoveryHook) +
    "\n",
);
const result = spawnSync(
  process.env.BRIDGE_PYTHON ?? "python3",
  ["-m", "mkdocs", "build", "--strict", "--clean", "-f", config],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    "Documentation build failed. Install docs/requirements.txt into BRIDGE_PYTHON.",
  );
const discovery = spawnSync(
  process.env.BRIDGE_PYTHON ?? "python3",
  [
    "scripts/check_docs_discovery.py",
    "work/docs-site",
    "https://fireflyframework.github.io/firefly-agent-bridge/",
  ],
  { cwd: root, stdio: "inherit" },
);
if (discovery.error) throw discovery.error;
if (discovery.status !== 0)
  throw new Error("Documentation discovery validation failed.");
console.log("Documentation: " + resolve("work/docs-site/index.html"));
