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

/** Hand-authored span mark (deck + piers + arch) — keep ≤12 lines, ≤72 cols. */
export const BRIDGE_BANNER = `        ·----·
   =====|    |=====
   ||   |    |   ||
   ||   |    |   ||
  _||___|    |___||_
 /__________________\\
        BRIDGE
   Firefly Agent Bridge`;

const AMBER = "\u001b[38;2;255;179;74m";
const RESET = "\u001b[0m";

export type BannerIo = {
  isTTY?: boolean;
};

export function shouldShowBanner(
  stdout: BannerIo = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!stdout.isTTY) return false;
  if (env.BRIDGE_NO_BANNER) return false;
  if (env.NO_COLOR) return false;
  if (env.CI) return false;
  return true;
}

export function formatWelcome(
  version: string,
  options: { color?: boolean } = {},
): string {
  const art = options.color
    ? AMBER + BRIDGE_BANNER + RESET
    : BRIDGE_BANNER;
  return `${art}
Firefly Agent Bridge ${version}

Quick start
  bridge init --worker claude
  bridge serve
  bridge cluster init-coordinator --exposure internet …
  bridge daemon start --cluster-worker

Docs: https://fireflyframework.github.io/firefly-agent-bridge/
`;
}

export function printWelcome(
  version: string,
  stdout: {
    isTTY?: boolean;
    write: (chunk: string) => boolean;
  } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldShowBanner(stdout, env)) return;
  const color = Boolean(stdout.isTTY) && !env.NO_COLOR && !env.BRIDGE_NO_BANNER;
  stdout.write(formatWelcome(version, { color }) + "\n");
}
