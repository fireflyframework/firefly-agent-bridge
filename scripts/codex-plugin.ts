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
  existsSync,
} from "node:fs";
import { resolve, join, isAbsolute, relative } from "node:path";
export function assembleCodexPlugin(
  directory: string,
  executable: string,
): void {
  const root = resolve(directory),
    binary = resolve(root, executable);
  if (
    isAbsolute(executable) ||
    relative(root, binary).startsWith("..") ||
    !existsSync(binary)
  )
    throw new Error("Codex executable must exist inside its plugin root");
  cpSync("integrations/codex/.codex-plugin", join(root, ".codex-plugin"), {
    recursive: true,
  });
  cpSync("integrations/codex/skills", join(root, "skills"), {
    recursive: true,
  });
  const mcp = JSON.parse(readFileSync("integrations/codex/.mcp.json", "utf8"));
  mcp.mcpServers["firefly-agent-bridge"].command =
    "${PLUGIN_ROOT}/" + executable.replaceAll("\\", "/");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
  cpSync(
    "integrations/codex/.mcp.json.license",
    join(root, ".mcp.json.license"),
  );
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  cpSync(
    "integrations/codex/marketplace.json",
    join(root, ".agents", "plugins", "marketplace.json"),
  );
  cpSync(
    "integrations/codex/marketplace.json.license",
    join(root, ".agents", "plugins", "marketplace.json.license"),
  );
  mkdirSync(join(root, "assets"), { recursive: true });
  for (const name of [
    "bridge-mark-light.svg",
    "bridge-lockup-light.svg",
    "bridge-lockup-dark.svg",
    "NOTICE",
  ])
    cpSync("assets/brand/" + name, join(root, "assets", name));
}
