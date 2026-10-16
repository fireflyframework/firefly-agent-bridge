/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  BridgeError,
  terminal,
  type Job,
  type Principal,
} from "./contracts.js";
import { completionResponse } from "./completion-protocol.js";
export const RECOVERY_LIMITS = Object.freeze({
  admissions: 1000,
  admissionBytes: 4096,
  terminalBytes: 262144,
  retainedBytes: 16777216,
});
export const recoveryRequestId = z.string().regex(/^fbr1_[a-f0-9]{32}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const admissionPrefix = "completion-admission-v1:";
const terminalPrefix = "completion-terminal-v1:";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const completionAdmissionSchema = z.strictObject({
  version: z.literal(1),
  request_id: recoveryRequestId,
  principal_id: z.string().min(1).max(64),
  job_id: z.uuid(),
  model: z.string().regex(/^bridge\/[a-zA-Z0-9_-]{1,64}$/),
  fingerprint: sha,
  fingerprint_algorithm: z.literal("sha256-json-stringify-prepared-v1"),
  wire_sha256: sha,
  wire_bytes: z.number().int().min(1).max(9000000),
  image_revision: sha.nullable(),
  created_at: z.iso.datetime(),
  digest: sha,
});
export const completionTerminalSchema = z.strictObject({
  version: z.literal(1),
  job_id: z.uuid(),
  admission_digest: sha,
  attempt_id: z.uuid().nullable(),
  status: z.enum([
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
    "timed_out",
  ]),
  recorded_at: z.iso.datetime(),
  result_json: z.string().max(262144).optional(),
  result_sha256: sha.optional(),
  result_bytes: z.number().int().nonnegative().optional(),
  reason: z.enum(["result_too_large", "invalid_completion"]).optional(),
  digest: sha,
});
export const completionRecoverySchema = z.strictObject({
  version: z.literal(1),
  admission: completionAdmissionSchema,
  state: z.enum(["pending", "paused", "terminal", "result_unavailable"]),
  terminal: completionTerminalSchema.nullable(),
  current_job_status: z.enum([
    "queued",
    "running",
    "cancel_requested",
    "pause_requested",
    "paused",
    "succeeded",
    "failed",
    "canceled",
    "interrupted",
    "timed_out",
  ]),
  prepared_at: z.iso.datetime(),
  observations: z
    .strictObject({
      reason: z.string().max(1000).nullable(),
      retry_at: z.number().finite().nullable(),
    })
    .nullable(),
});
export type CompletionAdmission = z.infer<typeof completionAdmissionSchema>;
export type CompletionTerminal = z.infer<typeof completionTerminalSchema>;
const corrupt = () =>
  new BridgeError(
    "completion_receipt_invalid",
    "Retained completion receipt is unavailable or invalid",
    409,
  );
function seal<T extends object>(value: T) {
  return { ...value, digest: digest(JSON.stringify(value)) };
}
function decode<T>(value: string, schema: z.ZodType<T>, limit: number): T {
  if (Buffer.byteLength(value) > limit) throw corrupt();
  try {
    const raw = JSON.parse(value),
      parsed = schema.parse(raw);
    const { digest: actual, ...data } = raw;
    if (actual !== digest(JSON.stringify(data))) throw corrupt();
    return parsed;
  } catch {
    throw corrupt();
  }
}
export class CompletionRecovery {
  constructor(private db: DatabaseSync) {}
  private row(key: string, limit: number): string | undefined {
    const size = this.db
      .prepare("SELECT length(CAST(value AS BLOB)) n FROM metadata WHERE key=?")
      .get(key) as { n: number } | undefined;
    if (!size) return;
    if (size.n > limit) throw corrupt();
    return (
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as {
        value: string;
      }
    ).value;
  }
  private admission(jobId: string): CompletionAdmission | undefined {
    const value = this.row(
      admissionPrefix + jobId,
      RECOVERY_LIMITS.admissionBytes,
    );
    if (value === undefined) return;
    const data = decode(
      value,
      completionAdmissionSchema,
      RECOVERY_LIMITS.admissionBytes,
    );
    if (data.job_id !== jobId) throw corrupt();
    return data;
  }
  has(jobId: string): boolean {
    return this.admission(jobId) !== undefined;
  }
  terminal(jobId: string): CompletionTerminal | undefined {
    const value = this.row(
      terminalPrefix + jobId,
      RECOVERY_LIMITS.terminalBytes,
    );
    if (value === undefined) return;
    const data = decode(
      value,
      completionTerminalSchema,
      RECOVERY_LIMITS.terminalBytes,
    );
    const admission = this.admission(jobId);
    if (
      !admission ||
      data.job_id !== jobId ||
      data.admission_digest !== admission.digest
    )
      throw corrupt();
    if (data.status === "succeeded" && !data.reason) {
      if (
        data.result_json === undefined ||
        digest(data.result_json) !== data.result_sha256 ||
        Buffer.byteLength(data.result_json) !== data.result_bytes
      )
        throw corrupt();
    } else if (
      data.result_json !== undefined ||
      (data.status !== "succeeded" &&
        (data.reason !== undefined ||
          data.result_sha256 !== undefined ||
          data.result_bytes !== undefined))
    )
      throw corrupt();
    return data;
  }
  /** Caller keeps the existing idempotent admission transaction open through this insert. */
  admit(
    job: Job,
    p: Principal,
    key: string,
    wire: { sha256: string; bytes: number },
    imageRevision: string | undefined,
    created: boolean,
  ): CompletionAdmission {
    if (!this.db.isTransaction)
      throw new BridgeError(
        "completion_transaction_required",
        "Recovery admission requires the native transaction",
        409,
      );
    recoveryRequestId.parse(key);
    const row = this.db
      .prepare(
        "SELECT fingerprint,resource_id FROM idempotency WHERE principal_id=? AND route='chat/completions' AND key=?",
      )
      .get(p.id, key) as
      { fingerprint: string; resource_id: string } | undefined;
    if (
      !row ||
      row.resource_id !== job.id ||
      job.principalId !== p.id ||
      !job.completion
    )
      throw corrupt();
    const retained = this.admission(job.id);
    if (retained) {
      if (
        retained.request_id !== key ||
        retained.principal_id !== p.id ||
        retained.fingerprint !== row.fingerprint ||
        retained.model !== job.completion.model ||
        retained.image_revision !== (imageRevision ?? null)
      )
        throw corrupt();
      return retained;
    }
    if (!created)
      throw new BridgeError(
        "completion_recovery_unsupported",
        "Original request has no retained recovery admission; do not resubmit",
        409,
      );
    const counts = this.db
      .prepare(
        `SELECT count(*) n, COALESCE(sum(COALESCE(length(CAST(t.value AS BLOB)),?)),0) bytes FROM metadata a LEFT JOIN metadata t ON t.key=?||substr(a.key,?) WHERE a.key GLOB ? AND json_extract(a.value,'$.principal_id')=?`,
      )
      .get(
        RECOVERY_LIMITS.terminalBytes,
        terminalPrefix,
        admissionPrefix.length + 1,
        admissionPrefix + "*",
        p.id,
      ) as { n: number; bytes: number };
    if (
      counts.n >= RECOVERY_LIMITS.admissions ||
      counts.bytes + RECOVERY_LIMITS.terminalBytes >
        RECOVERY_LIMITS.retainedBytes
    )
      throw new BridgeError(
        "completion_recovery_full",
        "Completion recovery retention capacity reached; no job was admitted",
        429,
      );
    const value = seal({
      version: 1 as const,
      request_id: key,
      principal_id: p.id,
      job_id: job.id,
      model: job.completion.model,
      fingerprint: row.fingerprint,
      fingerprint_algorithm: "sha256-json-stringify-prepared-v1" as const,
      wire_sha256: wire.sha256,
      wire_bytes: wire.bytes,
      image_revision: imageRevision ?? null,
      created_at: new Date().toISOString(),
    });
    completionAdmissionSchema.parse(value);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > RECOVERY_LIMITS.admissionBytes)
      throw corrupt();
    this.db
      .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
      .run(admissionPrefix + job.id, encoded);
    return value;
  }
  /** All terminal paths call this before saving, within their native transaction. */
  finish(job: Job, attemptId: string | null): void {
    if (!terminal.has(job.status)) return;
    const admission = this.admission(job.id);
    if (!admission || this.terminal(job.id)) return;
    if (!this.db.isTransaction)
      throw new BridgeError(
        "completion_transaction_required",
        "Terminal retention requires the native transaction",
        409,
      );
    let result: Partial<CompletionTerminal> = {};
    if (job.status === "succeeded") {
      try {
        const json = JSON.stringify(completionResponse(job, job.completion!));
        result = {
          result_json: json,
          result_sha256: digest(json),
          result_bytes: Buffer.byteLength(json),
        };
        if (
          Buffer.byteLength(JSON.stringify(result)) + 1024 >
          RECOVERY_LIMITS.terminalBytes
        )
          result = {
            result_sha256: result.result_sha256,
            result_bytes: result.result_bytes,
            reason: "result_too_large",
          };
      } catch (error) {
        if (
          !(error instanceof BridgeError) ||
          error.code !== "invalid_completion"
        )
          throw error;
        result = { reason: "invalid_completion" };
      }
    }
    const value = seal({
      version: 1 as const,
      job_id: job.id,
      admission_digest: admission.digest,
      attempt_id: attemptId,
      status: job.status,
      recorded_at: new Date().toISOString(),
      ...result,
    });
    completionTerminalSchema.parse(value);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > RECOVERY_LIMITS.terminalBytes)
      throw corrupt();
    this.db
      .prepare("INSERT INTO metadata(key,value) VALUES(?,?)")
      .run(terminalPrefix + job.id, encoded);
  }
  read(p: Principal, key: string, load: (id: string) => Job) {
    recoveryRequestId.parse(key);
    const row = this.db
      .prepare(
        "SELECT fingerprint,resource_id FROM idempotency WHERE principal_id=? AND route='chat/completions' AND key=?",
      )
      .get(p.id, key) as
      { fingerprint: string; resource_id: string } | undefined;
    if (!row)
      throw new BridgeError("not_found", "Completion request not found", 404);
    const job = load(row.resource_id);
    if (!p.owner && !p.profiles.includes(job.profile))
      throw new BridgeError("profile_forbidden", "Profile is unavailable", 403);
    const admission = this.admission(job.id);
    if (!admission)
      throw new BridgeError(
        "completion_recovery_unsupported",
        "Original request has no retained recovery admission; do not resubmit",
        409,
      );
    if (
      admission.request_id !== key ||
      admission.principal_id !== p.id ||
      admission.job_id !== row.resource_id ||
      admission.fingerprint !== row.fingerprint ||
      admission.model !== "bridge/" + job.profile ||
      job.principalId !== p.id
    )
      throw corrupt();
    const retained = this.terminal(job.id);
    if (!retained && terminal.has(job.status)) throw corrupt();
    const snapshot = {
      version: 1 as const,
      admission,
      state: retained
        ? retained.reason
          ? "result_unavailable"
          : "terminal"
        : ["paused", "pause_requested"].includes(job.status)
          ? "paused"
          : "pending",
      terminal: retained ?? null,
      current_job_status: job.status,
      prepared_at: new Date().toISOString(),
      observations: retained
        ? null
        : {
            reason: job.error?.slice(0, 1000) ?? null,
            retry_at: job.retryAt ?? null,
          },
    };
    const parsed = completionRecoverySchema.safeParse(snapshot);
    if (!parsed.success) throw corrupt();
    return parsed.data;
  }
}
