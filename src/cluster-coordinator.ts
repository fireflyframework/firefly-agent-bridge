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
import {
  headroom,
  usableCapacity,
} from "./cluster-quota.js";
import { ClusterRegistry } from "./cluster-registry.js";
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
  type Job,
  type Outcome,
} from "./contracts.js";
import { loadImageExecution } from "./image-execution.js";
import { QueueStore } from "./store.js";
import type { WorkerEvent } from "./worker.js";

const DISPATCH_KEY = "cluster_dispatch";
const LAST_ASSIGNED_PREFIX = "cluster_last_assigned:";

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
 * Worker identity today: Bearer `ffn_` via ClusterAuth/registry.
 * Task 8 will add Ed25519 request signatures + TLS without changing claim semantics —
 * keep authentication at the HTTP boundary (`authenticateWorker`) so crypto can wrap it.
 */
export class ClusterCoordinator {
  constructor(
    private store: QueueStore,
    private registry: ClusterRegistry,
    private auth: ClusterAuth,
    private config: BridgeConfig,
  ) {}

  /** Resolve ffn_ credential → node. Hook point for Task 8 signature checks. */
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
      this.store.db
        .prepare("INSERT OR REPLACE INTO metadata VALUES(?,?)")
        .run(
          DISPATCH_KEY,
          JSON.stringify({ paused: true, reason, at: new Date().toISOString() }),
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
    this.store.db
      .prepare("DELETE FROM metadata WHERE key=?")
      .run(DISPATCH_KEY);
  }

  heartbeat(
    nodeId: string,
    capacity: NodeCapacity,
  ): { node: ReturnType<ClusterRegistry["heartbeat"]>; controls: ClusterAttemptControl[] } {
    const node = this.registry.heartbeat(nodeId, capacity);
    return { node, controls: this.controlsForNode(nodeId) };
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
    const pending = this.store.pending("cli");
    for (const job of pending) {
      if (claims.length >= freeSlots) break;
      const selected = selectNode(this.routerNodes(), {
        sessionNodeId: job.sessionNodeId,
        worker: input.worker ?? this.config.worker,
      });
      if (selected !== nodeId) continue;
      const owner = `${nodeId}:${randomUUID()}`;
      const attempt = this.store.claim(owner, "cli", job.id, { nodeId });
      if (!attempt) continue;
      this.markAssigned(nodeId);
      const live = this.store.get(job.id);
      const profile = this.config.profiles[live.profile];
      if (!profile)
        throw new BridgeError(
          "profile_unknown",
          "Claimed job references an unknown profile",
          500,
        );
      claims.push({
        attempt,
        job: live,
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
    if (!row)
      throw new BridgeError("not_found", "Attempt not found", 404);
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
    return { ok: true };
  }

  drain(nodeId: string) {
    return this.registry.drain(nodeId);
  }

  leave(nodeId: string) {
    return this.registry.remove(nodeId);
  }

  /** Periodic registry housekeeping (stale/offline transitions). */
  tick(): void {
    this.registry.markStale();
  }

  status(includeNodes: boolean): ClusterStatus {
    this.registry.markStale();
    const nodes = this.registry.list(false);
    const online = nodes.filter((n) => n.status === "online");
    const router = this.routerNodes();
    const eligibleCount = router.filter(
      (n) => selectNode([n], { worker: this.config.worker }) === n.id,
    ).length;

    const summaries = online.map((n) => {
      const cap = n.capacity;
      const reserved = n.reservePercent;
      const usable = cap
        ? usableCapacity(cap.quota.estimatedCapacityUnits, reserved)
        : 0;
      const room = cap ? headroom(cap) : 0;
      const usedPct =
        usable > 0 && cap
          ? (cap.quota.estimatedUsedUnits / usable) * 100
          : 0;
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

    let dispatch: ClusterStatus["dispatch"] = "ready";
    if (this.dispatchPaused) dispatch = "paused";
    else if (eligibleCount === 0 && queuedJobs > 0)
      dispatch = "waiting_for_capacity";

    return {
      mode: "coordinator",
      reservePercent: this.config.cluster?.reservePercent ?? 10,
      dispatch,
      nodes: includeNodes ? summaries : [],
      pool: {
        onlineNodes: online.length,
        eligibleNodes: eligibleCount,
        totalHeadroom: summaries.reduce((n, s) => n + s.headroom, 0),
        fairnessSkew,
        queuedJobs,
        runningJobs,
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
