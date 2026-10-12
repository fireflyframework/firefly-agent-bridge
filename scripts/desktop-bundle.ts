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

import { readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { Ajv } from "ajv";
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../vendor-licenses/mcpb-manifest-v0.3.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validate = new Ajv({ strict: false, validateFormats: false }).compile(
  schema,
);
export function packDesktopBundle(directory: string, output: string): void {
  const root = resolve(directory);
  const manifest = JSON.parse(
    readFileSync(join(root, "manifest.json"), "utf8"),
  ) as {
    server: { entry_point: string };
    icon?: string;
    screenshots?: string[];
  };
  if (!validate(manifest))
    throw new Error(
      "Invalid MCPB manifest: " + JSON.stringify(validate.errors),
    );
  const resource = (path: string, label: string) => {
    const full = resolve(root, path),
      local = relative(root, full);
    if (isAbsolute(local) || local === ".." || local.startsWith(".." + sep))
      throw new Error(label + " must remain inside the bundle");
    try {
      if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink())
        throw new Error();
    } catch {
      throw new Error("Missing or unsafe " + label + ": " + path);
    }
  };
  resource(manifest.server.entry_point, "native entry binary");
  if (manifest.icon) resource(manifest.icon, "icon");
  for (const path of manifest.screenshots ?? []) resource(path, "screenshot");
  const files: Zippable = Object.create(null) as Zippable;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink())
        throw new Error("Bundle symlinks are forbidden");
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const name = relative(root, full).replaceAll("\\", "/");
        files[name] = [
          readFileSync(full),
          {
            mtime: new Date(1980, 0, 1),
            os: 3,
            attrs: (stat.mode & 0xffff) << 16,
          },
        ];
      }
    }
  };
  visit(root);
  writeFileSync(output, zipSync(files, { level: 6 }), { mode: 0o600 });
}
