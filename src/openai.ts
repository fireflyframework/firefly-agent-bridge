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

import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { recoveryRequestId } from "./completion-recovery.js";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  BridgeError,
  terminal,
  type Job,
  type Principal,
} from "./contracts.js";
import {
  prepareCompletion,
  completionResponse,
} from "./completion-protocol.js";
import type { HttpDependencies } from "./http.js";
import { freezeImageExecution } from "./image-execution.js";
import { IMAGE_BODY_LIMIT } from "./images.js";
import {
  imageCapability,
  registerImageCapabilities,
} from "./image-capabilities.js";

export class CompletionError extends BridgeError {
  constructor(
    code: string,
    message: string,
    status: number,
    public retryAfter?: number,
  ) {
    super(code, message, status);
  }
}
export function openAIError(
  error: BridgeError,
  requestId?: string,
  jobId?: string,
) {
  return {
    error: {
      message: error.message,
      type:
        error.status === 401
          ? "authentication_error"
          : error.status === 429
            ? "rate_limit_error"
            : error.status >= 500
              ? "server_error"
              : "invalid_request_error",
      param: null,
      code: error.code,
      ...(requestId ? { requestId } : {}),
      ...(jobId ? { job_id: jobId } : {}),
    },
  };
}
function paused(reason: string, retryAt?: number) {
  const quota = reason.startsWith("quota_exhausted");
  return new CompletionError(
    quota ? "quota_exhausted" : "execution_paused",
    reason,
    quota ? 429 : 503,
    retryAt ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)) : undefined,
  );
}
export function registerOpenAI(
  app: FastifyInstance,
  d: HttpDependencies,
  scope: (req: FastifyRequest, scope: string) => Principal,
) {
  registerImageCapabilities(app, d, scope);
  const wires = new WeakMap<
    FastifyRequest,
    { sha256: string; bytes: number }
  >();
  app.get("/v1/bridge/completion-requests/:request", async (req) => {
    const principal = scope(req, "read");
    const key = recoveryRequestId.parse(
      (req.params as { request: string }).request,
    );
    return d.store.atomic(() =>
      d.store.completionRecovery.read(principal, key, (id) => {
        const job = d.store.get(id, principal);
        if (!d.config.profiles[job.profile])
          throw new BridgeError(
            "profile_forbidden",
            "Profile is unavailable",
            403,
          );
        return job;
      }),
    );
  });
  const waiters = new Map<
    AbortController,
    { principal: string; job: string; settled: Promise<void> }
  >();
  let stopping = false;
  app.addHook("preClose", async () => {
    stopping = true;
    const settled = [...waiters.values()].map((w) => w.settled);
    for (const c of waiters.keys())
      c.abort(
        new BridgeError(
          "service_stopping",
          "Bridge is stopping; inspect the durable job before retrying",
          503,
        ),
      );
    // Flush small terminal errors, then let Fastify close all remaining TCP sockets.
    // Canceled HTTP clients can open idle replacement sockets without a request.
    await Promise.race([Promise.allSettled(settled), delay(200)]);
  });
  app.get("/v1/models", async (req) => {
    const p = scope(req, "read");
    return {
      object: "list",
      data: Object.keys(d.config.profiles)
        .filter((n) => p.owner || p.profiles.includes(n))
        .map((n) => ({
          id: "bridge/" + n,
          object: "model",
          created: 0,
          owned_by: "firefly-oss",
          worker: d.config.worker,
          native_model: d.config.profiles[n]!.model ?? null,
          image_input: imageCapability(d, n),
        })),
    };
  });
  app.post(
    "/v1/chat/completions",
    {
      bodyLimit: IMAGE_BODY_LIMIT,
      preParsing: async (req, _reply, payload) => {
        const recovery = req.headers["x-bridge-completion-recovery"];
        if (recovery === undefined) return payload;
        if (
          recovery !== "1" ||
          !recoveryRequestId.safeParse(req.headers["idempotency-key"]).success
        )
          throw new BridgeError(
            "invalid_completion_recovery",
            "Use recovery version 1 and one fbr1_ request identity",
            400,
          );
        const hash = createHash("sha256");
        let bytes = 0;
        const stream = Object.assign(
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length;
              stream.receivedEncodedLength = bytes;
              if (bytes <= IMAGE_BODY_LIMIT) hash.update(chunk);
              done(null, chunk);
            },
            flush(done) {
              wires.set(req, { sha256: hash.digest("hex"), bytes });
              done();
            },
          }),
          { receivedEncodedLength: 0 },
        );
        return payload.pipe(stream);
      },
    },
    async (req, reply) => {
      scope(req, "read");
      const p = scope(req, "submit");
      const { request, prompt, images } = prepareCompletion(req.body);
      const imageRevision = images.length
        ? req.headers["x-bridge-image-revision"]
        : undefined;
      if (
        Array.isArray(imageRevision) ||
        (imageRevision !== undefined && !/^[a-f0-9]{64}$/.test(imageRevision))
      )
        throw new BridgeError(
          "invalid_image_revision",
          "Use one SHA-256 image configuration revision",
          400,
        );
      let recoverable = req.headers["x-bridge-completion-recovery"] === "1";
      if (recoverable && request.bridge.execution !== "inference")
        throw new BridgeError(
          "invalid_completion_recovery",
          "Recovery applies only to inference completions",
          400,
        );
      const profile = request.model.slice("bridge/".length);
      if (
        !d.config.profiles[profile] ||
        (!p.owner && !p.profiles.includes(profile))
      )
        throw new BridgeError(
          "model_not_found",
          "Model is unavailable to this client",
          404,
        );
      if (stopping)
        throw new BridgeError("service_stopping", "Bridge is stopping", 503);
      if (
        !request.bridge.background &&
        (waiters.size >= d.config.openai.maxConnections ||
          [...waiters.values()].filter((w) => w.principal === p.id).length >= 4)
      )
        throw new BridgeError(
          "connections_full",
          "Too many active completion requests",
          429,
        );
      const key = req.headers["idempotency-key"];
      if (Array.isArray(key))
        throw new BridgeError("invalid_header", "Use one idempotency key");
      const readinessRevisionAtAdmission = d.scheduler.readinessRevision;
      const job = d.store.atomic(() => {
        let created = false;
        const admitted = d.store.idempotent(
          p,
          "chat/completions",
          key,
          images.length
            ? { request, image_input_revision: imageRevision ?? null }
            : request,
          () => {
            created = true;
            const gate = d.scheduler.controlState;
            if (gate.paused)
              throw paused(gate.reason ?? "operator_pause", gate.retryAt);
            if (imageRevision) {
              const capability = imageCapability(d, profile);
              if (
                capability.status !== "verified" ||
                capability.config_revision !== imageRevision
              )
                throw new BridgeError(
                  "image_configuration_changed",
                  "Image capability is not verified for the requested revision",
                  409,
                );
            }
            const admitted = d.store.submit(
              {
                prompt,
                profile,
                mode:
                  request.bridge.execution === "channel" ? "channel" : "cli",
              },
              p,
              undefined,
              request.bridge.execution === "inference" ? request : undefined,
            );
            if (images.length)
              freezeImageExecution(d.store, admitted.id, d.config, profile);
            return admitted;
          },
          (id) => d.store.get(id, p),
        );
        if (recoverable) {
          const wire = wires.get(req);
          if (!wire)
            throw new BridgeError(
              "completion_wire_unavailable",
              "Original wire digest is unavailable",
              400,
            );
          d.store.completionRecovery.admit(
            admitted,
            p,
            key!,
            wire,
            imageRevision,
            created,
          );
        }
        return admitted;
      });
      recoverable ||= d.store.completionRecovery.has(job.id);
      reply.header("X-Bridge-Job-Id", job.id);
      d.scheduler.wake();
      if (request.bridge.background)
        return reply
          .code(202)
          .send(recoverable ? { id: job.id, completion_request_id: key } : job);
      const controller = new AbortController();
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      waiters.set(controller, { principal: p.id, job: job.id, settled });
      const signal = controller.signal;
      const timeout = setTimeout(
        () =>
          controller.abort(
            new BridgeError(
              "completion_timeout",
              "Completion deadline exceeded; inspect X-Bridge-Job-Id",
              504,
            ),
          ),
        d.config.openai.timeoutMs,
      );
      const disconnected = () => {
        if (!reply.raw.writableEnded)
          controller.abort(
            new BridgeError("client_disconnected", "Client disconnected", 499),
          );
      };
      reply.raw.on("close", disconnected);
      const bearer = req.headers.authorization!.slice(7);
      let retained = recoverable,
        heartbeat: ReturnType<typeof setInterval> | undefined;
      async function write(data: unknown) {
        if (signal.aborted) throw signal.reason;
        if (
          !reply.raw.write(
            "data: " +
              (typeof data === "string" ? data : JSON.stringify(data)) +
              "\n\n",
          )
        )
          await once(reply.raw, "drain", { signal });
      }
      try {
        if (request.stream) {
          reply
            .header("Content-Type", "text/event-stream; charset=utf-8")
            .header("Cache-Control", "no-store")
            .header("X-Accel-Buffering", "no");
          reply.hijack();
          for (const [name, value] of Object.entries(reply.getHeaders()))
            if (value !== undefined) reply.raw.setHeader(name, value);
          reply.raw.writeHead(200);
          reply.raw.write(": waiting for validated completion\n\n");
          heartbeat = setInterval(() => {
            if (!reply.raw.write(": waiting\n\n"))
              controller.abort(
                new BridgeError(
                  "slow_client",
                  "Client is not consuming the response",
                  499,
                ),
              );
          }, 5000);
        }
        let current: Job;
        let original: ReturnType<typeof completionResponse> | undefined;
        for (;;) {
          if (signal.aborted) throw signal.reason;
          const live = d.auth.verify(bearer);
          if (recoverable) {
            if (
              !d.config.profiles[profile] ||
              (!live.owner &&
                (!live.scopes?.includes("read") ||
                  !live.profiles.includes(profile)))
            )
              throw new BridgeError(
                "forbidden",
                "Current token cannot read this completion",
                403,
              );
            const snapshot = d.store.completionRecovery.read(live, key!, (id) =>
              d.store.get(id, live),
            );
            if (snapshot.terminal) {
              if (
                snapshot.terminal.status !== "succeeded" ||
                snapshot.terminal.reason
              )
                throw new BridgeError(
                  snapshot.terminal.reason
                    ? "completion_result_unavailable"
                    : "execution_failed",
                  "Original completion did not retain a deliverable success",
                  502,
                );
              original = JSON.parse(
                snapshot.terminal.result_json!,
              ) as ReturnType<typeof completionResponse>;
              current = d.store.get(job.id, p);
              break;
            }
          }
          current = d.store.get(job.id, p);
          if (current.status === "succeeded") break;
          // A global gate can close while this request is still queued, before
          // the job receives a per-attempt pause. Preserve it for the same-key retry.
          const gate = d.scheduler.controlState;
          if (!terminal.has(current.status) && gate.paused) {
            retained = true;
            throw paused(gate.reason ?? "operator_pause", gate.retryAt);
          }
          if (
            current.status === "paused" ||
            current.status === "pause_requested"
          ) {
            retained = true;
            throw paused(current.error ?? "operator_pause", current.retryAt);
          }
          if (terminal.has(current.status))
            throw new BridgeError(
              current.error?.startsWith("invalid_completion")
                ? "invalid_completion"
                : "execution_failed",
              current.error ?? "Execution did not complete",
              current.status === "timed_out" ? 504 : 502,
            );
          // A startup failure may predate the scheduler's fresh check of queued work.
          if (
            d.scheduler.readinessRevision > readinessRevisionAtAdmission &&
            !d.scheduler.readiness.ready &&
            d.scheduler.readiness.reason &&
            !d.scheduler.readiness.reason.startsWith("Checking")
          )
            throw new BridgeError(
              "execution_unavailable",
              d.scheduler.readiness.reason,
              503,
            );
          await delay(25, undefined, { signal }).catch(() => {
            throw signal.reason;
          });
        }
        const result = original ?? completionResponse(current, request);
        if (!request.stream) return reply.send(result);
        const chunk = (
          delta: unknown,
          finish_reason: string | null = null,
        ) => ({
          ...result,
          object: "chat.completion.chunk",
          usage: null,
          choices: [{ index: 0, delta, finish_reason }],
        });
        await write(chunk({ role: "assistant", content: "" }));
        const message = result.choices[0]!.message;
        if (message.content !== null)
          await write(chunk({ content: message.content }));
        if (message.tool_calls)
          await write(
            chunk({
              tool_calls: message.tool_calls.map((c, index) => ({
                ...c,
                index,
              })),
            }),
          );
        await write(chunk({}, result.choices[0]!.finish_reason));
        if (request.stream_options?.include_usage && result.usage)
          await write({
            ...result,
            object: "chat.completion.chunk",
            choices: [],
            usage: result.usage,
          });
        await write("[DONE]");
        reply.raw.end();
        return reply;
      } catch (caught) {
        const error =
          caught instanceof BridgeError
            ? caught
            : new BridgeError(
                "internal_error",
                "Completion could not be delivered",
                500,
              );
        if (error.code === "service_stopping") retained = true;
        if (request.stream) {
          if (!reply.raw.destroyed) {
            reply.raw.end(
              "data: " +
                JSON.stringify(openAIError(error, req.id, job.id)) +
                "\n\ndata: [DONE]\n\n",
            );
          }
          return reply;
        }
        if (error instanceof CompletionError && error.retryAfter)
          reply.header("Retry-After", error.retryAfter);
        return reply
          .code(error.status === 499 ? 400 : error.status)
          .send(openAIError(error, req.id, job.id));
      } finally {
        clearTimeout(timeout);
        if (heartbeat) clearInterval(heartbeat);
        reply.raw.removeListener("close", disconnected);
        waiters.delete(controller);
        settle();
        // An idempotency key may have several attached HTTP waiters. Only the last
        // detached waiter owns cleanup; durable operator/provider pauses are retained.
        if (!retained && ![...waiters.values()].some((w) => w.job === job.id)) {
          const current = d.store.get(job.id, p);
          if (
            !terminal.has(current.status) &&
            current.status !== "paused" &&
            current.status !== "pause_requested"
          ) {
            d.store.cancel(job.id, p);
            d.scheduler.wake();
          }
        }
      }
    },
  );
}
