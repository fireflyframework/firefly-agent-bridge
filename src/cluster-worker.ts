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

import { mkdirSync, readFileSync } from "node:fs";
import { cpus as defaultCpus } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import {
  parseClusterWorkerFile,
  type ClusterWorkerFile,
} from "./cluster-config.js";
import {
  newRequestNonce,
  signWorkerRequest as signEd25519Request,
} from "./cluster-crypto.js";
import {
  collectNodeResources,
  type CollectNodeResourcesOptions,
  type CpuTimesSample,
} from "./cluster-resources.js";
import type { ClusterAttemptControl, NodeCapacity } from "./cluster-types.js";
import { ClaudeWorker } from "./claude.js";
import { CodexWorker } from "./codex.js";
import type { BridgeConfig } from "./config.js";
import type { Attempt, Job, Outcome } from "./contracts.js";
import type { ImageExecution } from "./image-execution.js";
import type { Worker, WorkerEvent, WorkerReadiness } from "./worker.js";

export function assertCoordinatorUrlAllowed(
  coordinatorUrl: string,
  options: { allowInsecure?: boolean } = {},
): void {
  let url: URL;
  try {
    url = new URL(coordinatorUrl);
  } catch {
    throw new Error("Invalid coordinator URL");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && options.allowInsecure) return;
  throw new Error(
    "Coordinator URL must use https:// (set allowInsecure for private lab http:// only)",
  );
}

export type ClusterClaimSnapshot = {
  attempt: Attempt;
  job: Job;
  profile: BridgeConfig["profiles"][string];
  imageExecution?: ImageExecution;
};

export type ClusterWorkerOptions = {
  clusterFile?: ClusterWorkerFile;
  fetch?: typeof fetch;
  /** Override CLI worker construction (tests). */
  workerFactory?: (claim: ClusterClaimSnapshot) => Worker;
  /**
   * Override readiness/auth probe construction (tests). When omitted, uses
   * `workerFactory` with a synthetic claim, or the configured Claude/Codex CLI.
   */
  probeWorker?: () => Worker;
  collectResources?: (
    workspace: string,
    options?: CollectNodeResourcesOptions,
  ) => ReturnType<typeof collectNodeResources>;
  /** Sample OS CPU times for win32 busyRatio delta across heartbeats. */
  sampleCpuTimes?: () => CpuTimesSample[];
  healthPort?: number;
  now?: () => number;
  /** Override heartbeat cadence (tests may use sub-500ms). */
  heartbeatIntervalMs?: number;
  /** Consecutive heartbeat failures before aborting local attempts. */
  heartbeatFailureLimit?: number;
  /** Min interval between CLI readiness probes (default 15s). */
  readinessProbeIntervalMs?: number;
};

export type ClusterWorkerHandle = {
  stop(): Promise<void>;
  activeCount: number;
  health(): Record<string, unknown>;
  address?: string;
};

type ActiveEntry = {
  claim: ClusterClaimSnapshot;
  controller: AbortController;
  promise: Promise<void>;
  control?: ClusterAttemptControl["action"];
};

/**
 * Headless cluster worker: heartbeat → apply controls → claim → run frozen
 * snapshot → forward events/finish. No public client API.
 *
 * Auth: Bearer `ffn_` + Ed25519 signature headers from enrolled nodePrivateKey.
 */
