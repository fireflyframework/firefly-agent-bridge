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

import type { ClusterHandoff, Job, Message } from "./contracts.js";

export const HANDOFF_MAX_BRIEF_CHARS = 4_000;
export const HANDOFF_MAX_RECENT_TURNS = 6;
export const HANDOFF_MAX_RECENT_CHARS = 8_000;

export type BuildClusterHandoffInput = {
  reason: ClusterHandoff["reason"];
  fromNodeId: string;
  job: Pick<Job, "prompt" | "messages" | "result" | "activity" | "error">;
  now?: () => string;
};

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

function recentTurns(messages: Message[]): Message[] {
  const selected: Message[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (selected.length >= HANDOFF_MAX_RECENT_TURNS) break;
    if (chars + message.text.length > HANDOFF_MAX_RECENT_CHARS) break;
    selected.unshift(message);
    chars += message.text.length;
  }
  return selected;
}

/**
 * Build a bounded handoff packet from coordinator-durable job memory.
 * Full message history remains on the job; this brief is the incremental injection.
 */
export function buildClusterHandoff(
  input: BuildClusterHandoffInput,
): ClusterHandoff {
  const { job, reason, fromNodeId } = input;
  const lastAssistant = [...job.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const lastUser = [...job.messages].reverse().find((m) => m.role === "user");
  const lastState =
    job.result?.trim() ||
    lastAssistant?.text.trim() ||
    job.error?.trim() ||
    job.activity ||
    "unknown";
  const goal =
    (lastUser?.text || job.prompt || "").trim() || "continue prior work";
  const brief = clip(
    [
      "Cluster failover continuation (new native CLI session on another node).",
      `Goal / last user intent: ${goal}`,
      `Last state: ${lastState}`,
      job.activity ? `Activity: ${job.activity}` : null,
      "Continue from this state. Prefer the brief; full history remains on the bridge job record.",
    ]
      .filter(Boolean)
      .join("\n"),
    HANDOFF_MAX_BRIEF_CHARS,
  );
  const turns = recentTurns(job.messages);
  return {
    reason,
    fromNodeId,
    brief,
    recentTurns: turns.map(({ role, text }) => ({
      role,
      text: clip(text, 2_000),
    })),
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

/** Prompt text for a worker starting after failover (no --resume). */
export function clusterHandoffPromptText(handoff: ClusterHandoff): string {
  const recent =
    handoff.recentTurns.length === 0
      ? ""
      : "\n\nRecent turns:\n" +
        handoff.recentTurns
          .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
          .join("\n\n");
  return handoff.brief + recent;
}

/**
 * Build the CLI prompt for a job. After cluster failover there is no native
 * sessionId — inject the handoff brief instead of --resume.
 */
export function workerRunPrompt(
  job: Pick<
    Job,
    | "prompt"
    | "messages"
    | "sessionId"
    | "resumePending"
    | "resumedTurns"
    | "clusterHandoff"
    | "completion"
  >,
  options: {
    continuationPrompt: string;
    conversationHeading: string;
    /** Codex completions prepend a system prompt on fresh sessions. */
    completionPrefix?: string;
    /**
     * Claude reconstructs multi-turn history when there is no native session;
     * Codex keeps using `job.prompt` for fresh non-handoff runs.
     */
    freshMultiTurn?: "conversation" | "prompt";
  },
): string {
  if (job.sessionId) {
    if (job.resumePending) return options.continuationPrompt;
    return job.messages
      .filter((m) => m.role === "user")
      .slice(job.resumedTurns ?? 1)
      .map((m) => m.text)
      .join("\n\n");
  }
  if (job.clusterHandoff) {
    const handoffText = clusterHandoffPromptText(job.clusterHandoff);
    const latestUser = [...job.messages]
      .reverse()
      .find((m) => m.role === "user");
    const followUp = latestUser?.text?.trim();
    return followUp && !handoffText.includes(followUp)
      ? `${handoffText}\n\nContinue with this user request:\n${followUp}`
      : handoffText;
  }
  if (job.completion || options.freshMultiTurn === "prompt")
    return (options.completionPrefix ?? "") + job.prompt;
  if (job.messages.length === 1) return job.prompt;
  return (
    options.conversationHeading +
    JSON.stringify(job.messages.map(({ role, text }) => ({ role, text })))
  );
}
