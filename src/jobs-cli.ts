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

import { connect, request } from "./lifecycle.js";
import type { CliStreams } from "./cluster-cli.js";

function printJson(streams: CliStreams, value: unknown): void {
  streams.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function requireId(args: string[], label: string): string {
  const id = args[0];
  if (!id) throw new Error(label + " requires a job id");
  return id;
}

/** Headless job inspection and control (JSON on stdout). */
export async function runJobsCommand(
  dataDir: string,
  positionals: string[],
  streams: CliStreams,
): Promise<void> {
  const sub = positionals[0];
  const rest = positionals.slice(1);
  if (!sub || sub === "help") {
    streams.stdout.write(`jobs commands (JSON on stdout):
  list
  get <id>
  pause <id> | resume <id> | cancel <id> | retry <id>
`);
    return;
  }
  const connection = await connect(dataDir);
  if (sub === "list") {
    printJson(streams, await request(connection, "/v1/bridge/jobs"));
    return;
  }
  if (sub === "get") {
    const id = requireId(rest, "jobs get");
    printJson(streams, await request(connection, "/v1/bridge/jobs/" + id));
    return;
  }
  if (["pause", "resume", "cancel", "retry"].includes(sub)) {
    const id = requireId(rest, "jobs " + sub);
    printJson(
      streams,
      await request(connection, "/v1/bridge/jobs/" + id + "/" + sub, {}),
    );
    return;
  }
  throw new Error("Unknown jobs command: " + positionals.join(" "));
}
