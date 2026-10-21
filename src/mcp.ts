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

import { bridgePrompt } from "./prompt-catalog.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { request, type Connection } from "./lifecycle.js";
import type { Job } from "./contracts.js";
import { templateSchema } from "./config.js";
export function createAdapter(
  connection: Connection,
  channel = false,
  lease = true,
) {
  const hostId = randomUUID();
  const server = new McpServer(
    { name: "firefly-agent-bridge", version: "0.2.17" },
    {
      capabilities: channel ? { experimental: { "claude/channel": {} } } : {},
      instructions: bridgePrompt("mcp/server"),
    },
  );
  const register = (
    name: string,
    description: string,
    inputSchema: Record<string, z.ZodType>,
    fn: (args: Record<string, unknown>) => Promise<unknown>,
  ) => {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await fn(args as Record<string, unknown>)),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                error instanceof Error
                  ? error.message
                  : "Bridge operation failed",
            },
          ],
        };
      }
    });
  };
  register("bridge_status", bridgePrompt("tools/bridge_status"), {}, () =>
    request(connection, "/v1/bridge/status"),
  );
  register(
    "bridge_submit",
    bridgePrompt("tools/bridge_submit"),
    {
      prompt: z.string().min(1).max(100000),
      profile: z.string().default("default"),
      mode: z.enum(["cli", "channel", "inference"]).default("cli"),
    },
    (args) =>
      request(connection, "/v1/chat/completions", {
        model: "bridge/" + args.profile,
        messages: [{ role: "user", content: args.prompt }],
        bridge: {
          execution: args.mode === "cli" ? "agent" : args.mode,
          background: true,
        },
      }),
  );
  register(
    "bridge_jobs",
    bridgePrompt("tools/bridge_jobs"),
    { after: z.string().optional() },
    (a) =>
      request(
        connection,
        "/v1/bridge/jobs?after=" + encodeURIComponent(String(a.after ?? "")),
      ),
  );
  register(
    "bridge_job",
    bridgePrompt("tools/bridge_job"),
    { id: z.string().uuid() },
    (a) => request(connection, "/v1/bridge/jobs/" + a.id),
  );
  register(
    "bridge_message",
    bridgePrompt("tools/bridge_message"),
    { id: z.string().uuid(), text: z.string().min(1).max(100000) },
    (a) =>
      request(connection, "/v1/bridge/jobs/" + a.id + "/messages", {
        text: a.text,
      }),
  );
  register(
    "bridge_control",
    bridgePrompt("tools/bridge_control"),
    {
      id: z.string().uuid(),
      action: z.enum(["pause", "resume", "cancel", "retry"]),
    },
    (a) => request(connection, "/v1/bridge/jobs/" + a.id + "/" + a.action, {}),
  );
  register(
    "bridge_scheduler",
    bridgePrompt("tools/bridge_scheduler"),
    { action: z.enum(["pause", "resume"]) },
    (a) => request(connection, "/v1/bridge/admin/" + a.action, {}),
  );
  register("bridge_workflows", bridgePrompt("tools/bridge_workflows"), {}, () =>
    request(connection, "/v1/bridge/workflow-runs"),
  );
  register("bridge_templates", bridgePrompt("tools/bridge_templates"), {}, () =>
    request(connection, "/v1/bridge/admin/templates"),
  );
  register(
    "bridge_template_save",
    bridgePrompt("tools/bridge_template_save"),
    templateSchema.shape,
    (a) =>
      request(
        connection,
        "/v1/bridge/admin/templates/" + encodeURIComponent(String(a.id)),
        a,
        "PUT",
      ),
  );
  register(
    "bridge_workflow_start",
    bridgePrompt("tools/bridge_workflow_start"),
    { templateId: z.string(), inputs: z.record(z.string(), z.string()) },
    (a) => request(connection, "/v1/bridge/workflow-runs", a),
  );
  register(
    "bridge_workflow_control",
    bridgePrompt("tools/bridge_workflow_control"),
    { id: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]) },
    (a) =>
      request(
        connection,
        "/v1/bridge/workflow-runs/" + a.id + "/" + a.action,
        {},
      ),
  );
  register(
    "bridge_panel",
    bridgePrompt("tools/bridge_panel"),
    {},
    async () => ({
      url: connection.address + "/",
      authentication: bridgePrompt("mcp/panel-authentication"),
    }),
  );
  if (lease) {
    register(
      "bridge_channel_pending",
      bridgePrompt("tools/bridge_channel_pending"),
      {},
      () => request(connection, "/v1/bridge/channel/pending"),
    );
    register(
      "bridge_channel_claim",
      bridgePrompt("tools/bridge_channel_claim"),
      { jobId: z.string().uuid() },
      (a) => request(connection, "/v1/bridge/channel/claim", { ...a, hostId }),
    );
    const receipt = { attemptId: z.string().uuid(), fence: z.string().uuid() };
    register(
      "bridge_channel_progress",
      bridgePrompt("tools/bridge_channel_progress"),
      { ...receipt, text: z.string().max(16000) },
      (a) =>
        request(connection, "/v1/bridge/channel/progress", { ...a, hostId }),
    );
    register(
      "bridge_channel_complete",
      bridgePrompt("tools/bridge_channel_complete"),
      { ...receipt, result: z.string().max(100000) },
      (a) =>
        request(connection, "/v1/bridge/channel/complete", { ...a, hostId }),
    );
    register(
      "bridge_channel_stopped",
      bridgePrompt("tools/bridge_channel_stopped"),
      receipt,
      (a) =>
        request(connection, "/v1/bridge/channel/stopped", { ...a, hostId }),
    );
  }
  let busy = false,
    closed = false,
    lastNotify = 0;
  async function heartbeat() {
    if (busy || closed) return;
    busy = true;
    try {
      await request(connection, "/v1/bridge/hosts/heartbeat", { id: hostId });
      if (channel && Date.now() - lastNotify > 15000) {
        const data = (await request(
          connection,
          "/v1/bridge/channel/pending",
        )) as {
          jobs: Job[];
        };
        if (data.jobs.length)
          await server.server.notification({
            method: "notifications/claude/channel",
            params: {
              content: bridgePrompt("mcp/channel-notification"),
              meta: { pending: String(data.jobs.length) },
            },
          });
        lastNotify = Date.now();
      }
    } catch {
      /* Host readiness and tool calls report connection failures; never contaminate stdio protocol output. */
    } finally {
      busy = false;
    }
  }
  const timer = lease ? setInterval(() => void heartbeat(), 2000) : undefined;
  timer?.unref();
  server.server.oninitialized = () => {
    if (lease) void heartbeat();
  };
  server.server.onclose = () => {
    closed = true;
    if (timer) clearInterval(timer);
    if (lease)
      void request(connection, "/v1/bridge/hosts/disconnect", {
        id: hostId,
      }).catch(() => {});
  };
  return server;
}
