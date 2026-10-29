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
import { isAbsolute } from "node:path";
import { workDurationSchema, optionalTimeoutSchema } from "./work-duration.js";
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const absolute = z.string().refine(isAbsolute, "Path must be absolute");
const optionalInputLimit = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .default(null);
export const completionInputLimitsSchema = z.strictObject({
  maxRequestBytes: optionalInputLimit,
  maxExpandedCharacters: optionalInputLimit,
  maxMessages: optionalInputLimit,
});
export type CompletionInputLimits = z.infer<typeof completionInputLimitsSchema>;
export const profileSchema = z.strictObject({
  permissionMode: z.enum(["default", "bypass"]).default("default"),
  tools: z
    .array(
      z.enum([
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "Agent",
      ]),
    )
    .max(9)
    .default(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]),
  model: z
    .string()
    .regex(/^[a-zA-Z0-9_.:-]{1,100}$/)
    .optional(),
  timeoutMs: z.number().int().min(100).max(3600000).default(300000),
  workDuration: workDurationSchema.optional(),
  maxOutputBytes: z.number().int().min(1000).max(16000000).default(2000000),
  maxTurns: z.number().int().min(1).max(1000).default(100),
  maxSubagents: z.number().int().min(0).max(64).default(8),
  agents: z
    .record(
      identifier,
      z.strictObject({
        description: z.string().min(1).max(2000),
        prompt: z.string().min(1).max(20000),
        tools: z
          .array(
            z.enum([
              "Read",
              "Write",
              "Edit",
              "Bash",
              "Glob",
              "Grep",
              "WebFetch",
              "WebSearch",
            ]),
          )
          .max(8)
          .default(["Read", "Glob", "Grep"]),
      }),
    )
    .default({}),
});
export const templateSchema = z.strictObject({
  id: identifier,
  description: z.string().max(2000).default(""),
  inputs: z.array(identifier).max(32).default([]),
  steps: z
    .array(
      z.strictObject({
        id: identifier,
        prompt: z.string().min(1).max(100000),
        profile: identifier.default("default"),
      }),
    )
    .min(1)
    .max(32),
});
export type WorkflowTemplate = z.infer<typeof templateSchema>;
export const configSchema = z.strictObject({
  dataDir: absolute,
  workspace: absolute,
  worker: z.enum(["claude", "codex"]).default("claude"),
  claudePath: absolute.optional(),
  codexPath: absolute.optional(),
  host: z.literal("127.0.0.1").default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8766),
  concurrency: z.number().int().min(1).max(8).default(1),
  queueCapacity: z.number().int().min(1).max(10000).default(1000),
  allowedHosts: z
    .array(z.string().min(1).max(253))
    .default(["localhost", "127.0.0.1"]),
  allowedOrigins: z.array(z.string().url()).default([]),
  idleMs: z.number().int().min(1000).max(3600000).default(30000),
  openai: z
    .strictObject({
      timeoutMs: z.number().int().min(100).max(3600000).default(300000),
      waitTimeoutMs: optionalTimeoutSchema.optional(),
      maxConnections: z.number().int().min(1).max(64).default(16),
      ...completionInputLimitsSchema.shape,
    })
    .prefault({}),
  profiles: z
    .record(identifier, profileSchema)
    .default({ default: profileSchema.parse({}) }),
  workflows: z.array(templateSchema).max(100).default([]),
});
export type BridgeConfig = z.infer<typeof configSchema>;
export function parseConfig(value: unknown): BridgeConfig {
  const config = configSchema.parse(value);
  if (!(config.worker === "codex" ? config.codexPath : config.claudePath))
    throw new Error(
      "The selected worker requires its absolute executable path",
    );
  if (!config.profiles.default)
    throw new Error("A default execution profile is required");
  for (const template of config.workflows)
    for (const step of template.steps)
      if (!config.profiles[step.profile])
        throw new Error("Workflow references an unknown profile");
  return config;
}
