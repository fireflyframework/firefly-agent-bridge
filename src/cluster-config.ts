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

export const clusterConfigSchema = z.strictObject({
  mode: z.enum(["off", "coordinator", "worker"]).default("off"),
  bindHost: z.string().min(1).max(253).default("0.0.0.0"),
  reservePercent: z.number().int().min(0).max(90).default(10),
  heartbeatIntervalMs: z.number().int().min(500).max(60_000).default(2000),
  heartbeatStaleMs: z.number().int().min(1000).max(300_000).default(10_000),
  heartbeatOfflineMs: z.number().int().min(1000).max(600_000).default(60_000),
  joinTokenHash: z.string().min(1).nullable().default(null),
  requireTls: z.boolean().default(false),
  allowedWorkerCidrs: z.array(z.string().min(1).max(64)).default([]),
});
export type ClusterConfig = z.infer<typeof clusterConfigSchema>;

export const clusterWorkerFileSchema = z.strictObject({
  coordinatorUrl: z.string().url(),
  nodeId: z.string().min(1).max(128),
  credential: z.string().min(1).max(512),
  reservePercent: z.number().int().min(0).max(90).nullable().default(null),
});
export type ClusterWorkerFile = z.infer<typeof clusterWorkerFileSchema>;

export function parseClusterWorkerFile(value: unknown): ClusterWorkerFile {
  return clusterWorkerFileSchema.parse(value);
}
