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
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
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
cpSync("README.md", join(staging, "index.md"));
const { readdirSync } = await import("node:fs");
for (const file of readdirSync(staging).filter((name) =>
  name.endsWith(".md"),
)) {
  let body = readFileSync(join(staging, file), "utf8");
  if (file === "index.md")
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
  // Both documents and GitHub keep ordinary Markdown links. Only the private site adds theme variants.
  body = body.replace(
    /!\[([^\]]*)\]\((assets\/(diagrams|screenshots)\/[^)]+)\)/g,
    (original, alt, path) => {
      const themed = /-light(?=-|\.)/.test(path)
        ? path.replace(/-light(?=-|\.)/, "-dark")
        : path.replace(/\.(svg|png)$/, "-dark.$1");
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
const yaml = readFileSync("mkdocs.yml", "utf8")
  .replace("docs_dir: docs", "docs_dir: " + JSON.stringify(staging))
  .replace(
    "site_dir: work/docs-site",
    "site_dir: " + JSON.stringify(resolve("work/docs-site")),
  );
const config = staging + ".yml";
writeFileSync(config, yaml);
const result = spawnSync(
  process.env.BRIDGE_PYTHON ?? "python3",
  ["-m", "mkdocs", "build", "--strict", "--clean", "-f", config],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    "Private documentation build failed. Install docs/requirements.txt into BRIDGE_PYTHON.",
  );
console.log("Private documentation: " + resolve("work/docs-site/index.html"));
