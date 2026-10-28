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

import { randomBytes } from "node:crypto";
import type { ClusterAuth } from "./cluster-auth.js";
import { enrollmentFingerprint } from "./cluster-crypto.js";
import {
  nodeCapacitySchema,
  type ClusterNodeStatus,
  type NodeCapacity,
} from "./cluster-types.js";
import { BridgeError } from "./contracts.js";
import { QueueStore } from "./store.js";

export type ClusterRegistryOptions = {
  worker: "claude" | "codex";
  reservePercent: number;
  heartbeatStaleMs: number;
  heartbeatOfflineMs: number;
};

export type ClusterNodeRecord = {
  id: string;
  name: string;
  worker: "claude" | "codex";
  status: ClusterNodeStatus;
  concurrency: number;
  reservePercent: number;
  publicKey: string | null;
  enrollmentFingerprint: string | null;
  lastHeartbeatAt: string | null;
  lastSignedAt: string | null;
  capacity: NodeCapacity | null;
  createdAt: string;
  updatedAt: string;
};

type NodeRow = {
  id: string;
  name: string;
  worker: string;
  status: string;
  concurrency: number;
  reserve_percent: number;
  credential_hash: string;
  public_key: string | null;
  enrollment_fingerprint: string | null;
  last_heartbeat_at: string | null;
  last_signed_at: string | null;
  capacity_json: string | null;
  created_at: string;
  updated_at: string;
};

const stamp = (at?: Date) => (at ?? new Date()).toISOString();

export class ClusterRegistry {
  constructor(
    private store: QueueStore,
    private auth: ClusterAuth,
    private options: ClusterRegistryOptions,
  ) {
    if (options.heartbeatOfflineMs < options.heartbeatStaleMs)
      throw new Error(
        "heartbeatOfflineMs must be greater than or equal to heartbeatStaleMs",
      );
  }

