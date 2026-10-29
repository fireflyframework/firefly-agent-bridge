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
import type { ChatRequest } from "./completion-protocol.js";
import { workDurationSchema } from "./work-duration.js";
export type TokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};
export const jobInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(100_000),
  profile: z
    .string()
    .regex(/^[\w-]{1,64}$/)
    .default("default"),
  mode: z.enum(["cli", "channel"]).default("cli"),
  workDuration: workDurationSchema.optional(),
});
export type JobInput = z.infer<typeof jobInputSchema>;
export const completionJobInputSchema = jobInputSchema.extend({
  prompt: z.string().trim().min(1),
});
export type JobStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted"
  | "timed_out";
export type Principal = {
  id: string;
  owner: boolean;
  profiles: string[];
  scopes?: string[];
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

/** Coordinator-owned incremental packet injected after sticky failover (no native CLI session transfer). */
export type ClusterHandoff = {
  reason: "quota" | "health" | "offline" | "drain";
  fromNodeId: string;
  brief: string;
  recentTurns: Array<{ role: "user" | "assistant"; text: string }>;
  createdAt: string;
};

export type Job = JobInput & {
  worker?: "claude" | "codex";
  completion?: ChatRequest;
  usage?: TokenUsage;
  pendingMessages?: Message[];
  resumePending?: boolean;
  resumedTurns?: number;
  autoResumes?: number;
  retryAt?: number;
  compactions?: number;
  activity?: string;
  subagents?: Record<string, { status: string; description?: string }>;
  id: string;
  principalId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
  sessionId?: string;
  sessionNodeId?: string;
  assignedNodeId?: string;
  workflowRunId?: string;
  stepId?: string;
  messages: Message[];
  clusterHandoff?: ClusterHandoff;
  failoverCount?: number;
  failoverAt?: string;
};

/** Owner or `admin` scope may see internal cluster routing fields on jobs. */
export function canSeeClusterNodeFields(p: Principal): boolean {
  return p.owner || Boolean(p.scopes?.includes("admin"));
}

/**
 * Default client job view: omit internal node routing fields unless
 * the principal is owner or has `admin` scope.
 */
export function jobForClient(job: Job, p: Principal): Job {
  if (canSeeClusterNodeFields(p)) return job;
  if (
    job.sessionNodeId === undefined &&
    job.assignedNodeId === undefined &&
    job.clusterHandoff === undefined &&
    job.failoverCount === undefined &&
    job.failoverAt === undefined
  )
    return job;
  const view = { ...job };
  delete view.sessionNodeId;
  delete view.assignedNodeId;
  delete view.clusterHandoff;
  delete view.failoverCount;
  delete view.failoverAt;
  return view;
}

export type Attempt = {
  id: string;
  jobId: string;
  owner: string;
  fence: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  nodeId?: string;
};
export type Outcome = {
  usage?: TokenUsage;
  status:
    | "succeeded"
    | "failed"
    | "canceled"
    | "interrupted"
    | "timed_out"
    | "paused";
  retryAt?: number;
  result?: string;
  error?: string;
  sessionId?: string;
};
export type BridgeEvent = {
  id: number;
  principalId: string;
  jobId: string;
  type: string;
  data: unknown;
  createdAt: string;
};
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
export const terminal = new Set<JobStatus>([
  "succeeded",
  "failed",
  "canceled",
  "interrupted",
  "timed_out",
]);
