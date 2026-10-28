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

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";
import { ClusterAuth } from "./cluster-auth.js";
import { ReplayNonceStore, verifyWorkerRequest } from "./cluster-crypto.js";
import { headroom, usableCapacity } from "./cluster-quota.js";
import { DEFAULT_SCHEDULING } from "./cluster-config.js";
import { ClusterRegistry } from "./cluster-registry.js";
import { exhaustedNodeResources } from "./cluster-resources.js";
import { selectNode, type RouterNode } from "./cluster-router.js";
import {
  nodeCapacitySchema,
  type ClusterAttemptControl,
  type ClusterStatus,
  type NodeCapacity,
} from "./cluster-types.js";
import {
  BridgeError,
  type Attempt,
  type ClusterHandoff,
  type Job,
  type Outcome,
} from "./contracts.js";
import { freezeImageExecution, loadImageExecution } from "./image-execution.js";
import { QueueStore } from "./store.js";
import type { WorkerEvent } from "./worker.js";

const DISPATCH_KEY = "cluster_dispatch";
const LAST_ASSIGNED_PREFIX = "cluster_last_assigned:";
const FAILOVER_COUNTER_KEY = "cluster_failover_count";

export type ClusterClaimEntry = {
  attempt: Attempt;
  job: Job;
  profile: BridgeConfig["profiles"][string];
  imageExecution?: ReturnType<typeof loadImageExecution>;
};

export type WorkerAuthContext = {
  nodeId: string;
  credential: string;
};

/**
 * Coordinator claim/finish/events/controls plane.
 * Worker identity: Bearer `ffn_` plus Ed25519 request signatures.
 */
export class ClusterCoordinator {
  private readonly nonceStore = new ReplayNonceStore();

  constructor(
    private store: QueueStore,
    private registry: ClusterRegistry,
    private auth: ClusterAuth,
    private config: BridgeConfig,
  ) {}

  private get scheduling() {
    return this.config.cluster?.scheduling ?? DEFAULT_SCHEDULING;
  }

  private get requestSkewMs(): number {
    return this.config.cluster?.requestSkewMs ?? 60_000;
  }

  private get maxFailovers(): number {
    return this.config.cluster?.maxFailovers ?? 3;
  }

