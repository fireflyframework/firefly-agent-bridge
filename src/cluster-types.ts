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

import { z } from "zod";

export const nodeCapacitySchema = z.strictObject({
  worker: z.enum(["claude", "codex"]),
  concurrency: z.number().int().min(0),
  active: z.number().int().min(0),
  freeSlots: z.number().int().min(0),
  authentication: z.enum(["authenticated", "unauthenticated", "unknown"]),
  quota: z.strictObject({
    state: z.enum(["ok", "limited", "unknown"]),
    resetAt: z.number().nullable(),
    windowStartedAt: z.string().min(1),
    estimatedUsedUnits: z.number().min(0),
    estimatedCapacityUnits: z.number().min(0),
  }),
  reservePercent: z.number().int().min(0).max(90),
  draining: z.boolean(),
});
export type NodeCapacity = z.infer<typeof nodeCapacitySchema>;

export const clusterNodeStatusSchema = z.enum([
  "joining",
  "online",
  "draining",
  "stale",
  "offline",
  "removed",
]);
export type ClusterNodeStatus = z.infer<typeof clusterNodeStatusSchema>;

export const clusterNodeSummarySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  worker: z.enum(["claude", "codex"]),
  status: clusterNodeStatusSchema,
  freeSlots: z.number().int().min(0),
  headroom: z.number().min(0),
  usablePercent: z.number().min(0).max(100),
  usedPercentOfUsable: z.number().min(0),
  reservedPercent: z.number().int().min(0).max(90),
  quotaState: z.enum(["ok", "limited", "unknown"]),
  resetAt: z.number().nullable(),
});
export type ClusterNodeSummary = z.infer<typeof clusterNodeSummarySchema>;

export const clusterPoolSummarySchema = z.strictObject({
  onlineNodes: z.number().int().min(0),
  eligibleNodes: z.number().int().min(0),
  totalHeadroom: z.number().min(0),
  fairnessSkew: z.number().min(0),
  queuedJobs: z.number().int().min(0),
  runningJobs: z.number().int().min(0),
});
export type ClusterPoolSummary = z.infer<typeof clusterPoolSummarySchema>;

export const clusterStatusSchema = z.strictObject({
  mode: z.enum(["off", "coordinator", "worker"]),
  reservePercent: z.number().int().min(0).max(90),
  dispatch: z
    .enum(["ready", "paused", "waiting_for_capacity"])
    .optional(),
  nodes: z.array(clusterNodeSummarySchema).default([]),
  pool: clusterPoolSummarySchema.optional(),
});
export type ClusterStatus = z.infer<typeof clusterStatusSchema>;

export const clusterControlActionSchema = z.enum(["pause", "cancel"]);
export type ClusterControlAction = z.infer<typeof clusterControlActionSchema>;

export const clusterAttemptControlSchema = z.strictObject({
  attemptId: z.string().min(1),
  action: clusterControlActionSchema,
  fence: z.string().min(1),
});
export type ClusterAttemptControl = z.infer<typeof clusterAttemptControlSchema>;
