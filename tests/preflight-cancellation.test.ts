/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
import { expect, it } from "vitest";
import { ClaudeWorker } from "../src/claude.js";
import { CodexWorker } from "../src/codex.js";
import type { Execution, WorkerEvent } from "../src/worker.js";
import type { Outcome } from "../src/contracts.js";

const options = {
  path: process.execPath,
  timeoutMs: 1000,
  maxOutputBytes: 20000,
  tools: [],
};
const providers = [
  { provider: "Claude", create: () => new ClaudeWorker(options) },
  { provider: "Codex", create: () => new CodexWorker(options) },
];
const scenarios = [
  {
    name: "cancels while readiness subsequently fails",
    ready: false,
    cancel: true,
    expected: { status: "canceled" },
  },
  {
    name: "cancels while readiness subsequently succeeds",
    ready: true,
    cancel: true,
    expected: { status: "canceled" },
  },
  {
    name: "preserves readiness failure without cancellation",
    ready: false,
    cancel: false,
    expected: { status: "failed", error: "fixture readiness unavailable" },
  },
] satisfies {
  name: string;
  ready: boolean;
  cancel: boolean;
  expected: Outcome;
}[];

it.each(
  providers.flatMap((provider) =>
    scenarios.map((scenario) => ({ ...provider, ...scenario })),
  ),
)("$provider $name without starting coding work", async (scenario) => {
  let resolveReadiness!: (value: { ready: boolean; reason?: string }) => void;
  const readiness = new Promise<{ ready: boolean; reason?: string }>(
    (resolve) => {
      resolveReadiness = resolve;
    },
  );
  const worker = scenario.create();
  worker.ready = () => readiness;
  const controller = new AbortController();
  const events: WorkerEvent[] = [];
  const execution: Execution = {
    get cwd(): string {
      throw new Error("Preflight must not enter the coding workspace or spawn");
    },
    job: {
      id: "job",
      principalId: "owner",
      profile: "default",
      mode: "cli",
      status: "running",
      prompt: "fixture",
      createdAt: "now",
      updatedAt: "now",
      messages: [
        { id: "message", role: "user", text: "fixture", createdAt: "now" },
      ],
    },
    attempt: {
      id: "attempt",
      jobId: "job",
      owner: "test",
      fence: "fence",
      status: "running",
      createdAt: "now",
      updatedAt: "now",
    },
  };
  const run = worker.run(
    execution,
    (event) => events.push(event),
    controller.signal,
  );
  if (scenario.cancel) controller.abort();
  resolveReadiness({
    ready: scenario.ready,
    reason: "fixture readiness unavailable",
  });
  expect(await run).toEqual(scenario.expected);
  expect(events).toEqual([]);
});
