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

import type { ClusterNodeStatus, NodeCapacity } from "./cluster-types.js";
import { headroom, usableCapacity } from "./cluster-quota.js";

export type RouterNode = {
  id: string;
  status: ClusterNodeStatus;
  capacity: NodeCapacity;
  /** Epoch ms of last successful claim assignment; older preferred on ties. */
  lastAssignedAt?: number | null;
};

export type RouterJob = {
  sessionNodeId?: string | null;
  worker?: "claude" | "codex";
};

function quotaIsLimited(capacity: NodeCapacity, now: number): boolean {
  const { state, resetAt } = capacity.quota;
  if (state !== "limited") return false;
  if (resetAt != null && now >= resetAt) return false;
  return true;
}

export function isEligible(
  node: RouterNode,
  job: RouterJob = {},
  now: number = Date.now(),
): boolean {
  if (node.status !== "online") return false;
  const { capacity } = node;
  if (capacity.draining) return false;
  if (capacity.authentication !== "authenticated") return false;
  if (quotaIsLimited(capacity, now)) return false;
  if (capacity.freeSlots <= 0) return false;
  if (job.worker != null && capacity.worker !== job.worker) return false;

  const usable = usableCapacity(
    capacity.quota.estimatedCapacityUnits,
    capacity.reservePercent,
  );
  if (usable <= 0) return false;

  const room = headroom(capacity);
  if (room > 0) return true;

  // Startup grace: unknown quota may still accept work until used hits soft cap.
  if (capacity.quota.state === "unknown") {
    return capacity.quota.estimatedUsedUnits < usable;
  }
  return false;
}

function score(node: RouterNode): number {
  const usable = usableCapacity(
    node.capacity.quota.estimatedCapacityUnits,
    node.capacity.reservePercent,
  );
  if (usable <= 0) return 0;
  return headroom(node.capacity) / usable;
}

/**
 * Fair-share pick: maximize normalized headroom among eligible nodes.
 * Sticky jobs only consider `sessionNodeId`; if that node is ineligible, return null.
 * Tie-break: lower active, then older lastAssignedAt, then lower nodeId.
 */
export function selectNode(
  nodes: RouterNode[],
  job: RouterJob,
  now: number = Date.now(),
): string | null {
  const candidates =
    job.sessionNodeId != null && job.sessionNodeId !== ""
      ? nodes.filter((n) => n.id === job.sessionNodeId)
      : nodes;

  const eligible = candidates.filter((n) => isEligible(n, job, now));
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const scoreDiff = score(b) - score(a);
    if (scoreDiff !== 0) return scoreDiff;
    const activeDiff = a.capacity.active - b.capacity.active;
    if (activeDiff !== 0) return activeDiff;
    const aAssigned = a.lastAssignedAt ?? 0;
    const bAssigned = b.lastAssignedAt ?? 0;
    if (aAssigned !== bAssigned) return aAssigned - bAssigned;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return eligible[0]!.id;
}
