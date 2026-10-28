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

import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join as pathJoin } from "node:path";
import { parseConfig, type BridgeConfig } from "./config.js";
import {
  parseClusterWorkerFile,
  type ClusterWorkerFile,
} from "./cluster-config.js";
import { connect, initialize, request, type Connection } from "./lifecycle.js";
import { privateWrite } from "./service.js";

export type CliStreams = {
  stdout: { isTTY?: boolean; write: (chunk: string) => boolean };
  stderr: { isTTY?: boolean; write: (chunk: string) => boolean };
  env: NodeJS.ProcessEnv;
};

function printJson(streams: CliStreams, value: unknown): void {
  streams.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match)
    throw new Error("Invalid duration; use Ns, Nm, Nh, or Nd (e.g. 24h)");
  const n = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const mult =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return n * mult;
}

function readConfig(dataDir: string): BridgeConfig {
  const file = pathJoin(dataDir, "config.json");
  if (!existsSync(file))
    throw new Error("Run bridge init before cluster commands");
  return parseConfig(JSON.parse(readFileSync(file, "utf8")));
}

function writeConfig(config: BridgeConfig): void {
  privateWrite(
    pathJoin(config.dataDir, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}

/** Local admin connect; remap 0.0.0.0/:: bind advertisements to loopback. */
export async function connectClusterAdmin(
  dataDir: string,
): Promise<Connection> {
  try {
    return await connect(dataDir);
  } catch {
    /* Fall through to remapped address for coordinator binds. */
  }
  const info = JSON.parse(
    readFileSync(pathJoin(dataDir, "service.json"), "utf8"),
  ) as { address: string; instanceId: string };
  const url = new URL(info.address);
  if (url.protocol !== "http:")
    throw new Error("Invalid local service address");
  if (url.hostname === "0.0.0.0" || url.hostname === "::")
    url.hostname = "127.0.0.1";
  else if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw new Error("Invalid local service address");
  const address = url.toString().replace(/\/$/, "");
  const token = readFileSync(pathJoin(dataDir, "owner.token"), "utf8").trim();
  const response = await fetch(address + "/v1/bridge/status", {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error("Bridge service authentication failed");
  return { address, token };
}

function readWorkerCluster(dataDir: string): ClusterWorkerFile {
  const file = pathJoin(dataDir, "cluster.json");
  if (!existsSync(file))
    throw new Error("Missing cluster.json; run bridge cluster join first");
  return parseClusterWorkerFile(JSON.parse(readFileSync(file, "utf8")));
}

async function workerRequest(
  cluster: ClusterWorkerFile,
  path: string,
  method: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(
    cluster.coordinatorUrl.replace(/\/$/, "") + path,
    {
      method,
      headers: {
        Authorization: "Bearer " + cluster.credential,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const value = (await response.json()) as { error?: { message?: string } };
  if (!response.ok)
    throw new Error(value.error?.message ?? "Cluster request failed");
  return value;
}

async function initCoordinator(
  dataDir: string,
  args: string[],
  streams: CliStreams,
): Promise<void> {
  await initialize(dataDir);
  const config = readConfig(dataDir);
  const exposure = (flagValue(args, "--exposure") ?? "internet") as
    | "internet"
    | "private";
  if (exposure !== "internet" && exposure !== "private")
    throw new Error("--exposure must be internet or private");
  const bind = flagValue(args, "--bind") ?? "0.0.0.0";
  const portRaw = flagValue(args, "--port");
  const port = portRaw != null ? Number(portRaw) : config.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("--port must be an integer 0–65535");
  const reserveRaw = flagValue(args, "--reserve-percent");
  const reservePercent =
    reserveRaw != null ? Number(reserveRaw) : (config.cluster?.reservePercent ?? 10);
  if (
    !Number.isInteger(reservePercent) ||
    reservePercent < 0 ||
    reservePercent > 90
  )
    throw new Error("--reserve-percent must be an integer 0–90");
  const requireTls = exposure === "internet";
  const next = parseConfig({
    ...config,
    port,
    cluster: {
      ...(config.cluster ?? {}),
      mode: "coordinator",
      bindHost: bind,
      reservePercent,
      requireTls,
    },
  });
  writeConfig(next);
  const hintHost = bind === "0.0.0.0" ? "<public-host>" : bind;
  printJson(streams, {
    dataDir,
    exposure,
    addressHint: `${requireTls ? "https" : "http"}://${hintHost}:${port || "<port>"}`,
  });
}

async function joinTokenCreate(
  dataDir: string,
  args: string[],
  streams: CliStreams,
): Promise<void> {
  const connection = await connectClusterAdmin(dataDir);
  const ttl = flagValue(args, "--ttl");
  const body =
    ttl != null ? { ttlMs: parseDurationMs(ttl) } : {};
  const result = await request(
    connection,
    "/v1/bridge/admin/cluster/join-tokens",
    body,
  );
  printJson(streams, result);
}

async function joinTokenRevoke(
  dataDir: string,
  args: string[],
  streams: CliStreams,
): Promise<void> {
  const id = flagValue(args, "--id");
  if (!id) throw new Error("join-token revoke requires --id ID");
  const connection = await connectClusterAdmin(dataDir);
  const result = await request(
    connection,
    "/v1/bridge/admin/cluster/join-tokens/revoke",
    { id },
  );
  printJson(streams, result);
}

async function join(
  dataDir: string,
  args: string[],
  streams: CliStreams,
): Promise<void> {
  await initialize(dataDir);
  const config = readConfig(dataDir);
  const coordinator = flagValue(args, "--coordinator");
  if (!coordinator) throw new Error("cluster join requires --coordinator URL");
  const token =
    flagValue(args, "--token") ?? streams.env.BRIDGE_JOIN_TOKEN ?? undefined;
  if (!token)
    throw new Error(
      "cluster join requires --token TOKEN or BRIDGE_JOIN_TOKEN",
    );
  const name = flagValue(args, "--name") ?? hostname();
  const reserveRaw = flagValue(args, "--reserve-percent");
  const reservePercent =
    reserveRaw != null ? Number(reserveRaw) : undefined;
  if (
    reservePercent != null &&
    (!Number.isInteger(reservePercent) ||
      reservePercent < 0 ||
      reservePercent > 90)
  )
    throw new Error("--reserve-percent must be an integer 0–90");
  const response = await fetch(
    coordinator.replace(/\/$/, "") + "/v1/cluster/join",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        name,
        worker: config.worker,
        concurrency: config.concurrency,
        ...(reservePercent != null ? { reservePercent } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const value = (await response.json()) as {
    nodeId?: string;
    credential?: string;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(value.error?.message ?? "Cluster join failed");
  if (!value.nodeId || !value.credential)
    throw new Error("Cluster join response missing nodeId or credential");
  const clusterFile: ClusterWorkerFile = {
    coordinatorUrl: coordinator.replace(/\/$/, ""),
    nodeId: value.nodeId,
    credential: value.credential,
    reservePercent: reservePercent ?? null,
  };
  privateWrite(
    pathJoin(dataDir, "cluster.json"),
    JSON.stringify(clusterFile, null, 2) + "\n",
  );
  writeConfig(
    parseConfig({
      ...config,
      cluster: {
        ...(config.cluster ?? {}),
        mode: "worker",
        reservePercent:
          reservePercent ?? config.cluster?.reservePercent ?? 10,
      },
    }),
  );
  printJson(streams, {
    nodeId: value.nodeId,
    coordinatorUrl: clusterFile.coordinatorUrl,
  });
}

async function status(dataDir: string, streams: CliStreams): Promise<void> {
  const config = readConfig(dataDir);
  if (config.cluster?.mode === "worker") {
    const cluster = readWorkerCluster(dataDir);
    let reachable = false;
    let error: string | undefined;
    try {
      const probe = await fetch(
        cluster.coordinatorUrl.replace(/\/$/, "") + "/v1/bridge/status",
        { signal: AbortSignal.timeout(3000) },
      );
      reachable = probe.status > 0;
    } catch (err) {
      error = err instanceof Error ? err.message : "unreachable";
      reachable = false;
    }
    printJson(streams, {
      mode: "worker",
      nodeId: cluster.nodeId,
      coordinatorUrl: cluster.coordinatorUrl,
      coordinatorReachable: reachable,
      ...(error ? { error } : {}),
    });
    return;
  }
  const connection = await connectClusterAdmin(dataDir);
  const result = (await request(connection, "/v1/bridge/status")) as {
    cluster?: unknown;
  };
  printJson(streams, result.cluster ?? result);
}

async function nodes(dataDir: string, streams: CliStreams): Promise<void> {
  const connection = await connectClusterAdmin(dataDir);
  const result = (await request(connection, "/v1/bridge/status")) as {
    cluster?: { nodes?: unknown };
  };
  printJson(streams, { nodes: result.cluster?.nodes ?? [] });
}

async function verifyNode(
  dataDir: string,
  args: string[],
  streams: CliStreams,
): Promise<void> {
  const id = flagValue(args, "--id");
  if (!id) throw new Error("verify-node requires --id NODE");
  const connection = await connectClusterAdmin(dataDir);
  const result = await request(
    connection,
    "/v1/bridge/admin/cluster/nodes/" + encodeURIComponent(id),
  );
  printJson(streams, result);
}

async function selfDrainOrLeave(
  dataDir: string,
  action: "drain" | "leave",
  streams: CliStreams,
): Promise<void> {
  const cluster = readWorkerCluster(dataDir);
  const result =
    action === "drain"
      ? await workerRequest(
          cluster,
          `/v1/cluster/nodes/${cluster.nodeId}/drain`,
          "POST",
          {},
        )
      : await workerRequest(
          cluster,
          `/v1/cluster/nodes/${cluster.nodeId}`,
          "DELETE",
        );
  printJson(streams, result);
}

async function adminNodeAction(
  dataDir: string,
  action: "drain" | "remove",
  args: string[],
  streams: CliStreams,
): Promise<void> {
  const id = flagValue(args, "--id");
  if (!id) throw new Error(`nodes ${action} requires --id NODE`);
  const connection = await connectClusterAdmin(dataDir);
  const path =
    "/v1/bridge/admin/cluster/nodes/" + encodeURIComponent(id);
  const result =
    action === "drain"
      ? await request(connection, path + "/drain", {})
      : await request(connection, path, undefined, "DELETE");
  printJson(streams, result);
}

async function pauseResume(
  dataDir: string,
  action: "pause" | "resume",
  streams: CliStreams,
): Promise<void> {
  const connection = await connectClusterAdmin(dataDir);
  const result = await request(
    connection,
    "/v1/bridge/admin/" + action,
    {},
  );
  printJson(streams, result);
}

export async function runClusterCommand(
  dataDir: string,
  positionals: string[],
  streams: CliStreams,
): Promise<void> {
  const [sub, sub2, ...rest] = positionals;
  const args = positionals.slice(1);
  if (!sub || sub === "help") {
    streams.stdout.write(`cluster commands (JSON on stdout):
  init-coordinator [--exposure internet|private] [--bind HOST] [--port N] [--reserve-percent N]
  join-token create [--ttl DURATION]
  join-token revoke --id ID
  join --coordinator URL [--token TOKEN] [--name LABEL] [--reserve-percent N]
  status | nodes | verify-node --id NODE
  drain | leave | pause | resume
  nodes drain --id NODE | nodes remove --id NODE
Token may also come from BRIDGE_JOIN_TOKEN.
`);
    return;
  }
  if (sub === "init-coordinator")
    return initCoordinator(dataDir, args, streams);
  if (sub === "join-token" && sub2 === "create")
    return joinTokenCreate(dataDir, rest, streams);
  if (sub === "join-token" && sub2 === "revoke")
    return joinTokenRevoke(dataDir, rest, streams);
  if (sub === "join") return join(dataDir, args, streams);
  if (sub === "status") return status(dataDir, streams);
  if (sub === "nodes" && !sub2) return nodes(dataDir, streams);
  if (sub === "nodes" && sub2 === "drain")
    return adminNodeAction(dataDir, "drain", rest, streams);
  if (sub === "nodes" && sub2 === "remove")
    return adminNodeAction(dataDir, "remove", rest, streams);
  if (sub === "verify-node") return verifyNode(dataDir, args, streams);
  if (sub === "drain") return selfDrainOrLeave(dataDir, "drain", streams);
  if (sub === "leave") return selfDrainOrLeave(dataDir, "leave", streams);
  if (sub === "pause") return pauseResume(dataDir, "pause", streams);
  if (sub === "resume") return pauseResume(dataDir, "resume", streams);
  throw new Error("Unknown cluster command: " + positionals.join(" "));
}

export { hasFlag, flagValue };
