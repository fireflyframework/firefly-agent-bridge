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

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseConfig } from "../src/config.js";
import { QueueStore } from "../src/store.js";
import { Workflows } from "../src/workflows.js";
function inventory(directory = "."): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      [
        ".git",
        "node_modules",
        "work",
        "dist",
        "release",
        "coverage",
        "test-results",
        "playwright-report",
        ".client-venv",
        ".venv",
      ].includes(entry.name)
    )
      return [];
    const path = directory === "." ? entry.name : directory + "/" + entry.name;
    return entry.isDirectory() ? inventory(path) : [path];
  });
}
const brand = JSON.parse(
  readFileSync("assets/brand/inventory.json", "utf8"),
) as {
  files: { path: string; sha256: string; owner: string; license: string }[];
};
const brandPaths = new Set(brand.files.map((file) => file.path));
for (const file of brand.files) {
  assert(
    file.path.startsWith("assets/") && !file.path.includes(".."),
    "Brand inventory path must stay inside assets",
  );
  assert(
    file.owner && file.license,
    "Brand ownership and license required: " + file.path,
  );
  assert.equal(
    createHash("sha256").update(readFileSync(file.path)).digest("hex"),
    file.sha256,
    file.path + " asset digest",
  );
}
const files = inventory();
const read = (path: string) => readFileSync(path, "utf8");
// Documentation examples use the production validators so schema and reference
// changes cannot silently leave installation instructions with unusable templates.
const exampleConfig = parseConfig({
  dataDir: resolve("work/example-state"),
  workspace: resolve("work/example-jobs"),
  claudePath: process.execPath,
  profiles: {
    default: {},
    ...JSON.parse(read("examples/workflow-profiles.json")),
  },
  workflows: [
    JSON.parse(read("examples/workflow-templates/advanced-development.json")),
  ],
});
const exampleStore = new QueueStore(":memory:");
try {
  new Workflows(exampleStore, exampleConfig.workflows);
} finally {
  exampleStore.close();
}
const version = JSON.parse(read("package.json")).version;
for (const file of [
  "integrations/desktop/manifest.json",
  "integrations/codex/.codex-plugin/plugin.json",
  "integrations/claude-code/.claude-plugin/plugin.json",
])
  assert.equal(JSON.parse(read(file)).version, version, file + " version");
assert.equal(
  JSON.parse(read(".claude-plugin/marketplace.json")).plugins[0].version,
  version,
);
assert(
  read("integrations/claude-code/scripts/bootstrap.sh").includes(
    'version="' + version + '"',
  ),
);
for (const file of ["src/cli.ts", "src/http.ts", "src/mcp.ts"])
  assert(
    read(file).includes('from "./release-version.js"'),
    file + " canonical version import",
  );
assert(read("src/cli.ts").includes("console.log(releaseVersion)"));
assert(read("src/http.ts").includes("version: releaseVersion"));
assert(read("src/mcp.ts").includes("version: releaseVersion"));
assert(read("src/ui/index.html").includes("v__BRIDGE_RELEASE_VERSION__"));
assert(read("scripts/build.ts").includes("html: releaseHtml("));
assert(read("src/ui-assets.ts").includes("html: releaseHtml("));

for (const file of files) {
  if (file.startsWith("vendor-licenses/") || brandPaths.has(file)) continue;
  if (/\.(ts|js|mjs|css|svg|html|sh|yml|py)$/.test(file)) {
    const start = read(file).slice(0, 1800);
    for (const notice of start.includes(
      "Copyright 2026 Firefly Software Foundation",
    )
      ? [
          "Copyright 2026 Firefly Software Foundation",
          "SPDX-License-Identifier: Apache-2.0",
          "https://www.apache.org/licenses/LICENSE-2.0",
        ]
      : [
          "Signature Management Consultants SLU",
          "@ancongui",
          "SPDX-License-Identifier: Apache-2.0",
          "https://www.apache.org/licenses/LICENSE-2.0",
        ])
      assert(start.includes(notice), file + " lacks " + notice);
  }
  if (file.endsWith(".json"))
    assert(
      existsSync(file + ".license"),
      file + " lacks its JSON license sidecar",
    );
  if (file.endsWith(".md")) {
    for (const match of read(file).matchAll(
      /!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
    )) {
      const link = match[1]!;
      if (/^(https?:|mailto:|#)/.test(link)) continue;
      assert(
        existsSync(
          resolve(dirname(file), decodeURIComponent(link.split("#")[0]!)),
        ),
        file + " has a broken link: " + link,
      );
    }
  }
}
const api = JSON.parse(read("docs/openapi.json"));
assert.equal(api.info.version, version, "OpenAPI release version");
for (const match of (
  read("src/http.ts") +
  read("src/openai.ts") +
  read("src/image-capabilities.ts")
).matchAll(/app\.(get|post|put|delete)\(\s*["'](\/v1\/[^"']+)["']/g)) {
  const path = match[2]!.replace(/:([A-Za-z]+)/g, "{$1}");
  assert(
    api.paths[path]?.[match[1]!],
    match[1] + " " + path + " missing from OpenAPI",
  );
}
const privatePaths = [
  ".codex/plan.md",
  ".superpowers/plan.md",
  "outputs/design.md",
  ".env",
  "queue.sqlite",
  "node_modules/test",
  "release/test.mcpb",
];
for (const path of privatePaths)
  assert(!files.includes(path), path + " must be excluded from deliverables");
const docsTransport = spawnSync(
  process.env.BRIDGE_PYTHON ?? "python3",
  ["-m", "unittest", "scripts.test_docs_server"],
  { stdio: "inherit" },
);
if (docsTransport.error) throw docsTransport.error;
assert.equal(docsTransport.status, 0, "Documentation transport checks failed");
console.log(
  "Repository notices, documentation links and examples, versions, OpenAPI coverage, and private-file exclusions passed.",
);
