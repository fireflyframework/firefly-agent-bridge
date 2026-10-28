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

import { workerRunPrompt } from "./cluster-handoff.js";
import { bridgePrompt } from "./prompt-catalog.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageImages } from "./images.js";
import type { ClaudeOptions } from "./claude.js";
import type { Outcome } from "./contracts.js";
import type {
  AuthenticationObservation,
  Execution,
  Worker,
  WorkerEvent,
  WorkerReadiness,
} from "./worker.js";
import {
  completionEnvelopeSchema,
  completionSystemPrompt,
  parseCompletionResult,
  prepareCompletion,
} from "./completion-protocol.js";
const execute = promisify(execFile);
export class CodexWorker implements Worker {
  constructor(private options: ClaudeOptions) {}
  private environment(): NodeJS.ProcessEnv {
    return { ...(this.options.env ?? process.env) };
  }
  async ready(): Promise<WorkerReadiness> {
    const observation = (
      state: AuthenticationObservation["state"],
      source: AuthenticationObservation["source"],
    ): AuthenticationObservation => ({
      provider: "codex",
      state,
      source,
      observedAt: new Date().toISOString(),
    });
    const env = this.environment();
    if (
      [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "OPENAI_BASE_URL",
      ].some((key) => env[key])
    )
      return {
        ready: false,
        authentication: observation("unavailable", "official_cli_preflight"),
        reason:
          "subscription_configuration: remove API/provider overrides from the service environment",
      };
    try {
      const auth = await execute(
        this.options.path,
        [...(this.options.args ?? []), "login", "status"],
        { env, timeout: 10000, maxBuffer: 20000 },
      );
      return /Logged in using ChatGPT/.test(auth.stdout + auth.stderr)
        ? {
            ready: true,
            authentication: observation(
              "authenticated",
              "official_cli_auth_status",
            ),
          }
        : {
            ready: false,
            authentication: observation("required", "official_cli_auth_status"),
            reason:
              "authentication_required: sign in with official Codex ChatGPT login",
          };
    } catch {
      return {
        ready: false,
        authentication: observation("unavailable", "official_cli_preflight"),
        reason:
          "authentication_required: verify the Codex executable and ChatGPT login",
      };
    }
  }
  async run(
    input: Execution,
    emit: (event: WorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<Outcome> {
    if (signal.aborted) return { status: "canceled" };
    const ready = await this.ready();
    if (signal.aborted) return { status: "canceled" };
    if (!ready.ready) return { status: "failed", error: ready.reason };
    const inference = Boolean(input.job.completion);
    const images = input.job.completion
      ? prepareCompletion(input.job.completion).images
      : [];
    if (images.length && input.job.sessionId)
      return {
        status: "failed",
        error: "image_replay_unsupported: start a new explicit image request",
      };
    const staged = stageImages(input.cwd, images);
    try {
      const args = [
        ...(this.options.args ?? []),
        "--sandbox",
        inference
          ? "read-only"
          : this.options.permissionMode === "bypass"
            ? "danger-full-access"
            : "workspace-write",
        "-a",
        "never",
        "exec",
        "--json",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'web_search="disabled"',
      ];
      if (this.options.model) args.push("--model", this.options.model);
      if (inference) {
        for (const feature of [
          "shell_tool",
          "unified_exec",
          "apply_patch_freeform",
          "js_repl",
          "multi_agent",
          "multi_agent_v2",
          "image_generation",
          "view_image",
          "in_app_browser",
          "browser_use_external",
          "browser_use_full_cdp_access",
          "apps",
          "browser_use",
          "computer_use",
          "memories",
        ])
          args.push("--disable", feature);
        const schemaPath = join(input.cwd, "completion-schema.json");
        writeFileSync(schemaPath, JSON.stringify(completionEnvelopeSchema), {
          mode: 0o600,
        });
        args.push("--output-schema", schemaPath);
      }
      // After cluster failover there is no sessionId — handoff brief replaces resume.
      if (input.job.sessionId) args.push("resume", input.job.sessionId);
      for (const path of staged.paths) args.push("--image", path);
      args.push("-");
      const prompt = workerRunPrompt(input.job, {
        continuationPrompt: bridgePrompt("workers/codex-continuation"),
        conversationHeading: bridgePrompt(
          "workers/quoted-conversation-heading",
        ),
        completionPrefix: inference ? completionSystemPrompt + "\n\n" : "",
        freshMultiTurn: "prompt",
      });
      return await new Promise<Outcome>((resolve) => {
        const child = spawn(this.options.path, args, {
          cwd: input.cwd,
          env: this.environment(),
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let buffer = "",
          bytes = 0,
          sessionId = input.job.sessionId,
          answer = "",
          completed = false,
          error: string | undefined,
          stop: Outcome["status"] | undefined,
          settled = false,
          killTimer: ReturnType<typeof setTimeout> | undefined;
        const kill = (force: boolean) => {
          if (!child.pid) return;
          if (process.platform === "win32")
            void execute("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
              timeout: 5000,
            }).catch(() => child.kill());
          else {
            try {
              process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
            } catch {
              /* An exited process group needs no further signal. */
            }
          }
        };
        const stopWork = (status: Outcome["status"]) => {
          if (stop) return;
          stop = status;
          kill(false);
          killTimer = setTimeout(() => kill(true), 2000);
        };
        const parse = (line: string) => {
          if (!line.trim()) return;
          try {
            const event = JSON.parse(line) as {
              type: string;
              thread_id?: string;
              error?: { message?: string };
              message?: string;
              usage?: { input_tokens: number; output_tokens: number };
              item?: {
                id: string;
                type: string;
                command?: string;
                text?: string;
                status?: string;
                aggregated_output?: string;
                exit_code?: number;
                changes?: { path: string; kind: string }[];
                [key: string]: unknown;
              };
            };
            if (event.type === "thread.started" && event.thread_id) {
              sessionId = event.thread_id;
              emit({
                kind: "session",
                text: "Native Codex session",
                data: { sessionId, worker: "codex" },
              });
            }
            if (event.type === "turn.completed") {
              completed = true;
              const usage = event.usage;
              if (
                usage &&
                Number.isFinite(usage.input_tokens) &&
                Number.isFinite(usage.output_tokens)
              )
                resultUsage = {
                  prompt_tokens: usage.input_tokens,
                  completion_tokens: usage.output_tokens,
                  total_tokens: usage.input_tokens + usage.output_tokens,
                };
            }
            if (event.type === "turn.failed" || event.type === "error")
              error =
                event.error?.message ??
                event.message ??
                "Codex execution failed";
            const item = event.item;
            if (item?.type === "error") {
              emit({
                kind: "progress",
                text:
                  typeof item.message === "string"
                    ? item.message.slice(0, 4096)
                    : "Codex reported a diagnostic",
                data: { diagnostic: true },
              });
              return;
            }
            if (
              inference &&
              item &&
              !["agent_message", "reasoning", "todo_list"].includes(item.type)
            ) {
              error =
                "unexpected_tool_execution: inference rejected native item " +
                String(item.type).slice(0, 128);
              stopWork("failed");
              return;
            }
            if (
              item?.type === "agent_message" &&
              event.type === "item.completed"
            ) {
              answer = item.text ?? "";
              emit({ kind: "output", text: answer });
            }
            if (
              item &&
              ["command_execution", "file_change", "mcp_tool_call"].includes(
                item.type,
              )
            ) {
              if (inference) {
                error =
                  "unexpected_tool_execution: inference must return client functions without native actions";
                stopWork("failed");
                return;
              }
              const phase =
                event.type === "item.started"
                  ? "requested"
                  : item.status === "failed" ||
                      (typeof item.exit_code === "number" &&
                        item.exit_code !== 0)
                    ? "failed"
                    : "succeeded";
              const name =
                item.type === "command_execution"
                  ? "Bash"
                  : item.type === "file_change"
                    ? "Edit"
                    : "MCP";
              emit({
                kind: "tool",
                text: name,
                tool: {
                  toolId: item.id,
                  name,
                  phase,
                  ...(sessionId ? { sessionId } : {}),
                  ...(phase === "requested"
                    ? { input: item }
                    : { output: item }),
                  ...(item.changes?.length === 1
                    ? {
                        file: {
                          path: item.changes[0]!.path,
                          operation: "edit",
                        },
                      }
                    : {}),
                },
              });
            }
            if (item?.type === "reasoning" || item?.type === "todo_list")
              emit({
                kind: "progress",
                text: item.text ?? item.type,
                data: { item },
              });
          } catch {
            error = "invalid_output: Codex emitted malformed JSON";
            stopWork("failed");
          }
        };
        let resultUsage: Outcome["usage"];
        const timer = setTimeout(
          () => stopWork("timed_out"),
          this.options.timeoutMs,
        );
        const abort = () => stopWork("canceled");
        signal.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.options.maxOutputBytes) {
            error = "output_limit: Codex output exceeded configured bounds";
            stopWork("failed");
            return;
          }
          buffer += chunk.toString("utf8");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            parse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.options.maxOutputBytes) {
            error = "output_limit: Codex output exceeded configured bounds";
            stopWork("failed");
          }
        });
        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          if (buffer.trim()) parse(buffer);
          clearTimeout(timer);
          if (stop) kill(true);
          if (killTimer) clearTimeout(killTimer);
          signal.removeEventListener("abort", abort);
          let outcome: Outcome = {
            status:
              stop ??
              (completed && !error && code === 0 ? "succeeded" : "failed"),
            ...(sessionId ? { sessionId } : {}),
            ...(error ? { error } : {}),
            ...(resultUsage ? { usage: resultUsage } : {}),
          };
          if (
            !stop &&
            error &&
            /rate.?limit|quota|usage limit|usage_limit/i.test(error)
          )
            outcome = {
              ...outcome,
              status: "paused",
              error:
                "quota_exhausted: Codex ChatGPT subscription limit reached",
            };
          if (outcome.status === "succeeded") {
            try {
              if (input.job.completion)
                parseCompletionResult(answer, input.job.completion);
              outcome.result = answer;
            } catch {
              outcome = {
                ...outcome,
                status: "failed",
                error:
                  "invalid_completion: Codex returned invalid structured output",
              };
            }
          } else
            outcome.error ??=
              stop === "timed_out"
                ? "worker_timeout"
                : "worker_failed: Codex did not complete a turn";
          resolve(outcome);
        };
        child.on("error", () => {
          error = "worker_spawn_failed";
          finish(null);
        });
        child.on("close", finish);
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      });
    } finally {
      staged.cleanup();
    }
  }
}