  private mapRow(row: NodeRow): ClusterNodeRecord {
    return {
      id: row.id,
      name: row.name,
      worker: row.worker as "claude" | "codex",
      status: row.status as ClusterNodeStatus,
      concurrency: row.concurrency,
      reservePercent: row.reserve_percent,
      publicKey: row.public_key ?? null,
      enrollmentFingerprint: row.enrollment_fingerprint ?? null,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastSignedAt: row.last_signed_at ?? null,
      capacity: row.capacity_json
        ? (JSON.parse(row.capacity_json) as NodeCapacity)
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getRow(nodeId: string): NodeRow {
    const row = this.store.db
      .prepare("SELECT * FROM cluster_nodes WHERE id=?")
      .get(nodeId) as NodeRow | undefined;
    if (!row) throw new BridgeError("not_found", "Cluster node not found", 404);
    return row;
  }

  private effectiveReserve(requested?: number | null): number {
    const floor = this.options.reservePercent;
    if (requested == null) return floor;
    if (requested < floor)
      throw new BridgeError(
        "invalid_request",
        `Node reservePercent cannot be lower than coordinator floor (${floor})`,
      );
    return requested;
  }

  join(input: {
    token: string;
    name: string;
    worker: "claude" | "codex";
    concurrency: number;
    reservePercent?: number | null;
    publicKey: string;
  }): { nodeId: string; credential: string } {
    this.auth.verifyJoinToken(input.token);
    if (input.worker !== this.options.worker)
      throw new BridgeError(
        "worker_mismatch",
        `Coordinator accepts only ${this.options.worker} workers`,
        400,
      );
    const name = input.name.trim();
    if (!name)
      throw new BridgeError("invalid_request", "Node name is required");
    const publicKey = input.publicKey.trim();
    if (!publicKey.includes("PUBLIC KEY"))
      throw new BridgeError(
        "invalid_request",
        "Ed25519 publicKey PEM is required",
      );
    if (
      !Number.isInteger(input.concurrency) ||
      input.concurrency < 1 ||
      input.concurrency > 64
    )
      throw new BridgeError(
        "invalid_request",
        "concurrency must be an integer from 1 to 64",
      );
    const reservePercent = this.effectiveReserve(input.reservePercent);
    const { credential, hash } = this.auth.issueNodeCredential();
    const nodeId = "node_" + randomBytes(12).toString("base64url");
    const fingerprint = enrollmentFingerprint(publicKey, name);
    const now = stamp();
    this.store.db
      .prepare(
        `INSERT INTO cluster_nodes(
          id,name,worker,status,concurrency,reserve_percent,credential_hash,
          public_key,enrollment_fingerprint,
          last_heartbeat_at,last_signed_at,capacity_json,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        nodeId,
        name,
        input.worker,
        "joining",
        input.concurrency,
        reservePercent,
        hash,
        publicKey,
        fingerprint,
        null,
        null,
        null,
        now,
        now,
      );
    return { nodeId, credential };
  }

  markSigned(nodeId: string, at?: Date): void {
    const now = stamp(at);
    this.store.db
      .prepare(
        "UPDATE cluster_nodes SET last_signed_at=?, updated_at=? WHERE id=?",
      )
      .run(now, now, nodeId);
  }

  heartbeat(
    nodeId: string,
    capacity: NodeCapacity,
    at?: Date,
  ): ClusterNodeRecord {
    const parsed = nodeCapacitySchema.parse(capacity);
    const row = this.getRow(nodeId);
    if (row.status === "removed")
      throw new BridgeError(
        "invalid_request",
        "Removed nodes cannot heartbeat",
        409,
      );
    if (parsed.worker !== row.worker)
      throw new BridgeError(
        "worker_mismatch",
        "Heartbeat worker does not match registered node",
        400,
      );
    const now = stamp(at);
    let nextStatus: ClusterNodeStatus;
    if (parsed.draining || row.status === "draining") nextStatus = "draining";
    else nextStatus = "online";
    this.store.db
      .prepare(
        `UPDATE cluster_nodes
         SET status=?, last_heartbeat_at=?, capacity_json=?, updated_at=?
         WHERE id=?`,
      )
      .run(nextStatus, now, JSON.stringify(parsed), now, nodeId);
    return this.mapRow(this.getRow(nodeId));
  }

  markStale(at?: Date): { stale: string[]; offline: string[] } {
    const now = at ?? new Date();
    const nowMs = now.getTime();
    const staleIds: string[] = [];
    const offlineIds: string[] = [];
    const rows = this.store.db
      .prepare(
        `SELECT * FROM cluster_nodes
         WHERE status IN ('joining','online','draining','stale')
           AND last_heartbeat_at IS NOT NULL`,
      )
      .all() as NodeRow[];
    for (const row of rows) {
      const last = Date.parse(row.last_heartbeat_at!);
      if (!Number.isFinite(last)) continue;
      const age = nowMs - last;
      let next: ClusterNodeStatus | null = null;
      if (age >= this.options.heartbeatOfflineMs) next = "offline";
      else if (
        age >= this.options.heartbeatStaleMs &&
        (row.status === "online" || row.status === "joining")
      )
        next = "stale";
      if (!next || next === row.status) continue;
      const updatedAt = stamp(now);
      this.store.db
        .prepare("UPDATE cluster_nodes SET status=?, updated_at=? WHERE id=?")
        .run(next, updatedAt, row.id);
      if (next === "stale") staleIds.push(row.id);
      if (next === "offline") offlineIds.push(row.id);
    }
    return { stale: staleIds, offline: offlineIds };
  }

  drain(nodeId: string): ClusterNodeRecord {
    const row = this.getRow(nodeId);
    if (row.status === "removed")
      throw new BridgeError(
        "invalid_request",
        "Removed nodes cannot drain",
        409,
      );
    const now = stamp();
    this.store.db
      .prepare("UPDATE cluster_nodes SET status=?, updated_at=? WHERE id=?")
      .run("draining", now, nodeId);
    return this.mapRow(this.getRow(nodeId));
  }

  remove(nodeId: string): ClusterNodeRecord {
    this.getRow(nodeId);
    const now = stamp();
    // Revoke credential and enrolled key so stolen material cannot re-auth.
    this.store.db
      .prepare(
        `UPDATE cluster_nodes
         SET status=?, credential_hash=?, public_key=NULL,
             enrollment_fingerprint=NULL, updated_at=?
         WHERE id=?`,
      )
      .run(
        "removed",
        "revoked:" + randomBytes(16).toString("hex"),
        now,
        nodeId,
      );
    return this.mapRow(this.getRow(nodeId));
  }

  list(includeRemoved = true): ClusterNodeRecord[] {
    const rows = (
      includeRemoved
        ? (this.store.db
            .prepare("SELECT * FROM cluster_nodes ORDER BY created_at,id")
            .all() as NodeRow[])
        : (this.store.db
            .prepare(
              "SELECT * FROM cluster_nodes WHERE status!='removed' ORDER BY created_at,id",
            )
            .all() as NodeRow[])
    ).map((row) => this.mapRow(row));
    return rows;
  }

  get(nodeId: string): ClusterNodeRecord {
    return this.mapRow(this.getRow(nodeId));
  }

  findByCredential(credential: string): ClusterNodeRecord | null {
    const hash = this.auth.hashCredential(credential);
    const row = this.store.db
      .prepare(
        "SELECT * FROM cluster_nodes WHERE credential_hash=? AND status!='removed'",
      )
      .get(hash) as NodeRow | undefined;
    return row ? this.mapRow(row) : null;
  }
}
