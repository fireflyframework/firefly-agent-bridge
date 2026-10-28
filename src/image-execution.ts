/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import packageMetadata from "../package.json" with { type: "json" };
import type { BridgeConfig } from "./config.js";
import type { QueueStore } from "./store.js";
export type ImageExecution = {
  worker: BridgeConfig["worker"];
  path: string;
  options: BridgeConfig["profiles"][string];
  revision: string;
};
export function imageExecutionRevision(
  execution: Omit<ImageExecution, "revision">,
): string {
  let executable: unknown;
  try {
    const s = statSync(execution.path);
    executable = {
      size: s.size,
      mtime: s.mtimeMs,
      ctime: s.ctimeMs,
      inode: s.ino,
      device: s.dev,
    };
  } catch {
    executable = null;
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapter: "image-input-v1:" + packageMetadata.version,
        worker: execution.worker,
        path: execution.path,
        executable,
        profile: execution.options,
      }),
    )
    .digest("hex");
}
export function currentImageExecution(
  config: BridgeConfig,
  profile: string,
  worker: BridgeConfig["worker"] = config.worker,
): ImageExecution {
  const path = worker === "codex" ? config.codexPath : config.claudePath;
  if (!path)
    throw new Error("Config is missing the absolute path for worker " + worker);
  const execution = {
    worker,
    path,
    options: config.profiles[profile]!,
  };
  return { ...execution, revision: imageExecutionRevision(execution) };
}
export function freezeImageExecution(
  store: QueueStore,
  jobId: string,
  config: BridgeConfig,
  profile: string,
  worker: BridgeConfig["worker"] = config.worker,
): void {
  store.db
    .prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)")
    .run(
      "image-execution:" + jobId,
      JSON.stringify(currentImageExecution(config, profile, worker)),
    );
}
export function loadImageExecution(
  store: QueueStore,
  jobId: string,
): ImageExecution | undefined {
  const row = store.db
    .prepare("SELECT value FROM metadata WHERE key=?")
    .get("image-execution:" + jobId) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as ImageExecution) : undefined;
}
