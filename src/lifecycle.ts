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
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import { isSea } from "node:sea";
import { parseConfig, type BridgeConfig } from "./config.js";
import { privateWrite } from "./service.js";
export function defaultDataDir(): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
        : (process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"));
  return join(base, "Firefly Agent Bridge");
}

/**
 * Locate only the requested coding CLI. Hosts may have Claude or Codex alone;
 * never require the other binary. Walks HOME/.local/bin then PATH entries
 * without invoking `which`/`where` (those tools need a populated PATH).
 */
export function resolveCodingAgentExecutable(
  worker: "claude" | "codex",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const binary = process.platform === "win32" ? worker + ".exe" : worker;
  const home =
    env.HOME ??
    env.USERPROFILE ??
    (typeof homedir === "function" ? homedir() : "");
  if (home) {
    const homeLocal = join(home, ".local", "bin", binary);
    if (existsSync(homeLocal)) return homeLocal;
  }
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, binary);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Install and sign in to the selected official coding agent: " + worker,
  );
}

/** Absolute path already stored for this worker type, if any. */
export function configuredWorkerPath(
  config: BridgeConfig,
  worker: "claude" | "codex" = config.worker,
): string | undefined {
  return worker === "codex" ? config.codexPath : config.claudePath;
}

export async function initialize(
  dataDir = defaultDataDir(),
  worker: "claude" | "codex" = "codex",
): Promise<BridgeConfig> {
  dataDir = resolve(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(join(dataDir, "setup"), {
    realpath: false,
    retries: { retries: 50, minTimeout: 100, maxTimeout: 200 },
  });
  try {
    const file = join(dataDir, "config.json");
    if (existsSync(file)) {
      const config = parseConfig(JSON.parse(readFileSync(file, "utf8")));
      if (config.dataDir !== dataDir)
        throw new Error(
          "config.json dataDir must match the selected data directory",
        );
      return config;
    }
    const executablePath = resolveCodingAgentExecutable(worker);
    const config = parseConfig({
      dataDir,
      workspace: join(dataDir, "jobs"),
      worker,
      profiles: { default: { workDuration: { version: 1, timeoutMs: null } } },
      ...(worker === "codex"
        ? { codexPath: executablePath }
        : { claudePath: executablePath }),
    });
    privateWrite(file, JSON.stringify(config, null, 2) + "\n");
    return config;
  } finally {
    await release();
  }
}
export type Connection = { address: string; token: string };
export async function connect(dataDir: string): Promise<Connection> {
  const info = JSON.parse(
    readFileSync(join(dataDir, "service.json"), "utf8"),
  ) as { address: string; instanceId: string };
  const url = new URL(info.address);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Invalid local service address");
  const token = readFileSync(join(dataDir, "owner.token"), "utf8").trim();
  const response = await fetch(info.address + "/v1/bridge/status", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error("Bridge service authentication failed");
  const status = (await response.json()) as {
    instanceId: string;
    protocolVersion: number;
  };
  if (status.instanceId !== info.instanceId || status.protocolVersion !== 2)
    throw new Error("Bridge service identity or protocol does not match");
  return { address: info.address, token };
}
export async function ensureService(dataDir: string): Promise<Connection> {
  await initialize(dataDir);
  try {
    return await connect(dataDir);
  } catch {
    /* A stale discovery file is normal after the last host exits. */
  }
  const log = openSync(join(dataDir, "service.log"), "a", 0o600);
  const args = isSea() ? [] : [process.argv[1]!];
  const child = spawn(
    process.execPath,
    [...args, "serve", "--managed", "--data-dir", dataDir],
    { detached: true, stdio: ["ignore", log, log], windowsHide: true },
  );
  child.on("error", () => {});
  child.unref();
  closeSync(log);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await connect(dataDir);
    } catch {
      /* Another host may currently hold the startup lock. */
    }
  }
  throw new Error(
    "Bridge startup failed. Inspect service.log in the data directory.",
  );
}
export async function request(
  connection: Connection,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<unknown> {
  const response = await fetch(connection.address + path, {
    method,
    headers: {
      Authorization: "Bearer " + connection.token,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  const value = (await response.json()) as { error?: { message?: string } };
  if (!response.ok)
    throw new Error(value.error?.message ?? "Bridge request failed");
  return value;
}
