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

const WEIGHT_SUM_EPSILON = 1e-6;

export const schedulingWeightsSchema = z.strictObject({
  quota: z.number().min(0).max(1),
  memory: z.number().min(0).max(1),
  disk: z.number().min(0).max(1),
  cpu: z.number().min(0).max(1),
});

export const clusterSchedulingSchema = z
  .strictObject({
    minFreeMemoryBytes: z
      .number()
      .int()
      .min(0)
      .default(512 * 1024 * 1024),
    minFreeDiskBytes: z
      .number()
      .int()
      .min(0)
      .default(1024 * 1024 * 1024),
    maxCpuBusyRatio: z.number().min(0).max(1).default(0.92),
    weights: schedulingWeightsSchema.default({
      quota: 0.45,
      memory: 0.2,
      disk: 0.15,
      cpu: 0.2,
    }),
  })
  .superRefine((value, ctx) => {
    const sum =
      value.weights.quota +
      value.weights.memory +
      value.weights.disk +
      value.weights.cpu;
    if (Math.abs(sum - 1) > WEIGHT_SUM_EPSILON) {
      ctx.addIssue({
        code: "custom",
        message: `scheduling.weights must sum to 1 (got ${sum})`,
        path: ["weights"],
      });
    }
  });
export type ClusterScheduling = z.infer<typeof clusterSchedulingSchema>;

export const DEFAULT_SCHEDULING: ClusterScheduling =
  clusterSchedulingSchema.parse({});

export const clusterDaemonSchema = z.strictObject({
  pidFile: z.string().min(1).max(1024).optional(),
  logFile: z.string().min(1).max(1024).optional(),
});
export type ClusterDaemonConfig = z.infer<typeof clusterDaemonSchema>;

export const clusterConfigSchema = z
  .strictObject({
    mode: z.enum(["off", "coordinator", "worker"]).default("off"),
    exposure: z.enum(["internet", "private"]).default("private"),
    bindHost: z.string().min(1).max(253).default("0.0.0.0"),
    reservePercent: z.number().int().min(0).max(90).default(10),
    heartbeatIntervalMs: z.number().int().min(500).max(60_000).default(2000),
    heartbeatStaleMs: z.number().int().min(1000).max(300_000).default(10_000),
    heartbeatOfflineMs: z.number().int().min(1000).max(600_000).default(60_000),
    joinTokenHash: z.string().min(1).nullable().default(null),
    requireTls: z.boolean().default(false),
    tlsCertPath: z.string().min(1).max(1024).nullable().default(null),
    tlsKeyPath: z.string().min(1).max(1024).nullable().default(null),
    allowedWorkerCidrs: z.array(z.string().min(1).max(64)).default([]),
    joinRateLimitPerMinute: z.number().int().min(1).max(1000).default(10),
    requestSkewMs: z.number().int().min(1000).max(600_000).default(60_000),
    /** Max sticky clear + requeue cycles before the job fails as exhausted. */
    maxFailovers: z.number().int().min(0).max(32).default(3),
    daemon: clusterDaemonSchema.optional(),
    scheduling: clusterSchedulingSchema.default(DEFAULT_SCHEDULING),
  })
  .superRefine((value, ctx) => {
    if (value.exposure === "internet" && !value.requireTls) {
      ctx.addIssue({
        code: "custom",
        message: "exposure=internet requires requireTls=true",
        path: ["requireTls"],
      });
    }
  });
export type ClusterConfig = z.infer<typeof clusterConfigSchema>;

export const clusterWorkerFileSchema = z.strictObject({
  coordinatorUrl: z.string().url(),
  nodeId: z.string().min(1).max(128),
  credential: z.string().min(1).max(512),
  nodePrivateKey: z.string().min(1).optional(),
  reservePercent: z.number().int().min(0).max(90).nullable().default(null),
  allowInsecure: z.boolean().default(false),
  daemon: clusterDaemonSchema.optional(),
});
export type ClusterWorkerFile = z.infer<typeof clusterWorkerFileSchema>;

export function parseClusterWorkerFile(value: unknown): ClusterWorkerFile {
  return clusterWorkerFileSchema.parse(value);
}
