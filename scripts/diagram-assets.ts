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

import { readFileSync, writeFileSync } from "node:fs";
const font = readFileSync(
  "assets/fonts/manrope/manrope-latin-wght-normal.woff2",
).toString("base64");
const notice = readFileSync("assets/diagrams/lifecycle.svg", "utf8").split(
  "<svg",
)[0];
type Card = [string, ...string[]];
const diagrams: Record<
  string,
  { title: string; description: string; cards: Card[]; foot: string }
> = {
  architecture: {
    title: "Local execution, shared state",
    description:
      "Your application calls the bridge. The selected official CLI performs model work.",
    cards: [
      [
        "Your application",
        "OpenAI SDK, FireflyAgent or MCP",
        "Bearer token and selected profile",
        "Caller executes its own functions",
      ],
      [
        "Firefly Agent Bridge",
        "Validate and durably admit work",
        "SQLite jobs, attempts and audit",
        "Schedule one owned execution",
      ],
      [
        "Official coding agent",
        "Codex or Claude Code CLI",
        "Existing subscription login",
        "Native session and model access",
      ],
      [
        "Inference",
        "Native actions disabled",
        "Validated text or function calls",
        "Full history supplied by caller",
      ],
      [
        "Agent jobs",
        "Configured permission policy",
        "Native tools in a job directory",
        "Timeout and output bounds",
      ],
      [
        "Host conversation",
        "Explicit MCP claim and receipt",
        "Host reports progress and result",
        "Lease loss interrupts ownership",
      ],
    ],
    foot: "One local service owns the database, dispatch controls, workflow checkpoints and replayable events.",
  },
  "openai-compatible": {
    title: "Application function ownership",
    description:
      "A function call is a request to the application that declared it.",
    cards: [
      [
        "1. Submit a model turn",
        "POST /v1/chat/completions",
        "Messages and function schemas",
        "Scoped token; bridge/default",
      ],
      [
        "2. Generate and validate",
        "Selected CLI runs inference",
        "Native tool actions disabled",
        "Validate function name and args",
      ],
      [
        "3. Execute in the caller",
        "OpenAI tool_calls response",
        "Caller runs its declared function",
        "Send result with complete history",
      ],
      [
        "Structured answers",
        "Validate requested JSON Schema",
        "Release only a valid envelope",
        "Typed SDK output supported",
      ],
      [
        "Buffered streaming",
        "Keepalives during execution",
        "Validated final chunks and usage",
        "End with data: [DONE]",
      ],
      [
        "Native work",
        "Explicit execution: agent",
        "Uses native profile permissions",
        "Background job receipt: HTTP 202",
      ],
    ],
    foot: "The bridge never executes application function code. Each inference turn is a separate durable job.",
  },
  communication: {
    title: "Requests, results and event replay",
    description:
      "Completion responses and orchestration events have separate wire contracts.",
    cards: [
      [
        "Admit",
        "Authenticate caller and profile",
        "Commit job, request key and event",
        "Claim a fenced attempt",
      ],
      [
        "Execute",
        "Start or resume official CLI",
        "Persist emitted observations",
        "Validate final result",
      ],
      [
        "Return",
        "Completion JSON or buffered SSE",
        "Stable function and response IDs",
        "Observed provider usage only",
      ],
      [
        "Background work",
        "background: true returns HTTP 202",
        "No waiting socket required",
        "Inspect durable job/result routes",
      ],
      [
        "Job notifications",
        "GET /v1/bridge/events",
        "Replay with Last-Event-ID",
        "Refresh on expired cursor",
      ],
      [
        "Control",
        "Pause, resume, cancel or retry",
        "Requests share the same queue",
        "External effects need review",
      ],
    ],
    foot: "Preserve the exact request body and Idempotency-Key when reattaching after an uncertain response.",
  },
  lifecycle: {
    title: "Job state and native continuation",
    description:
      "A durable job can have several fenced attempts and one resumable native session.",
    cards: [
      [
        "Queued",
        "Admitted to local state",
        "No attempt is running yet",
        "Await dispatch or host claim",
      ],
      [
        "Running",
        "Exclusive attempt owns execution",
        "Native session identity retained",
        "Progress and tools persisted",
      ],
      [
        "Succeeded",
        "Validated terminal result saved",
        "Follow-up can continue session",
        "Next workflow step may start",
      ],
      [
        "Paused",
        "Operator or quota gate",
        "Active work reconciled",
        "Resume when eligible",
      ],
      [
        "Failed or interrupted",
        "Inspect audit and external effects",
        "Explicit retry starts new session",
        "No automatic crash replay",
      ],
      [
        "Native context",
        "CLI owns compaction and history",
        "Bridge records session boundary",
        "Lost session errors stay explicit",
      ],
    ],
    foot: "A reported future quota reset permits bounded continuation. Unknown reset times require operator action.",
  },
  workflows: {
    title: "Sequential workflow checkpoints",
    description:
      "Each run saves its template and inputs. Every step becomes a durable job.",
    cards: [
      [
        "Snapshot",
        "Validate inputs and profiles",
        "Save ordered step definitions",
        "Existing runs keep their snapshot",
      ],
      [
        "Run current step",
        "Substitute inputs and earlier result",
        "Start one configured job",
        "Inspect progress and outcome",
      ],
      [
        "Advance on success",
        "Only a successful step advances",
        "Preserve completed stages",
        "Final result completes the run",
      ],
      [
        "Pause or cancel",
        "Pause blocks the next step",
        "Request stop of current execution",
        "No rollback of external effects",
      ],
      [
        "Recover",
        "Review a failed current step",
        "Explicit retry may repeat actions",
        "Template edits affect future runs",
      ],
      [
        "Claude native agents",
        "Delegation belongs to parent job",
        "Profile-defined tools and agents",
        "Codex definitions differ",
      ],
    ],
    foot: "Workflows are sequential. Conditional graphs and independent agent teams are outside this scheduler.",
  },
  "advanced-workflow": {
    title: "A development workflow",
    description:
      "Plan, implement, review, repair and verify are separate saved stages.",
    cards: [
      [
        "Plan and implement",
        "Inspect the chosen project",
        "Apply the requested change",
        "Run the relevant checks",
      ],
      [
        "Review and repair",
        "Review concrete source changes",
        "Investigate reported defects",
        "Preserve unrelated work",
      ],
      [
        "Verify",
        "Run documented project checks",
        "Inspect final diff and evidence",
        "Report observed results",
      ],
      [
        "Execution profile",
        "Claude Agent definitions optional",
        "Official subscription login",
        "Owner permission policy applies",
      ],
      [
        "Shared project",
        "Use one explicit absolute path",
        "Dedicated checkout for isolation",
        "Job cwd differs at each stage",
      ],
      [
        "Durable control",
        "Snapshot template and inputs",
        "Pause current and future work",
        "Resume preserves completed steps",
      ],
    ],
    foot: "A model's successful prose is not independent verification. Inspect the produced change and check results.",
  },
  subagents: {
    title: "Claude agents and their parent job",
    description:
      "Named native agents run inside one owned Claude Code execution.",
    cards: [
      [
        "Bridge profile",
        "Enable Agent in parent tools",
        "Define planner or reviewer",
        "Set reported child-task limit",
      ],
      [
        "Claude parent",
        "Delegate explicitly to Agent",
        "Receive specialist findings",
        "Own native conversation context",
      ],
      [
        "Specialist",
        "Use configured tool subset",
        "Return findings to parent",
        "Emit native task observations",
      ],
      [
        "Launch",
        "Console: configured profile",
        "MCP bridge_submit, mode cli",
        "API bridge.execution: agent",
      ],
      [
        "Inspect",
        "Job Child tasks and Activity",
        "Reported task IDs and status",
        "No invented delegation result",
      ],
      [
        "Stop",
        "Pause or cancel parent job",
        "Stop its owned process tree",
        "No separate child pause endpoint",
      ],
    ],
    foot: "Claude agent definitions do not configure Codex. Durable bridge workflows can use either provider.",
  },
  tokens: {
    title: "Bridge access and provider login",
    description:
      "The provider login stays with its official CLI. Bridge tokens authorize local operations.",
    cards: [
      [
        "Start the service",
        "Initialize owner configuration",
        "Listener creates owner.token",
        "Provider credentials stay private",
      ],
      [
        "Owner console",
        "Paste token from local file",
        "Inspect every job and profile",
        "Administer dispatch and clients",
      ],
      [
        "Application token",
        "Assign principal, profiles, scopes",
        "Return credential once",
        "Store it in caller configuration",
      ],
      [
        "Authenticate",
        "Authorization: Bearer ffb_…",
        "REST, events and remote MCP",
        "No query-string tokens",
      ],
      [
        "Restrict",
        "Client can read its own jobs",
        "read, submit, control, workflows",
        "Owner-only admin stays protected",
      ],
      [
        "Revoke",
        "Invalidate principal tokens",
        "Close active event connections",
        "Background jobs remain admitted",
      ],
    ],
    foot: "Console authentication stays in tab memory. Only the appearance preference persists in browser storage.",
  },
  "execution-audit": {
    title: "Observed tools and durable audit",
    description:
      "The bridge retains emitted payloads and marks missing outcomes explicitly.",
    cards: [
      [
        "Official CLI",
        "Emit native tool requests/results",
        "Reported commands, file targets",
        "Session and parent identifiers",
      ],
      [
        "SQLite transaction",
        "Job, fenced attempt and tool ID",
        "Immutable observation payloads",
        "Current tool/file projection",
      ],
      [
        "Console and API",
        "Activity and Files inspectors",
        "Load full payloads on demand",
        "Export fixed-cursor snapshots",
      ],
      [
        "Caller functions",
        "Validated generated requests",
        "Client-supplied result reports",
        "Execution remains caller-owned",
      ],
      [
        "Coverage limits",
        "No inferred shell file changes",
        "Missing result: outcome unknown",
        "Host internal tools unavailable",
      ],
      [
        "Data protection",
        "Payloads can contain private data",
        "Same job read authorization",
        "Local record is not tamper-proof",
      ],
    ],
    foot: "Event retention does not delete the audit. Monitor disk usage and protect exports like the workspace.",
  },
};
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
for (const [name, diagram] of Object.entries(diagrams))
  for (const dark of [false, true]) {
    const c = dark
      ? {
          bg: "#10110f",
          surface: "#1a1b17",
          ink: "#f3f1eb",
          muted: "#bfb8ab",
          line: "#474a42",
          accent: "#ffb34a",
        }
      : {
          bg: "#f3f1eb",
          surface: "#ffffff",
          ink: "#272820",
          muted: "#62645b",
          line: "#d8d4ca",
          accent: "#855414",
        };
    const text = (
      x: number,
      y: number,
      value: string,
      size = 18,
      fill = c.ink,
      weight = 450,
    ) =>
      `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}">${escape(value)}</text>`;
    const cards = diagram.cards
      .map((card, i) => {
        const x = 40 + (i % 3) * 416,
          y = 196 + Math.floor(i / 3) * 220;
        return (
          `<rect x="${x}" y="${y}" width="384" height="192" rx="12" fill="${c.surface}" stroke="${c.line}"/><rect x="${x + 24}" y="${y + 25}" width="4" height="24" rx="2" fill="#ffb34a"/>` +
          text(x + 42, y + 44, card[0], 22, c.ink, 650) +
          card
            .slice(1)
            .map((line, j) => text(x + 24, y + 90 + j * 32, line, 17, c.muted))
            .join("")
        );
      })
      .join("");
    const svg =
      notice +
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="700" viewBox="0 0 1280 700" role="img" aria-labelledby="title desc"><title id="title">${escape(diagram.title)}</title><desc id="desc">${escape(diagram.description + " " + diagram.foot)}</desc><style>@font-face{font-family:Manrope;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:200 800}text{font-family:Manrope,Arial,sans-serif}</style><rect width="1280" height="700" fill="${c.bg}"/>${text(40, 46, "FIREFLY AGENT BRIDGE / " + name.replaceAll("-", " ").toUpperCase(), 12, c.accent, 750)}${text(40, 105, diagram.title, 36, c.ink, 500)}${text(40, 146, diagram.description, 18, c.muted)}${cards}<path d="M40 646H1240" stroke="${c.line}"/>${text(40, 676, diagram.foot, 14, c.muted)}</svg>`;
    writeFileSync(
      "assets/diagrams/" + name + (dark ? "-dark" : "") + ".svg",
      svg,
    );
  }
console.log(
  "Generated nine theme-aware Bridge diagrams from maintained execution contracts.",
);