  private bumpFailoverTelemetry(): void {
    const row = this.store.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(FAILOVER_COUNTER_KEY) as { value: string } | undefined;
    const next = (row ? Number(row.value) || 0 : 0) + 1;
    this.store.db
      .prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)")
      .run(FAILOVER_COUNTER_KEY, String(next));
  }

  private failoverJob(
    jobId: string,
    input: { reason: ClusterHandoff["reason"]; fromNodeId: string },
  ): Job {
    const before = this.store.get(jobId);
    const after = this.store.beginClusterFailover(jobId, {
      ...input,
      maxFailovers: this.maxFailovers,
    });
    if (
      after.failoverCount != null &&
      after.failoverCount !== before.failoverCount &&
      after.status !== "pause_requested"
    )
      this.bumpFailoverTelemetry();
    return after;
  }

  private failoverReasonFromError(
    error: string | undefined,
  ): ClusterHandoff["reason"] | null {
    if (!error) return null;
    if (error.startsWith("cluster_failover:")) {
      const code = error.slice("cluster_failover:".length);
      if (
        code === "quota" ||
        code === "health" ||
        code === "offline" ||
        code === "drain"
      )
        return code;
    }
    if (error.startsWith("quota_exhausted")) return "quota";
    return null;
  }

  /** Resolve ffn_ credential → node (signature checked separately). */
  authenticateWorker(credential: string): WorkerAuthContext {
    const node = this.registry.findByCredential(credential);
    if (!node)
      throw new BridgeError(
        "unauthorized",
        "Valid node credential is required",
        401,
      );
    return { nodeId: node.id, credential };
  }

  /**
   * Verify Ed25519 headers for a worker request after credential resolution.
   */
  authenticateWorkerRequest(input: {
    credential: string;
    method: string;
    path: string;
    body: string;
    timestamp?: string;
    nonce?: string;
    signature?: string;
  }): WorkerAuthContext {
    const auth = this.authenticateWorker(input.credential);
    const node = this.registry.get(auth.nodeId);
    if (!node.publicKey)
      throw new BridgeError(
        "unauthorized",
        "Node has no enrolled public key",
        401,
      );
    if (!input.timestamp || !input.nonce || !input.signature)
      throw new BridgeError(
        "unauthorized",
        "Signed worker request headers are required",
        401,
      );
    const verified = verifyWorkerRequest({
      publicKeyPem: node.publicKey,
      timestamp: input.timestamp,
      nonce: input.nonce,
      method: input.method,
      path: input.path,
      body: input.body,
      signature: input.signature,
      skewMs: this.requestSkewMs,
      nonceStore: this.nonceStore,
    });
    if (!verified.ok)
      throw new BridgeError("unauthorized", verified.reason, 401);
    this.registry.markSigned(auth.nodeId);
    return auth;
  }

  assertNodePath(auth: WorkerAuthContext, pathNodeId: string): void {
    if (auth.nodeId !== pathNodeId)
      throw new BridgeError(
        "forbidden",
        "Node credential cannot act for another node",
        403,
      );
  }

  join(input: {
    token: string;
    name: string;
    worker: "claude" | "codex";
    concurrency: number;
    reservePercent?: number | null;
    publicKey: string;
  }): { nodeId: string; credential: string } {
    return this.registry.join(input);
  }

  get dispatchPaused(): boolean {
    const row = this.store.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(DISPATCH_KEY) as { value: string } | undefined;
    if (!row) return false;
    try {
      return Boolean((JSON.parse(row.value) as { paused?: boolean }).paused);
    } catch {
      return false;
    }
  }

  /** Pool-wide admin pause: durable gate + pause_requested on running cluster attempts. */
  pauseDispatch(reason = "operator_pause"): void {
    this.store.atomic(() => {
      this.store.db.prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)").run(
        DISPATCH_KEY,
        JSON.stringify({
          paused: true,
          reason,
          at: new Date().toISOString(),
        }),
      );
      const rows = this.store.db
        .prepare(
          "SELECT data FROM jobs WHERE status IN ('running','pause_requested')",
        )
        .all() as { data: string }[];
      for (const row of rows) {
        const job = JSON.parse(row.data) as Job;
        if (!job.assignedNodeId) continue;
        if (job.status === "running")
          this.store.pause(job.id, { id: "system", owner: true, profiles: [] });
      }
    });
  }

  resumeDispatch(): void {
    this.store.db.prepare("DELETE FROM metadata WHERE key=?").run(DISPATCH_KEY);
  }

  heartbeat(
    nodeId: string,
    capacity: NodeCapacity,
  ): {
    node: ReturnType<ClusterRegistry["heartbeat"]>;
    controls: ClusterAttemptControl[];
  } {
    const node = this.registry.heartbeat(nodeId, capacity);
    if (capacity.quota.state === "limited")
      this.pauseRunningAttemptsOnNode(nodeId, "quota");
    else if (
      capacity.authentication === "unauthenticated" ||
      !this.nodeMeetsResourceFloors(capacity)
    )
      this.pauseRunningAttemptsOnNode(nodeId, "health");
    return { node, controls: this.controlsForNode(nodeId) };
  }

  private nodeMeetsResourceFloors(capacity: NodeCapacity): boolean {
    const { resources } = capacity;
    const floors = this.scheduling;
    if (resources.memory.freeBytes < floors.minFreeMemoryBytes) return false;
    if (resources.disk.freeBytes < floors.minFreeDiskBytes) return false;
    if (resources.cpu.busyRatio > floors.maxCpuBusyRatio) return false;
    return true;
  }

  /**
   * Request pause for in-flight attempts on a node so they can failover.
   */
  private pauseRunningAttemptsOnNode(
    nodeId: string,
    reason: ClusterHandoff["reason"],
  ): void {
    const pauseReason = `cluster_failover:${reason}`;
    const attemptRows = this.store.db
      .prepare("SELECT data FROM attempts")
      .all() as { data: string }[];
    for (const row of attemptRows) {
      const attempt = JSON.parse(row.data) as Attempt;
      if (attempt.nodeId !== nodeId || attempt.status !== "running") continue;
      let job: Job;
      try {
        job = this.store.get(attempt.jobId);
      } catch {
        continue;
      }
      if (job.status === "running")
        this.store.pause(
          job.id,
          { id: "system", owner: true, profiles: [] },
          pauseReason,
        );
    }
    // Sticky-queued work bound to this home also sheds immediately.
    this.failoverStickyQueuedForNode(nodeId, reason);
  }

  private failoverStickyQueuedForNode(
    nodeId: string,
    reason: ClusterHandoff["reason"],
  ): void {
    const rows = this.store.db
      .prepare(
        "SELECT data FROM jobs WHERE status IN ('queued','paused','interrupted')",
      )
      .all() as { data: string }[];
    for (const row of rows) {
      const job = JSON.parse(row.data) as Job;
      if (job.sessionNodeId !== nodeId) continue;
      this.failoverJob(job.id, { reason, fromNodeId: nodeId });
    }
  }

  private controlsForNode(nodeId: string): ClusterAttemptControl[] {
    const controls: ClusterAttemptControl[] = [];
    const attemptRows = this.store.db
      .prepare("SELECT data FROM attempts")
      .all() as { data: string }[];
    for (const row of attemptRows) {
      const attempt = JSON.parse(row.data) as Attempt;
      if (attempt.nodeId !== nodeId || attempt.status !== "running") continue;
      let job: Job;
      try {
        job = this.store.get(attempt.jobId);
      } catch {
        continue;
      }
      if (job.status === "pause_requested")
        controls.push({
          attemptId: attempt.id,
          action: "pause",
          fence: attempt.fence,
        });
      else if (job.status === "cancel_requested")
        controls.push({
          attemptId: attempt.id,
          action: "cancel",
          fence: attempt.fence,
        });
    }
    return controls;
  }

  private routerNodes(): RouterNode[] {
    return this.registry.list(false).map((n) => {
      const last = this.store.db
        .prepare("SELECT value FROM metadata WHERE key=?")
        .get(LAST_ASSIGNED_PREFIX + n.id) as { value: string } | undefined;
      return {
        id: n.id,
        status: n.status,
        capacity: n.capacity ?? {
          worker: n.worker,
          concurrency: n.concurrency,
          active: 0,
          freeSlots: 0,
          authentication: "unknown" as const,
          quota: {
            state: "unknown" as const,
            resetAt: null,
            windowStartedAt: new Date(0).toISOString(),
            estimatedUsedUnits: 0,
            estimatedCapacityUnits: 0,
          },
          resources: exhaustedNodeResources(this.config.workspace),
          reservePercent: n.reservePercent,
          draining: n.status === "draining",
        },
        lastAssignedAt: last ? Number(last.value) || 0 : 0,
      };
    });
  }

  private markAssigned(nodeId: string): void {
    this.store.db
      .prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)")
      .run(LAST_ASSIGNED_PREFIX + nodeId, String(Date.now()));
  }

  /**
   * Sticky home exists but cannot take work — clear sticky and hand off.
   */
  private failoverStickyHome(job: Job, nodes: RouterNode[]): void {
    const homeId = job.sessionNodeId;
    if (!homeId) return;
    const home = nodes.find((n) => n.id === homeId);
    let reason: ClusterHandoff["reason"] = "health";
    if (!home) reason = "offline";
    else if (home.capacity.quota.state === "limited") reason = "quota";
    else if (home.capacity.draining || home.status === "draining")
      reason = "drain";
    this.failoverJob(job.id, { reason, fromNodeId: homeId });
  }

  /**
   * Fail a queued job without creating an attempt (misconfiguration path).
   */
  private failQueuedJob(jobId: string, error: string): void {
    this.store.atomic(() => {
      const job = this.store.get(jobId);
      if (job.status !== "queued") return;
      job.status = "failed";
      job.error = error;
      job.activity = "failed";
      job.updatedAt = new Date().toISOString();
      this.store.db
        .prepare("UPDATE jobs SET status=?,data=? WHERE id=?")
        .run(job.status, JSON.stringify(job), job.id);
      this.store.addEvent(job, "job.failed", { error });
    });
  }

  claim(
    nodeId: string,
    input: { freeSlots: number; worker?: "claude" | "codex" },
  ): { claims: ClusterClaimEntry[] } {
    if (this.dispatchPaused) return { claims: [] };
    const node = this.registry.get(nodeId);
    if (node.status !== "online" && node.status !== "draining")
      return { claims: [] };
    if (node.status === "draining") return { claims: [] };
    const freeSlots = Math.max(0, Math.min(input.freeSlots, 32));
    if (freeSlots <= 0) return { claims: [] };

    const claims: ClusterClaimEntry[] = [];
    const now = Date.now();
    const nodes = this.routerNodes();
    const pending = this.store.pending("cli");
    for (const job of pending) {
      if (claims.length >= freeSlots) break;

      // Validate profile before claim so a missing profile cannot orphan a running attempt.
      const profile = this.config.profiles[job.profile];
      if (!profile) {
        this.failQueuedJob(
          job.id,
          "profile_unknown: Claimed job references an unknown profile",
        );
        continue;
      }

      // Provider-agnostic: fair-share among all eligible CLI types.
      // Sticky home (when set) still prefers that node for --resume.
      const selected = selectNode(
        nodes,
        { sessionNodeId: job.sessionNodeId },
        now,
        this.scheduling,
      );
      if (job.sessionNodeId && selected === null) {
        // Home offline or ineligible: failover instead of sticky-wait-forever.
        this.failoverStickyHome(job, nodes);
        continue;
      }
      if (selected !== nodeId) continue;
      const assignedWorker = node.worker;
      // Claiming worker only runs its own CLI; skip if somehow mismatched.
      if (input.worker && input.worker !== assignedWorker) continue;
      const owner = `${nodeId}:${randomUUID()}`;
      const attempt = this.store.claim(owner, "cli", job.id, {
        nodeId,
        worker: assignedWorker,
      });
      if (!attempt) continue;
      this.markAssigned(nodeId);
      if (loadImageExecution(this.store, job.id))
        freezeImageExecution(
          this.store,
          job.id,
          this.config,
          job.profile,
          assignedWorker,
        );
      const live = this.store.get(job.id);
      const handoff = live.clusterHandoff;
      const jobForWorker = structuredClone(live);
      if (handoff) {
        this.store.consumeClusterHandoff(live.id);
        if (handoff.fromNodeId !== nodeId) {
          this.store.addEvent(live, "job.cluster_reassigned", {
            fromNodeId: handoff.fromNodeId,
            toNodeId: nodeId,
            reason: handoff.reason,
            failoverCount: live.failoverCount,
          });
        }
      }
      claims.push({
        attempt,
        job: jobForWorker,
        profile: structuredClone(profile),
        imageExecution: loadImageExecution(this.store, live.id),
      });
    }
    return { claims };
  }

  private loadAttempt(attemptId: string): Attempt {
    const row = this.store.db
      .prepare("SELECT data FROM attempts WHERE id=?")
      .get(attemptId) as { data: string } | undefined;
    if (!row) throw new BridgeError("not_found", "Attempt not found", 404);
    return JSON.parse(row.data) as Attempt;
  }

  private assertAttemptOwner(
    attempt: Attempt,
    auth: WorkerAuthContext,
    owner: string,
    fence: string,
  ): void {
    if (attempt.nodeId && attempt.nodeId !== auth.nodeId)
      throw new BridgeError(
        "forbidden",
        "Attempt is not owned by this node",
        403,
      );
    if (attempt.owner !== owner || attempt.fence !== fence)
      throw new BridgeError(
        "stale_attempt",
        "Attempt no longer belongs to this worker",
        409,
      );
  }

  events(
    attemptId: string,
    auth: WorkerAuthContext,
    input: { owner: string; fence: string; events: WorkerEvent[] },
  ): { ok: true } {
    const attempt = this.loadAttempt(attemptId);
    this.assertAttemptOwner(attempt, auth, input.owner, input.fence);
    for (const event of input.events)
      this.store.observe(
        { ...attempt, owner: input.owner, fence: input.fence },
        event,
      );
    return { ok: true };
  }

  finish(
    attemptId: string,
    auth: WorkerAuthContext,
    input: { owner: string; fence: string; outcome: Outcome },
  ): { ok: true } {
    const attempt = this.loadAttempt(attemptId);
    this.assertAttemptOwner(attempt, auth, input.owner, input.fence);
    this.store.finish(
      { ...attempt, owner: input.owner, fence: input.fence },
      input.outcome,
    );
    this.maybeFailoverAfterFinish(attempt, input.outcome);
    return { ok: true };
  }

  private maybeFailoverAfterFinish(attempt: Attempt, outcome: Outcome): void {
    if (outcome.status !== "paused" && outcome.status !== "interrupted") return;
    let job: Job;
    try {
      job = this.store.get(attempt.jobId);
    } catch {
      return;
    }
    const reason =
      this.failoverReasonFromError(job.error) ??
      this.failoverReasonFromError(outcome.error);
    if (!reason) return;
    const fromNodeId =
      attempt.nodeId ?? job.assignedNodeId ?? job.sessionNodeId ?? "unknown";
    this.failoverJob(job.id, { reason, fromNodeId });
  }

  drain(nodeId: string) {
    const node = this.registry.drain(nodeId);
    this.pauseRunningAttemptsOnNode(nodeId, "drain");
    return node;
  }

  leave(nodeId: string) {
    this.interruptAndFailoverNode(nodeId, "offline");
    return this.registry.remove(nodeId);
  }

  createJoinToken(input: { createdBy: string; ttlMs?: number }) {
    return this.auth.createJoinToken(input);
  }

  revokeJoinToken(id: string) {
    return this.auth.revokeJoinToken(id);
  }

  getNode(nodeId: string) {
    return this.registry.get(nodeId);
  }

  /**
   * When a node flips to offline/leave, interrupt running attempts and failover
   * so peers can claim (sticky cleared; handoff brief attached).
   */
  private interruptAndFailoverNode(
    nodeId: string,
    reason: ClusterHandoff["reason"],
  ): void {
    const rows = this.store.db.prepare("SELECT data FROM attempts").all() as {
      data: string;
    }[];
    for (const row of rows) {
      const attempt = JSON.parse(row.data) as Attempt;
      if (attempt.nodeId !== nodeId || attempt.status !== "running") continue;
      this.store.finish(attempt, {
        status: "interrupted",
        error: `cluster_failover:${reason}`,
      });
      this.failoverJob(attempt.jobId, { reason, fromNodeId: nodeId });
    }
    this.failoverStickyQueuedForNode(nodeId, reason);
  }

  /** Periodic registry housekeeping (stale/offline → interrupt + failover). */
  tick(): void {
    const { offline } = this.registry.markStale();
    for (const nodeId of offline)
      this.interruptAndFailoverNode(nodeId, "offline");
  }

  status(includeNodes: boolean): ClusterStatus {
    this.registry.markStale();
    const nodes = this.registry.list(false);
    const online = nodes.filter((n) => n.status === "online");
    const router = this.routerNodes();
    const now = Date.now();
    const eligible = router.filter(
      (n) => selectNode([n], {}, now, this.scheduling) === n.id,
    );
    const eligibleCount = eligible.length;
    const eligibleByProvider = {
      claude: eligible.filter((n) => n.capacity.worker === "claude").length,
      codex: eligible.filter((n) => n.capacity.worker === "codex").length,
    };

    const summaries = online.map((n) => {
      const cap = n.capacity;
      const reserved = n.reservePercent;
      const usable = cap
        ? usableCapacity(cap.quota.estimatedCapacityUnits, reserved)
        : 0;
      const room = cap ? headroom(cap) : 0;
      const usedPct =
        usable > 0 && cap ? (cap.quota.estimatedUsedUnits / usable) * 100 : 0;
      return {
        id: n.id,
        name: n.name,
        worker: n.worker,
        status: n.status,
        freeSlots: cap?.freeSlots ?? 0,
        headroom: room,
        usablePercent: 100 - reserved,
        usedPercentOfUsable: usedPct,
        reservedPercent: reserved,
        quotaState: cap?.quota.state ?? ("unknown" as const),
        resetAt: cap?.quota.resetAt ?? null,
        authentication: cap?.authentication ?? ("unknown" as const),
        memoryFreeBytes: cap?.resources.memory.freeBytes ?? null,
        diskFreeBytes: cap?.resources.disk.freeBytes ?? null,
        cpuBusyRatio: cap?.resources.cpu.busyRatio ?? null,
        model: cap?.model ?? null,
      };
    });

    const usedPercents = summaries
      .filter((s) => s.quotaState !== "limited")
      .map((s) => s.usedPercentOfUsable);
    const fairnessSkew =
      usedPercents.length >= 2
        ? Math.max(...usedPercents) - Math.min(...usedPercents)
        : 0;

    const queuedJobs = (
      this.store.db
        .prepare("SELECT count(*) AS n FROM jobs WHERE status='queued'")
        .get() as { n: number }
    ).n;
    const runningJobs = (
      this.store.db
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE status IN ('running','pause_requested','cancel_requested')",
        )
        .get() as { n: number }
    ).n;
    const waitingForFailover = (
      this.store.db
        .prepare("SELECT data FROM jobs WHERE status='queued'")
        .all() as { data: string }[]
    ).filter((row) => {
      const job = JSON.parse(row.data) as Job;
      return Boolean(job.clusterHandoff) || job.activity === "cluster_failover";
    }).length;
    const failoverRow = this.store.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(FAILOVER_COUNTER_KEY) as { value: string } | undefined;
    const failovers = failoverRow ? Number(failoverRow.value) || 0 : 0;

    let dispatch: ClusterStatus["dispatch"] = "ready";
    if (this.dispatchPaused) dispatch = "paused";
    else if (eligibleCount === 0 && queuedJobs > 0)
      dispatch = "waiting_for_capacity";

    const withMem = summaries.filter((s) => s.memoryFreeBytes != null);
    const withDisk = summaries.filter((s) => s.diskFreeBytes != null);
    const withCpu = summaries.filter((s) => s.cpuBusyRatio != null);
    const avg = (values: number[]) =>
      values.length === 0
        ? null
        : values.reduce((a, b) => a + b, 0) / values.length;

    return {
      mode: "coordinator",
      reservePercent: this.config.cluster?.reservePercent ?? 10,
      dispatch,
      nodes: includeNodes ? summaries : [],
      pool: {
        onlineNodes: online.length,
        eligibleNodes: eligibleCount,
        eligibleByProvider,
        totalHeadroom: summaries.reduce((n, s) => n + s.headroom, 0),
        fairnessSkew,
        queuedJobs,
        runningJobs,
        failovers,
        waitingForFailover,
        avgMemoryFreeBytes: avg(
          withMem.map((s) => s.memoryFreeBytes as number),
        ),
        avgDiskFreeBytes: avg(withDisk.map((s) => s.diskFreeBytes as number)),
        avgCpuBusyRatio: avg(withCpu.map((s) => s.cpuBusyRatio as number)),
      },
    };
  }
}