export async function startClusterWorker(
  config: BridgeConfig,
  options: ClusterWorkerOptions = {},
): Promise<ClusterWorkerHandle> {
  const cluster =
    options.clusterFile ??
    parseClusterWorkerFile(
      JSON.parse(
        readFileSync(join(config.dataDir, "cluster.json"), "utf8"),
      ) as unknown,
    );
  assertCoordinatorUrlAllowed(cluster.coordinatorUrl, {
    allowInsecure: cluster.allowInsecure,
  });
  if (!cluster.nodePrivateKey?.includes("PRIVATE KEY"))
    throw new Error(
      "cluster.json is missing nodePrivateKey; re-run bridge cluster join to enroll an Ed25519 key",
    );
  const doFetch = options.fetch ?? fetch;
  const intervalMs =
    options.heartbeatIntervalMs ?? config.cluster?.heartbeatIntervalMs ?? 2000;
  const failureLimit =
    options.heartbeatFailureLimit ??
    Math.max(
      3,
      Math.ceil((config.cluster?.heartbeatOfflineMs ?? 60_000) / intervalMs),
    );
  const reservePercent =
    cluster.reservePercent ?? config.cluster?.reservePercent ?? 10;
  const collect = options.collectResources ?? collectNodeResources;
  const sampleCpuTimes =
    options.sampleCpuTimes ??
    (() => defaultCpus().map((cpu) => ({ ...cpu.times })));

  let previousCpuTimes: CpuTimesSample[] | null = null;
  let stopped = false;
  let ticking = false;
  let heartbeatFailures = 0;
  let draining = false;
  let windowStartedAt = new Date().toISOString();
  let readiness: WorkerReadiness = { ready: false, reason: "probe_pending" };
  let lastReadinessProbeAt = 0;
  const readinessProbeIntervalMs = options.readinessProbeIntervalMs ?? 15_000;
  let estimatedUsedUnits = 0;
  const estimatedCapacityUnits = 100;
  let quotaState: NodeCapacity["quota"]["state"] = "unknown";
  let quotaResetAt: number | null = null;
  const active = new Map<string, ActiveEntry>();
  let healthApp: ReturnType<typeof Fastify> | undefined;
  let healthAddress: string | undefined;

  function signedHeaders(
    method: string,
    path: string,
    bodyText: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: "Bearer " + cluster.credential,
      accept: "application/json",
    };
    if (bodyText.length > 0) headers["content-type"] = "application/json";
    const timestamp = String(Date.now());
    const nonce = newRequestNonce();
    const signature = signEd25519Request({
      privateKeyPem: cluster.nodePrivateKey!,
      timestamp,
      nonce,
      method,
      path,
      body: bodyText,
    });
    headers["x-bridge-timestamp"] = timestamp;
    headers["x-bridge-nonce"] = nonce;
    headers["x-bridge-signature"] = signature;
    return headers;
  }

  async function coordinator(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const headers = signedHeaders(method, path, bodyText);
    return doFetch(cluster.coordinatorUrl.replace(/\/$/, "") + path, {
      method,
      headers,
      body: body === undefined ? undefined : bodyText,
    });
  }

  function authenticationState(): NodeCapacity["authentication"] {
    const state = readiness.authentication?.state;
    if (state === "authenticated") return "authenticated";
    if (state === "required" || state === "unavailable")
      return "unauthenticated";
    return "unknown";
  }

  function createProbeWorker(): Worker {
    if (options.probeWorker) return options.probeWorker();
    if (options.workerFactory) {
      const now = new Date().toISOString();
      return options.workerFactory({
        attempt: {
          id: "probe",
          jobId: "probe",
          owner: "probe",
          fence: "probe",
          status: "running",
          createdAt: now,
          updatedAt: now,
          nodeId: cluster.nodeId,
        },
        job: {
          id: "probe",
          prompt: "",
          profile: "default",
          mode: "cli",
          principalId: "probe",
          status: "running",
          createdAt: now,
          updatedAt: now,
          messages: [],
        },
        profile: config.profiles.default!,
      });
    }
    const path =
      config.worker === "codex" ? config.codexPath : config.claudePath;
    const profile = config.profiles.default!;
    return new (config.worker === "codex" ? CodexWorker : ClaudeWorker)({
      path: path!,
      ...profile,
    });
  }

  async function refreshReadiness(force = false): Promise<void> {
    const now = Date.now();
    if (
      !force &&
      lastReadinessProbeAt > 0 &&
      now - lastReadinessProbeAt < readinessProbeIntervalMs
    )
      return;
    lastReadinessProbeAt = now;
    try {
      readiness = await createProbeWorker().ready();
    } catch {
      readiness = { ready: false, reason: "worker_ready_failed" };
    }
  }

  function buildCapacity(): NodeCapacity {
    const cpuSample = sampleCpuTimes();
    const resources = collect(config.workspace, {
      previousCpuTimes,
      cpus: () => cpuSample.map((times) => ({ times })),
    });
    previousCpuTimes = cpuSample;
    const concurrency = config.concurrency;
    const activeCount = active.size;
    return {
      worker: config.worker,
      concurrency,
      active: activeCount,
      freeSlots: Math.max(0, concurrency - activeCount),
      authentication: authenticationState(),
      quota: {
        state: quotaState,
        resetAt: quotaResetAt,
        windowStartedAt,
        estimatedUsedUnits,
        estimatedCapacityUnits,
      },
      resources,
      reservePercent,
      draining,
    };
  }

  function applyControl(control: ClusterAttemptControl): void {
    const entry = active.get(control.attemptId);
    if (!entry) return;
    if (entry.claim.attempt.fence !== control.fence) return;
    entry.control = control.action;
    entry.controller.abort(control.action === "pause" ? "pause" : "cancel");
  }

  function workerFor(claim: ClusterClaimSnapshot): Worker {
    if (options.workerFactory) return options.workerFactory(claim);
    const selected =
      claim.imageExecution?.worker ?? claim.job.worker ?? config.worker;
    const frozen = claim.imageExecution?.options ?? claim.profile;
    const path = selected === "codex" ? config.codexPath : config.claudePath;
    return new (selected === "codex" ? CodexWorker : ClaudeWorker)({
      path: path!,
      ...frozen,
    });
  }

  async function forwardEvents(
    claim: ClusterClaimSnapshot,
    events: WorkerEvent[],
  ): Promise<void> {
    if (!events.length) return;
    const res = await coordinator(
      "POST",
      `/v1/cluster/attempts/${claim.attempt.id}/events`,
      {
        owner: claim.attempt.owner,
        fence: claim.attempt.fence,
        events,
      },
    );
    if (!res.ok)
      throw new Error(
        `cluster events failed: ${res.status} ${await res.text()}`,
      );
  }

  async function forwardFinish(
    claim: ClusterClaimSnapshot,
    outcome: Outcome,
  ): Promise<void> {
    const res = await coordinator(
      "POST",
      `/v1/cluster/attempts/${claim.attempt.id}/finish`,
      {
        owner: claim.attempt.owner,
        fence: claim.attempt.fence,
        outcome,
      },
    );
    if (!res.ok)
      throw new Error(
        `cluster finish failed: ${res.status} ${await res.text()}`,
      );
  }

  function startClaim(claim: ClusterClaimSnapshot): void {
    if (active.has(claim.attempt.id)) return;
    const cwd = join(config.workspace, claim.job.id);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const worker = workerFor(claim);
    const promise = (async () => {
      try {
        readiness = await worker.ready();
      } catch {
        readiness = { ready: false, reason: "worker_ready_failed" };
      }
      let outcome: Outcome;
      const pending: WorkerEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const flush = async () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = undefined;
        const batch = pending.splice(0, pending.length);
        if (batch.length) await forwardEvents(claim, batch);
      };
      try {
        outcome = await worker.run(
          { job: claim.job, attempt: claim.attempt, cwd },
          (event) => {
            pending.push(event);
            if (!flushTimer)
              flushTimer = setTimeout(() => {
                void flush().catch(() => {});
              }, 25);
          },
          controller.signal,
        );
      } catch {
        outcome = {
          status: "failed",
          error: "worker_failed: execution did not complete",
        };
      }
      try {
        await flush();
      } catch {
        /* finish still reported below */
      }
      const entry = active.get(claim.attempt.id);
      if (entry?.control === "pause" && outcome.status === "canceled")
        outcome = {
          status: "paused",
          error: claim.job.error?.startsWith("cluster_failover:")
            ? claim.job.error
            : "operator_pause",
          sessionId: claim.job.sessionId,
        };
      if (
        entry?.control === "cancel" &&
        outcome.status !== "canceled" &&
        outcome.status !== "paused"
      )
        outcome = {
          status: "interrupted",
          error: "Cancellation could not be confirmed",
        };
      if (outcome.error?.startsWith("quota_exhausted")) {
        quotaState = "limited";
        quotaResetAt =
          typeof outcome.retryAt === "number" ? outcome.retryAt : null;
        estimatedUsedUnits = estimatedCapacityUnits;
        // Pause sibling in-flight attempts on this limited node immediately.
        for (const [siblingId, sibling] of active) {
          if (siblingId === claim.attempt.id) continue;
          if (sibling.control) continue;
          sibling.control = "pause";
          sibling.controller.abort("pause");
        }
      } else if (
        outcome.status === "succeeded" ||
        outcome.status === "failed"
      ) {
        estimatedUsedUnits += 1;
        if (quotaState === "unknown") quotaState = "ok";
      }
      try {
        await forwardFinish(claim, outcome);
      } catch (error) {
        console.error("cluster worker finish failed", error);
      }
    })().finally(() => {
      active.delete(claim.attempt.id);
    });
    active.set(claim.attempt.id, { claim, controller, promise });
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      // Probe CLI auth before heartbeat so the coordinator can mark the node
      // eligible. Without this, authentication stays "unknown" forever and
      // selectNode never assigns work (chicken-and-egg with claim-time ready()).
      await refreshReadiness();
      const capacity = buildCapacity();
      let controls: ClusterAttemptControl[] = [];
      try {
        const res = await coordinator(
          "POST",
          `/v1/cluster/nodes/${cluster.nodeId}/heartbeat`,
          capacity,
        );
        if (!res.ok) throw new Error(`heartbeat ${res.status}`);
        const body = (await res.json()) as {
          controls?: ClusterAttemptControl[];
          status?: string;
        };
        controls = body.controls ?? [];
        if (body.status === "draining") draining = true;
        heartbeatFailures = 0;
      } catch (error) {
        heartbeatFailures += 1;
        console.error("cluster worker heartbeat failed", error);
        if (heartbeatFailures >= failureLimit) {
          for (const entry of active.values()) entry.controller.abort("cancel");
        }
        return;
      }

      for (const control of controls) applyControl(control);

      const freeSlots = Math.max(0, config.concurrency - active.size);
      if (draining || freeSlots <= 0 || !readiness.ready) return;
      if (quotaState === "limited") {
        if (quotaResetAt != null && quotaResetAt <= Date.now()) {
          quotaState = "ok";
          quotaResetAt = null;
          estimatedUsedUnits = 0;
          windowStartedAt = new Date().toISOString();
        } else return;
      }

      try {
        const res = await coordinator(
          "POST",
          `/v1/cluster/nodes/${cluster.nodeId}/claim`,
          { freeSlots, worker: config.worker },
        );
        if (!res.ok) throw new Error(`claim ${res.status}`);
        const body = (await res.json()) as { claims?: ClusterClaimSnapshot[] };
        for (const claim of body.claims ?? []) startClaim(claim);
      } catch (error) {
        console.error("cluster worker claim failed", error);
      }
    } finally {
      ticking = false;
    }
  }

  function health(): Record<string, unknown> {
    return {
      ok: !stopped,
      mode: "worker",
      nodeId: cluster.nodeId,
      coordinatorUrl: cluster.coordinatorUrl,
      active: active.size,
      draining,
      heartbeatFailures,
      readiness,
    };
  }

  if (options.healthPort != null && options.healthPort >= 0) {
    // Loopback-only; do not import createHttpService (avoids UI asset load).
    healthApp = Fastify({
      logger: false,
      bodyLimit: 4096,
      requestTimeout: 5000,
      trustProxy: false,
      forceCloseConnections: true,
    });
    healthApp.get("/health", async () => health());
    healthApp.get("/v1/health", async () => health());
    healthAddress = await healthApp.listen({
      host: "127.0.0.1",
      port: options.healthPort,
    });
  }

  const timer = setInterval(() => {
    void tick().catch((error) =>
      console.error("cluster worker tick failed", error),
    );
  }, intervalMs);
  timer.unref();
  void tick().catch((error) =>
    console.error("cluster worker initial tick failed", error),
  );

  return {
    get activeCount() {
      return active.size;
    },
    health,
    address: healthAddress,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      while (ticking) await new Promise((r) => setTimeout(r, 10));
      for (const entry of active.values()) entry.controller.abort("pause");
      await Promise.allSettled([...active.values()].map((e) => e.promise));
      if (healthApp) await healthApp.close();
    },
  };
}
