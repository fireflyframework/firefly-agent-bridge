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

import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
// This catches a small set of prose regressions; editorial review still needs a reader.
const prohibited = [
  /\b(?:delve|tapestry|pivotal|groundbreaking|breathtaking)\b/i,
  /\b(?:I hope this helps|great question|let's dive in|it's worth noting|the real question is|at its core)\b/i,
  /[—–]/,
];
for (const file of [
  "README.md",
  ...readdirSync("docs")
    .filter((f) => f.endsWith(".md"))
    .map((f) => "docs/" + f),
]) {
  const prose = readFileSync(file, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "");
  for (const pattern of prohibited)
    assert(
      !pattern.test(prose),
      file + " has a prose pattern for editorial review: " + pattern,
    );
}
console.log(
  "Scoped prose checks passed; manual Humanizer review remains the editorial acceptance step.",
);
