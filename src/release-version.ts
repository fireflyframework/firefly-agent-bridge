/*!
 * Copyright 2026 Firefly Software Foundation
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

import metadata from "../package.json" with { type: "json" };
export const releaseVersion = metadata.version;
export function releaseHtml(template: string): string {
  const marker = "__BRIDGE_RELEASE_VERSION__";
  if (template.split(marker).length !== 2)
    throw new Error(
      "Dashboard must contain exactly one release version marker",
    );
  return template.replace(marker, releaseVersion);
}
