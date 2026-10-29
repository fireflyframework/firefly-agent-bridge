/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { z } from "zod";
export const optionalTimeoutSchema = z
  .number()
  .int()
  .positive()
  .safe()
  .nullable();
export const workDurationSchema = z.strictObject({
  version: z.literal(1),
  timeoutMs: optionalTimeoutSchema,
});
export type WorkDuration = z.infer<typeof workDurationSchema>;
export const workDurationCapability = {
  version: 1,
  protocol: "firefly-bridge-work-duration-v1",
  nullableTimeout: true,
  frozenAtAdmission: true,
} as const;
export function chooseWorkDuration(
  profile?: WorkDuration,
  request?: WorkDuration,
): WorkDuration | undefined {
  if (profile === undefined && request === undefined) return undefined;
  const explicit = [profile, request].flatMap((value) => {
    const timeout = value ? workDurationSchema.parse(value).timeoutMs : null;
    return timeout === null ? [] : [timeout];
  });
  return {
    version: 1,
    timeoutMs: explicit.length ? Math.min(...explicit) : null,
  };
}
export function absoluteWorkDeadline(job: {
  createdAt: string;
  workDuration?: WorkDuration;
}): number | null | undefined {
  if (job.workDuration === undefined) return undefined;
  const timeout = workDurationSchema.parse(job.workDuration).timeoutMs;
  if (timeout === null) return null;
  const deadline = Date.parse(job.createdAt) + timeout;
  if (!Number.isSafeInteger(deadline))
    throw new Error("Work deadline exceeds the timestamp representation");
  return deadline;
}
export function monotonicWorkDeadline(job: {
  createdAt: string;
  workDuration?: WorkDuration;
}): number | null | undefined {
  const anchored = performance.now();
  const deadline = absoluteWorkDeadline(job);
  return deadline == null ? deadline : anchored + deadline - Date.now();
}
/** Node clamps oversized delays to one millisecond; retain the absolute monotonic deadline. */
export function armDeadline(
  deadline: number | null,
  expired: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let canceled = false;
  const arm = () => {
    if (canceled || deadline === null) return;
    const remaining = deadline - performance.now();
    if (remaining <= 0) expired();
    else timer = setTimeout(arm, Math.min(remaining, 2147483647));
  };
  arm();
  return () => {
    canceled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
