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

import { prepareCompletion } from "./completion-protocol.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, Outcome } from "./contracts.js";
import type {
  ProviderObservations,
  QuotaObservation,
  Worker,
  WorkerReadiness,
} from "./worker.js";
import { QueueStore } from "./store.js";
import { Workflows } from "./workflows.js";
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private stopped = true;
  private ticking = false;
  readonly owner = randomUUID();
  private readinessValue: WorkerReadiness = { ready: true };
  private readinessRevisionValue = 0;
  private readinessAt = new Date().toISOString();
  get readinessRevision(): number {
    return this.readinessRevisionValue;
  }
  get readiness(): WorkerReadiness {
    return this.readinessValue;
  }
  set readiness(value: WorkerReadiness) {
    this.readinessValue = value;
    this.readinessRevisionValue++;
    this.readinessAt = new Date().toISOString();
  }
  get observations(): ProviderObservations {
    const gate = this.controlState;
    const retained = this.store.db
      .prepare("SELECT value FROM metadata WHERE key='provider_quota'")
      .get() as { value: string } | undefined;
    const value = retained
      ? (JSON.parse(retained.value) as QuotaObservation)
      : null;
    const historical: QuotaObservation | null = value
      ? {
          ...value,
          provider:
            value.provider === "claude" || value.provider === "codex"
              ? value.provider
              : null,
        }
      : gate.reason?.startsWith("quota_exhausted")
        ? {
            state: "limited",
            provider: null,
            source: "retained_scheduler_gate",
            observedAt: null,
            resetAt:
              typeof gate.retryAt === "number" &&
              Number.isFinite(gate.retryAt) &&
              gate.retryAt > 0
                ? gate.retryAt
                : null,
          }
        : null;
    const authentication = this.readiness.authentication ?? {
      provider: null,
      state: "unknown" as const,
      source: "not_reported" as const,
      observedAt: null,
    };
    const provider = authentication.provider ?? null;
    const quota: QuotaObservation =
      provider && historical?.provider === provider
        ? historical
        : {
            provider,
            state: "unknown",
            source: "not_reported",
            observedAt: null,
            resetAt: null,
          };
    return {
      version: 1,
      authentication,
      quota,
      lastQuotaLimit: historical,
      dispatch: {
        state: gate.paused
          ? "paused"
          : this.readiness.ready
            ? "enabled"
            : this.readiness.reason?.startsWith("Checking")
              ? "checking"
              : "unavailable",
        source: "scheduler",
        observedAt: this.readinessAt,
        ...((gate.reason ?? this.readiness.reason)
          ? { reason: gate.reason ?? this.readiness.reason }
          : {}),
      },
    };
  }
  get controlState(): { paused: boolean; reason?: string; retryAt?: number } {
    const row = this.store.db
      .prepare("SELECT value FROM metadata WHERE key='scheduler_control'")
      .get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { paused: false };
  }
  /** The gate is durable so a host restart cannot erase a subscription limit. */
  pause(
    reason = "operator_pause",
    retryAt?: number,
    provider: QuotaObservation["provider"] = null,
  ): void {
    this.store.atomic(() => {
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO metadata VALUES('scheduler_control',?)",
        )
        .run(JSON.stringify({ paused: true, reason, retryAt }));
      if (reason.startsWith("quota_exhausted")) {
        const observation: QuotaObservation = {
          state: "limited",
          provider,
          source: "worker_quota_rejection",
          observedAt: new Date().toISOString(),
          resetAt:
            typeof retryAt === "number" &&
            Number.isFinite(retryAt) &&
            retryAt > Date.now()
              ? retryAt
              : null,
        };
        this.store.db
          .prepare("INSERT OR REPLACE INTO metadata VALUES('provider_quota',?)")
          .run(JSON.stringify(observation));
      }
    });
    this.readiness = { ...this.readiness, ready: false, reason };
    for (const [id] of this.active)
      this.store.pause(id, { id: "system", owner: true, profiles: [] });
  }
  resume(): void {
    const gate = this.controlState;
    if (gate.retryAt && gate.retryAt > Date.now())
      throw new Error("The provider reset time has not arrived");
    const quota = this.observations.lastQuotaLimit;
    this.store.atomic(() => {
      // Old installations retained the limit only in the gate; clearing dispatch is not a quota observation.
      if (quota?.state === "limited")
        this.store.db
          .prepare("INSERT OR IGNORE INTO metadata VALUES('provider_quota',?)")
          .run(JSON.stringify(quota));
      this.store.db
        .prepare("DELETE FROM metadata WHERE key='scheduler_control'")
        .run();
    });
    this.readiness = { ...this.readiness, ready: true, reason: undefined };
    this.wake();
  }
  constructor(
    private store: QueueStore,
    private workflows: Workflows,
    private workerFor: (job: Job) => Worker,
    private workspace: string,
    private concurrency: number,
    /** When false (cluster coordinator), skip local CLI claim/run. */
    private claimLocalCli = true,
  ) {}
  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 100);
    this.wake();
  }
  get activeCount(): number {
    return this.active.size;
  }
  wake(): void {
    void this.tick().catch((error) => {
      this.readiness = {
        ready: false,
        reason: error instanceof Error ? error.message : "Scheduler failure",
      };
    });
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      for (const [id, entry] of this.active)
        if (
          ["cancel_requested", "pause_requested"].includes(
            this.store.get(id).status,
          )
        )
          entry.controller.abort(
            this.store.get(id).status === "pause_requested"
              ? "pause"
              : "cancel",
          );
      const gate = this.controlState;
      if (gate.paused) {
        this.readiness = {
          ...this.readiness,
          ready: false,
          reason: gate.reason,
        };
        if (!gate.retryAt || gate.retryAt > Date.now() || this.active.size)
          return;
        // Only an explicit provider timestamp enables automatic continuation; unknown resets remain manual.
        for (const row of this.store.db
          .prepare("SELECT data FROM jobs WHERE status='paused'")
          .all() as { data: string }[]) {
          const job = JSON.parse(row.data) as Job;
          if (
            (job.completion &&
              prepareCompletion(job.completion).images.length > 0) ||
            !job.error?.startsWith("quota_exhausted") ||
            !job.sessionId ||
            (job.autoResumes ?? 0) >= 3
          )
            continue;
          if (
            job.workflowRunId &&
            this.workflows.get(job.workflowRunId, {
              id: "system",
              owner: true,
              profiles: [],
            }).pauseRequested
          )
            continue;
          job.autoResumes = (job.autoResumes ?? 0) + 1;
          this.store.db
            .prepare("UPDATE jobs SET data=? WHERE id=?")
            .run(JSON.stringify(job), job.id);
          this.store.resume(job.id, {
            id: "system",
            owner: true,
            profiles: [],
          });
        }
        this.resume();
      }
      this.workflows.advance();
      while (
        this.claimLocalCli &&
        !this.stopped &&
        !this.controlState.paused &&
        this.active.size < this.concurrency
      ) {
        const job = this.store.pending("cli")[0];
        if (!job) break;
        const worker = this.workerFor(job);
        const readiness = await worker.ready();
        const provider = readiness.authentication?.provider ?? null;
        this.readiness = readiness;
        // Readiness can await a subprocess while another attempt closes the quota gate.
        if (!this.readiness.ready || this.stopped || this.controlState.paused)
          break;
        const attempt = this.store.claim(this.owner, "cli", job.id);
        if (!attempt) continue;
        const cwd = join(this.workspace, job.id);
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const controller = new AbortController();
        const promise = (async () => {
          let outcome: Outcome;
          try {
            outcome = await worker.run(
              { job: this.store.get(job.id), attempt, cwd },
              (e) => this.store.observe(attempt, e),
              controller.signal,
            );
          } catch {
            outcome = {
              status: "failed",
              error: "worker_failed: execution did not complete",
            };
          }
          if (
            this.store.get(job.id).status === "cancel_requested" &&
            outcome.status !== "canceled"
          )
            outcome = {
              status: "interrupted",
              error: "Cancellation could not be confirmed",
            };
          if (
            this.store.get(job.id).status === "pause_requested" &&
            outcome.status === "canceled"
          )
            outcome = {
              status: "paused",
              error: "operator_pause",
              sessionId: this.store.get(job.id).sessionId,
            };
          this.store.finish(attempt, outcome);
          if (
            outcome.error?.startsWith("quota_exhausted") ||
            outcome.error?.startsWith("authentication_required")
          )
            this.pause(outcome.error, outcome.retryAt, provider);
        })().finally(() => {
          this.active.delete(job.id);
        });
        this.active.set(job.id, { controller, promise });
      }
    } finally {
      this.ticking = false;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.ticking) await new Promise((r) => setTimeout(r, 10));
    for (const [id, e] of this.active) {
      this.store.pause(id, { id: "system", owner: true, profiles: [] });
      e.controller.abort("pause");
    }
    await Promise.allSettled([...this.active.values()].map((e) => e.promise));
  }
}
