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
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  imageExecutionRevision,
  loadImageExecution,
  type ImageExecution,
} from "./image-execution.js";
import { prepareCompletion } from "./completion-protocol.js";
import { cleanupRecoveredImages } from "./images.js";
import { QueueStore } from "./store.js";
import { Tokens } from "./auth.js";
import { Workflows } from "./workflows.js";
import { Scheduler } from "./scheduler.js";
import { CodexWorker } from "./codex.js";
import { ClaudeWorker } from "./claude.js";
import { createHttpService } from "./http.js";
import { ClusterAuth } from "./cluster-auth.js";
import { ClusterCoordinator } from "./cluster-coordinator.js";
import { ClusterRegistry } from "./cluster-registry.js";
import { startClusterWorker } from "./cluster-worker.js";
import type { BridgeConfig } from "./config.js";
import type { Worker } from "./worker.js";
import type { Job } from "./contracts.js";
export function privateWrite(path: string, value: string): void {
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}

function loadCoordinatorTls(
  config: BridgeConfig,
): { key: Buffer; cert: Buffer } | undefined {
  const cluster = config.cluster;
  if (!cluster || cluster.mode !== "coordinator") return undefined;
  const requireTls = cluster.requireTls || cluster.exposure === "internet";
  if (!requireTls) return undefined;
  const certPath = cluster.tlsCertPath;
  const keyPath = cluster.tlsKeyPath;
  if (!certPath || !keyPath)
    throw new Error(
      "TLS is required (exposure=internet or requireTls); set cluster.tlsCertPath and cluster.tlsKeyPath",
    );
  if (!existsSync(certPath) || !existsSync(keyPath))
    throw new Error(
      "TLS cert/key files are missing; refuse to start internet-exposed coordinator",
    );
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}
export async function startService(
  config: BridgeConfig,
  options: {
    managed?: boolean;
    worker?: (job: Job, imageExecution?: ImageExecution) => Worker;
    /** Worker-only: optional JSON health on 127.0.0.1 (Task 6 wires --health-port). */
    healthPort?: number;
  } = {},
) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
  let compromised = false;
  let closeService: () => Promise<void> = async () => {};
  // One renewable OS-visible lock protects both SQLite recovery and process ownership.
  const release = await lockfile.lock(join(config.dataDir, "service"), {
    realpath: false,
    stale: 10000,
    update: 2000,
    onCompromised: () => {
      compromised = true;
      void closeService();
    },
  });
  let opened: QueueStore | undefined;
  try {
    const store = (opened = new QueueStore(
      join(config.dataDir, "queue.sqlite"),
      config.queueCapacity,
    ));
    const auth = new Tokens(store),
      flows = new Workflows(store, config.workflows);
    const ownerPath = join(config.dataDir, "owner.token");
    let ownerToken = existsSync(ownerPath)
      ? readFileSync(ownerPath, "utf8").trim()
      : "";
    try {
      auth.verify(ownerToken);
    } catch {
      ownerToken = auth.create({
        id: "owner",
        owner: true,
        profiles: Object.keys(config.profiles),
      }).token;
      privateWrite(ownerPath, ownerToken + "\n");
    }
    chmodSync(ownerPath, 0o600);
    chmodSync(join(config.dataDir, "queue.sqlite"), 0o600);
    const workerFor = (job: Job): Worker => {
      const snapshot = loadImageExecution(store, job.id);
      const selected = snapshot?.worker ?? config.worker;
      const worker =
        options.worker?.(job, snapshot) ??
        new (selected === "codex" ? CodexWorker : ClaudeWorker)({
          path:
            snapshot?.path ??
            (selected === "codex" ? config.codexPath : config.claudePath)!,
          ...(snapshot?.options ?? config.profiles[job.profile]!),
        });
      if (!job.completion || !prepareCompletion(job.completion).images.length)
        return worker;
      return {
        ready: () =>
          snapshot && imageExecutionRevision(snapshot) === snapshot.revision
            ? worker.ready()
            : Promise.resolve({ ready: true }),
        run: (input, emit, signal) => {
          if (
            !snapshot ||
            imageExecutionRevision(snapshot) !== snapshot.revision
          )
            return Promise.resolve({
              status: "failed",
              error:
                "image_configuration_changed: executable or image execution snapshot is unavailable; start a new explicit request",
            });
          return worker.run(input, emit, signal);
        },
      };
    };
    const isCoordinator = config.cluster?.mode === "coordinator";
    const isWorker = config.cluster?.mode === "worker";
    const scheduler = new Scheduler(
      store,
      flows,
      workerFor,
      config.workspace,
      config.concurrency,
      !isCoordinator && !isWorker,
    );
    scheduler.readiness = options.worker
      ? { ready: true }
      : isCoordinator
        ? { ready: true, reason: "cluster_coordinator" }
        : isWorker
          ? { ready: true, reason: "cluster_worker" }
          : {
              ready: false,
              reason:
                "Checking the official " +
                config.worker +
                " subscription login",
            };
    const cluster = isCoordinator
      ? new ClusterCoordinator(
          store,
          new ClusterRegistry(store, new ClusterAuth(store), {
            worker: config.worker,
            reservePercent: config.cluster!.reservePercent,
            heartbeatStaleMs: config.cluster!.heartbeatStaleMs,
            heartbeatOfflineMs: config.cluster!.heartbeatOfflineMs,
          }),
          new ClusterAuth(store),
          config,
        )
      : undefined;
    const instanceId = randomUUID(),
      hosts = new Map<string, number>();
    let closing: Promise<void> | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      idleSince = Date.now();
    let clusterWorker:
      Awaited<ReturnType<typeof startClusterWorker>> | undefined;

    if (isWorker) {
      function close(): Promise<void> {
        return (closing ??= (async () => {
          if (timer) clearInterval(timer);
          try {
            await clusterWorker?.stop();
          } finally {
            try {
              await scheduler.stop();
            } finally {
              try {
                store.close();
              } finally {
                await release().catch(() => {});
              }
            }
          }
        })());
      }
      closeService = close;
      try {
        clusterWorker = await startClusterWorker(config, {
          healthPort: options.healthPort,
          ...(options.worker
            ? {
                workerFactory: (claim) =>
                  options.worker!(claim.job, claim.imageExecution),
              }
            : {}),
        });
        const address =
          clusterWorker.address ??
          "cluster-worker://" +
            JSON.parse(
              readFileSync(join(config.dataDir, "cluster.json"), "utf8"),
            ).nodeId;
        privateWrite(
          join(config.dataDir, "service.json"),
          JSON.stringify({
            address,
            instanceId,
            protocolVersion: 2,
            pid: process.pid,
            clusterMode: "worker",
          }),
        );
        timer = setInterval(() => {
          if (compromised) void close();
        }, 1000);
        timer.unref();
        return { address, ownerToken, instanceId, store, scheduler, close };
      } catch (error) {
        await close();
        throw error;
      }
    }

    const tls = isCoordinator ? loadCoordinatorTls(config) : undefined;
    const app = createHttpService(
      {
        store,
        auth,
        scheduler,
        flows,
        config,
        cluster,
        persistConfig: (next) =>
          privateWrite(
            join(config.dataDir, "config.json"),
            JSON.stringify(next, null, 2) + "\n",
          ),
        diagnostics: () => ({
          instanceId,
          pid: process.pid,
          managed: Boolean(options.managed),
          hosts: hosts.size,
          dataDir: config.dataDir,
          workspace: config.workspace,
        }),
        heartbeat: (id) => {
          hosts.set(id, Date.now());
          idleSince = Date.now();
        },
        disconnect: (id) => {
          hosts.delete(id);
        },
        shutdown: () => {
          setTimeout(() => void close(), 50);
        },
      },
      tls ? { https: tls } : {},
    );
    function close(): Promise<void> {
      return (closing ??= (async () => {
        if (timer) clearInterval(timer);
        // Close public streams first, then reconcile child processes before releasing the database lock.
        try {
          await app.close();
        } finally {
          try {
            await scheduler.stop();
          } finally {
            try {
              store.close();
            } finally {
              await release().catch(() => {});
            }
          }
        }
      })());
    }
    closeService = close;
    let address: string;
    try {
      const listenHost =
        isCoordinator && config.cluster?.bindHost
          ? config.cluster.bindHost
          : config.host;
      address = await app.listen({ host: listenHost, port: config.port });
      // A port collision must not mark another instance's work as interrupted.
      const recovering = store.db
        .prepare(
          "SELECT data FROM jobs WHERE status IN ('running','cancel_requested','pause_requested')",
        )
        .all() as { data: string }[];
      store.recover();
      for (const row of recovering) {
        const job = JSON.parse(row.data) as Job;
        if (job.completion)
          cleanupRecoveredImages(join(config.workspace, job.id));
      }
      scheduler.start();
      privateWrite(
        join(config.dataDir, "service.json"),
        JSON.stringify({
          address,
          instanceId,
          protocolVersion: 2,
          pid: process.pid,
        }),
      );
      timer = setInterval(() => {
        for (const [id, seen] of hosts)
          if (Date.now() - seen > 7000) hosts.delete(id);
        cluster?.tick();
        const newest = store.db
          .prepare("SELECT MAX(id) AS id FROM events")
          .get() as { id: number | null };
        if ((newest.id ?? 0) - store.eventFloor() > 10000)
          store.pruneEvents(newest.id! - 10000);
        if (hosts.size || scheduler.activeCount || store.pending("cli").length)
          idleSince = Date.now();
        if (
          compromised ||
          (options.managed && Date.now() - idleSince > config.idleMs)
        )
          void close();
      }, 1000);
      timer.unref();
      if (!options.worker && !isCoordinator)
        void new (config.worker === "codex" ? CodexWorker : ClaudeWorker)({
          path: (config.worker === "codex"
            ? config.codexPath
            : config.claudePath)!,
          ...config.profiles.default!,
        })
          .ready()
          .then((ready) => {
            if (!closing && !scheduler.controlState.paused)
              scheduler.readiness = ready;
          });
    } catch (error) {
      await close();
      throw error;
    }
    return { address, ownerToken, instanceId, store, scheduler, close };
  } catch (error) {
    opened?.close();
    await release().catch(() => {});
    throw error;
  }
}