export const clusterJoinBodySchema = z.strictObject({
  token: z.string().min(1),
  name: z.string().min(1).max(128),
  worker: z.enum(["claude", "codex"]),
  concurrency: z.number().int().min(1).max(64),
  reservePercent: z.number().int().min(0).max(90).nullable().optional(),
  publicKey: z.string().min(32).max(4096),
});

export const clusterClaimBodySchema = z.strictObject({
  freeSlots: z.number().int().min(0).max(32),
  worker: z.enum(["claude", "codex"]).optional(),
});

export const clusterEventsBodySchema = z.strictObject({
  owner: z.string().min(1),
  fence: z.string().min(1),
  events: z
    .array(
      z.strictObject({
        kind: z.enum([
          "tool",
          "output",
          "progress",
          "session",
          "compaction",
          "activity",
          "rate_limit",
          "subagent",
        ]),
        text: z.string().default(""),
        data: z.record(z.string(), z.unknown()).optional(),
        tool: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const clusterFinishBodySchema = z.strictObject({
  owner: z.string().min(1),
  fence: z.string().min(1),
  outcome: z.strictObject({
    status: z.enum([
      "succeeded",
      "failed",
      "canceled",
      "interrupted",
      "timed_out",
      "paused",
    ]),
    result: z.string().optional(),
    error: z.string().optional(),
    sessionId: z.string().optional(),
    retryAt: z.number().optional(),
    usage: z.unknown().optional(),
  }),
});

export { nodeCapacitySchema };
