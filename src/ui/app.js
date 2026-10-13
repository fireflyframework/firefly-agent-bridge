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

import { createAuditPanel } from "./audit.js";
import { createProviderSetup } from "./setup.js";
import { createMobileNavigation } from "./navigation.js";
import { createJobWizard } from "./job-wizard.js";
import { createImageInput } from "./image-input.js";

/* All rendered task content uses textContent: prompts and Claude output are untrusted data. */
const el = (id) => document.getElementById(id);
let selectedWorker = "Codex",
  connected = false,
  sessionEpoch = 0,
  runtimeStatus,
  modelCards = [],
  access = { owner: false, scopes: [] };
const viewLabels = {
  jobs: "Jobs",
  workflows: "Workflows",
  providers: "Providers & setup",
  diagnostics: "Diagnostics",
};
let workflowInputSignature = "";
function workflowValues() {
  const fields = [...el("workflow-fields").querySelectorAll("textarea")];
  if (!el("workflow-json-mode").checked)
    return Object.fromEntries(fields.map((field) => [field.name, field.value]));
  const values = JSON.parse(el("workflow-inputs").value);
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.entries(values).some(
      ([name, value]) =>
        typeof value !== "string" ||
        !fields.some((field) => field.name === name),
    )
  )
    throw new Error(
      "Use a JSON object with text values for this template's named inputs.",
    );
  return values;
}
function renderWorkflowInputs(template) {
  const signature = JSON.stringify([template?.id, template?.inputs]);
  if (signature === workflowInputSignature) return;
  workflowInputSignature = signature;
  el("workflow-json-mode").checked = false;
  el("workflow-json-values").hidden = true;
  el("workflow-fields").hidden = false;
  el("workflow-fields").replaceChildren();
  for (const name of template?.inputs ?? []) {
    const label = document.createElement("label"),
      field = document.createElement("textarea");
    label.textContent = name
      .replaceAll("_", " ")
      .replace(/^./, (value) => value.toUpperCase());
    field.name = name;
    field.required = true;
    field.rows = 3;
    field.maxLength = 100000;
    label.append(field);
    el("workflow-fields").append(label);
  }
  if (template && !template.inputs.length)
    text("workflow-fields", "No input values needed.");
}
const hashView = () =>
  Object.hasOwn(viewLabels, location.hash.slice(1))
    ? location.hash.slice(1)
    : "jobs";
let currentView = hashView(),
  jobRequestId = crypto.randomUUID(),
  lastJobPayload = "",
  workflowRequestId = crypto.randomUUID(),
  lastWorkflowPayload = "";
const can = (scope) => access.owner || access.scopes.includes(scope);
let token = "",
  selected = "",
  jobs = [],
  cursor = null,
  eventCursor = 0,
  controller,
  refreshing = false;
let templates = [],
  loadedPages = 1,
  selectionRevision = 0,
  attemptsSnapshot;
const hostId = crypto.randomUUID(),
  seenEvents = new Set();
const text = (id, value) => {
  el(id).textContent = String(value ?? "");
};
const human = (value) =>
  ({
    operator_pause: "Paused by the operator. Resume when you are ready.",
    "job.paused": "A job is paused and ready for review.",
    "job.compaction":
      "The coding agent compacted a conversation. Its session is preserved.",
  })[value] ?? value;
const notice = (message) => {
  text("notice", human(message));
  el("notice").hidden = !message;
};
const badge = (status) => {
  const node = document.createElement("span");
  node.className = "pill " + status;
  node.textContent = status.replaceAll("_", " ");
  return node;
};
const action = (label, fn) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.type = "button";
  b.onclick = () =>
    Promise.resolve()
      .then(fn)
      .catch((e) => notice(e.message));
  return b;
};
async function api(
  path,
  body,
  method = body === undefined ? "GET" : "POST",
  requestKey,
) {
  const issuedEpoch = sessionEpoch;
  const response = await fetch(
    (["/chat/completions", "/models"].includes(path) ? "/v1" : "/v1/bridge") +
      path,
    {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const data = await response.json();
  if (issuedEpoch !== sessionEpoch)
    throw new DOMException(
      "The session changed; its response was discarded.",
      "AbortError",
    );
  if (!response.ok) {
    if (response.status === 401 && connected)
      lockSession("Session expired. Connect with a valid token to continue.");
    throw new Error(data.error?.message ?? "Request failed");
  }
  return data;
}
function renderJobs() {
  el("jobs").replaceChildren();
  el("empty").hidden = jobs.length > 0;
  text("job-count", jobs.length);
  el("job-count").hidden = !connected;
  el("more").hidden = !cursor;
  for (const job of jobs) {
    const row = document.createElement("tr");
    if (job.id === selected) row.className = "active";
    const task = document.createElement("td");
    const prompt =
      job.completion?.messages.filter((m) => m.role === "user").at(-1)
        ?.content ?? job.prompt;
    task.append(
      action(
        (typeof prompt === "string" ? prompt : "Chat completion").slice(0, 110),
        () => selectJob(job.id),
      ),
    );
    const sub = document.createElement("small");
    sub.textContent =
      (job.completion
        ? "Chat completion"
        : job.mode === "cli"
          ? (job.worker ?? selectedWorker) + " agent"
          : "Host conversation") +
      " / " +
      job.profile;
    task.append(sub);
    const state = document.createElement("td");
    state.append(badge(job.status));
    const updated = document.createElement("td"),
      time = document.createElement("time");
    time.textContent = new Date(job.updatedAt).toLocaleTimeString();
    updated.append(time);
    row.append(task, state, updated);
    el("jobs").append(row);
  }
}
function completionText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "image_url"
            ? "Image attachment"
            : JSON.stringify(part),
      )
      .join("\n");
  return value == null ? "" : JSON.stringify(value, null, 2);
}
function completionResult(raw) {
  // Persisted inference results use a validated transport envelope; show the answer
  // and client-owned function requests instead of exposing that internal wrapper.
  try {
    const value = JSON.parse(raw);
    return [
      value.content ?? "",
      ...(value.tool_calls ?? []).map(
        (call) => "Client function: " + call.name + "\n" + call.arguments,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return raw;
  }
}
const auditPanel = createAuditPanel(api, notice);
async function selectJob(id, loadedJob, openDetail = true) {
  // Creation preselects the new row; the audit panel owns a separate identity.
  auditPanel.begin(id);
  if (selected !== id) {
    attemptsSnapshot = undefined;
    el("job-detail").hidden = true;
  }
  selected = id;
  const revision = ++selectionRevision;
  const job = loadedJob ?? (await api("/jobs/" + id));
  if (revision !== selectionRevision) return;
  el("selection-empty").hidden = true;
  el("job-detail").hidden = false;
  text("detail-state", job.status.replaceAll("_", " "));
  el("detail-state").className = "pill " + job.status;
  text(
    "job-meta",
    job.profile +
      " / " +
      (job.completion ? "inference" : job.mode) +
      " / " +
      (job.compactions ?? 0) +
      " compactions" +
      (job.usage ? " / " + job.usage.total_tokens + " tokens" : ""),
  );
  text("job-error", human(job.error ?? ""));
  el("job-error").hidden = !job.error;
  el("job-actions").replaceChildren();
  const imageJob = job.completion?.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
  el("image-job-recovery").hidden = !imageJob;
  const controls = !can("control")
    ? []
    : job.status === "paused"
      ? imageJob
        ? ["cancel"]
        : ["resume", "cancel"]
      : ["running", "queued"].includes(job.status)
        ? ["pause", "cancel"]
        : ["failed", "interrupted", "timed_out", "canceled"].includes(
              job.status,
            )
          ? imageJob
            ? []
            : ["retry"]
          : [];
  for (const command of controls)
    el("job-actions").append(
      action(command[0].toUpperCase() + command.slice(1), async () => {
        if (
          command === "retry" &&
          !window.confirm(
            "Retry starts a new session and may repeat prior side effects. Continue?",
          )
        )
          return;
        await api("/jobs/" + id + "/" + command, {});
        await refresh();
      }),
    );
  el("messages").replaceChildren();
  const messages = job.completion
    ? [
        ...job.completion.messages.map((m) => ({
          role: m.role,
          parts: m.content,
          functions: (m.tool_calls ?? []).map(
            (call) =>
              "Client function: " +
              call.function.name +
              "\n" +
              call.function.arguments,
          ),
          text: [
            completionText(m.content),
            ...(m.tool_calls ?? []).map(
              (call) =>
                "Client function: " +
                call.function.name +
                "\n" +
                call.function.arguments,
            ),
          ]
            .filter(Boolean)
            .join("\n\n"),
        })),
        ...(job.result
          ? [{ role: "assistant", text: completionResult(job.result) }]
          : []),
      ]
    : [...job.messages, ...(job.pendingMessages ?? [])];
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = "message " + message.role;
    const label = document.createElement("strong");
    label.textContent =
      message.role === "user"
        ? "You"
        : message.role === "assistant"
          ? (job.worker ?? selectedWorker)
          : message.role;
    const body = document.createElement("span");
    body.className = "message-content";
    if (message.parts && Array.isArray(message.parts)) {
      for (const [index, part] of message.parts.entries()) {
        if (
          part.type === "image_url" &&
          /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(
            part.image_url?.url ?? "",
          )
        ) {
          const image = document.createElement("img");
          image.src = part.image_url.url;
          image.alt = "Attached image " + (index + 1);
          image.className = "message-attachment";
          image.loading = "lazy";
          body.append(image);
        } else {
          const text = document.createElement("span");
          text.textContent =
            part.type === "text" ? part.text : "Unsupported attachment";
          body.append(text);
        }
      }
      for (const value of message.functions ?? []) {
        const functionText = document.createElement("span");
        functionText.textContent = value;
        body.append(functionText);
      }
    } else body.textContent = message.text;
    node.append(label, body);
    el("messages").append(node);
  }
  el("message-form").hidden =
    !can("submit") ||
    Boolean(job.workflowRunId || job.completion) ||
    ["paused", "pause_requested", "cancel_requested"].includes(job.status);
  el("subagents").replaceChildren();
  for (const [id, task] of Object.entries(job.subagents ?? {})) {
    const li = document.createElement("li");
    li.textContent = (task.description || id) + ": " + task.status;
    el("subagents").append(li);
  }
  if (!Object.keys(job.subagents ?? {}).length) {
    const li = document.createElement("li");
    li.textContent = "No child tasks reported.";
    el("subagents").append(li);
  }
  // The list already contains current job state. Reuse unchanged attempt history so polling
  // and navigation do not spend the principal's request budget fetching identical resources.
  const attemptKey = id + ":" + job.updatedAt + ":" + job.status;
  const attempts =
    attemptsSnapshot?.key === attemptKey
      ? attemptsSnapshot.value
      : await api("/jobs/" + id + "/attempts");
  if (revision !== selectionRevision) return;
  attemptsSnapshot = { key: attemptKey, value: attempts };
  text(
    "attempts",
    JSON.stringify(
      {
        model: "bridge/" + job.profile,
        execution: job.completion ? "inference" : job.mode,
        usage: job.usage ?? null,
        sessionId: job.sessionId ?? null,
        ...attempts,
      },
      null,
      2,
    ),
  );
  await auditPanel.select(job);
  renderJobs();
  if (openDetail && matchMedia("(max-width: 1100px)").matches) {
    document.body.dataset.jobDetail = "open";
    el("back-to-jobs").hidden = false;
    el("content").scrollTop = 0;
  }
}
async function renderWorkflows() {
  const { runs } = await api("/workflow-runs");
  el("workflow-runs").replaceChildren();
  if (!runs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      "No workflow runs yet. Create a template below, then start a run here.";
    el("workflow-runs").append(p);
  }
  for (const run of runs) {
    const node = document.createElement("article");
    node.className = "run";
    const title = document.createElement("h3");
    title.textContent = run.template.id;
    node.append(title, badge(run.status));
    const steps = document.createElement("p");
    steps.textContent =
      run.jobIds.length + " of " + run.template.steps.length + " steps created";
    node.append(steps);
    const controls = document.createElement("div");
    controls.className = "actions";
    const commands =
      run.status === "succeeded" || run.cancelRequested
        ? []
        : run.pauseRequested || run.status === "paused" || run.blocked
          ? ["resume", "cancel"]
          : ["pause", "cancel"];
    for (const cmd of commands)
      controls.append(
        action(cmd[0].toUpperCase() + cmd.slice(1), async () => {
          await api("/workflow-runs/" + run.id + "/" + cmd, {});
          await refresh();
        }),
      );
    for (const id of run.jobIds)
      controls.append(
        action("Open step " + (run.jobIds.indexOf(id) + 1), async () => {
          showView("jobs");
          await selectJob(id);
        }),
      );
    node.append(controls);
    el("workflow-runs").append(node);
  }
  await renderTemplates();
}
async function renderTemplates() {
  try {
    if (!access.owner) {
      el("new-template").hidden = true;
      el("templates-list").textContent =
        "Templates are managed by the bridge owner.";
      return;
    }
    templates = (await api("/admin/templates")).templates;
    el("templates-list").replaceChildren();
    el("new-template").hidden = false;
    if (!templates.length) {
      text(
        "templates-list",
        "Create a template to define a repeatable sequence of tasks.",
      );
      return;
    }
    for (const template of templates) {
      const node = document.createElement("article");
      node.className = "template-item";
      const title = document.createElement("h3");
      title.textContent = template.id;
      const purpose = document.createElement("p");
      purpose.textContent =
        template.description || template.steps.length + " ordered steps";
      const controls = document.createElement("div");
      controls.className = "actions";
      controls.append(
        action("Edit", () => openTemplate(template)),
        action("Delete", async () => {
          if (
            !window.confirm(
              "Delete this template? Existing runs keep their saved definition.",
            )
          )
            return;
          await api(
            "/admin/templates/" + encodeURIComponent(template.id),
            {},
            "DELETE",
          );
          await refresh();
        }),
      );
      node.append(title, purpose, controls);
      el("templates-list").append(node);
    }
  } catch (e) {
    el("new-template").hidden = true;
    text("templates-list", e.message);
  }
}
function addStep(
  step = {
    id: "step-" + (el("template-steps").children.length + 1),
    prompt: "",
    profile: "default",
  },
) {
  const card = document.createElement("section");
  card.className = "step-editor";
  const heading = document.createElement("div");
  heading.className = "step-editor-header";
  const title = document.createElement("strong");
  title.textContent = "Step " + (el("template-steps").children.length + 1);
  heading.append(
    title,
    action("Remove", () => card.remove()),
  );
  const row = document.createElement("div");
  row.className = "form-row";
  const idLabel = document.createElement("label");
  idLabel.textContent = "Step ID";
  const idInput = document.createElement("input");
  idInput.name = "step-id";
  idInput.required = true;
  idInput.pattern = "[a-zA-Z0-9_-]{1,64}";
  idInput.value = step.id;
  idLabel.append(idInput);
  const profileLabel = document.createElement("label");
  profileLabel.textContent = "Step profile";
  const profile = document.createElement("select");
  profile.name = "step-profile";
  for (const option of el("profile").options)
    profile.add(new Option(option.text, option.value));
  profile.value = step.profile;
  profileLabel.append(profile);
  row.append(idLabel, profileLabel);
  const promptLabel = document.createElement("label");
  promptLabel.textContent = "Step instructions";
  const prompt = document.createElement("textarea");
  prompt.name = "step-prompt";
  prompt.required = true;
  prompt.maxLength = 100000;
  prompt.value = step.prompt;
  promptLabel.append(prompt);
  card.append(heading, row, promptLabel);
  el("template-steps").append(card);
}
function openTemplate(template) {
  el("template-id").value = template?.id ?? "";
  el("template-id").readOnly = Boolean(template);
  el("template-description").value = template?.description ?? "";
  el("template-input-names").value = template?.inputs.join(", ") ?? "";
  el("template-steps").replaceChildren();
  for (const step of template?.steps ?? [
    {
      id: "research",
      profile: "default",
      prompt: "Research {{input.topic}} and summarize the findings.",
    },
  ])
    addStep(step);
  if (!template) el("template-input-names").value = "topic";
  el("template-error").hidden = true;
  el("template-dialog").showModal();
  el("template-id").focus();
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const status = await api("/status");
    runtimeStatus = status;
    access = status.access ?? {
      owner: Boolean(status.configuration),
      scopes: [],
    };
    el("new-job").hidden =
      !can("submit") || !["jobs", "workflows"].includes(currentView);
    for (const id of ["pause-all", "resume-all"]) el(id).hidden = !access.owner;
    text(
      "session-kind",
      access.owner
        ? "Owner access"
        : can("submit")
          ? "Application access"
          : "Read-only access",
    );
    text("queue-heading", access.owner ? "All jobs" : "Your jobs");
    text(
      "sidebar-description",
      status.worker === "claude" ? "Claude Code worker" : "Codex worker",
    );
    el("token-form").hidden = !access.owner;
    document.querySelector('[form="token-form"]').hidden = !access.owner;
    el("diagnostic-access-tab").hidden = !access.owner;
    el("health").dataset.state = status.scheduler.paused
      ? "paused"
      : status.readiness.ready
        ? "ready"
        : "attention";
    selectedWorker = status.worker === "claude" ? "Claude Code" : "Codex";
    text(
      "health",
      status.scheduler.paused
        ? "Dispatch paused"
        : status.readiness.ready
          ? "Ready for work"
          : "Attention required",
    );
    text(
      "summary",
      status.activeJobs +
        " active jobs · " +
        (status.permissionMode === "bypass"
          ? "Bypass explicitly enabled"
          : "Permissions enabled") +
        " · " +
        selectedWorker +
        (status.scheduler.retryAt
          ? " · Reset " + new Date(status.scheduler.retryAt).toLocaleString()
          : ""),
    );
    if (status.scheduler.reason) notice(status.scheduler.reason);
    text("diagnostics", JSON.stringify(status, null, 2));
    const facts = [
      [
        selectedWorker + " connection",
        status.readiness.ready
          ? "Ready"
          : (status.readiness.reason ?? "Checking"),
      ],
      ["Dispatch", status.scheduler.paused ? "Paused" : "Running"],
      [
        "Permission mode",
        status.permissionMode === "bypass"
          ? "Bypass explicitly enabled"
          : "Permissions enabled",
      ],
      ["Active jobs", status.activeJobs],
      ["Connected hosts", status.hosts ?? "Unavailable"],
      ["Event streams", status.eventConnections],
      ["Profiles", status.profiles.join(", ")],
      ["OpenAI base URL", location.origin + "/v1"],
      ["Model aliases", status.profiles.map((p) => "bridge/" + p).join(", ")],
      ["Workspace", status.workspace ?? "Owner access required"],
    ];
    el("health-facts").replaceChildren();
    for (const [label, value] of facts) {
      const term = document.createElement("dt"),
        description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      if (label === "Workspace") description.className = "path";
      el("health-facts").append(term, description);
    }
    renderProvider(status);
    providerSetup.render(status, selectedWorker);
    modelCards = (await api("/models")).data;
    imageInput.render(
      modelCards,
      status,
      el("setup-profile").value || "default",
    );
    const previous = el("profile").value;
    el("profile").replaceChildren(
      ...status.profiles.map((id) => new Option(id, id)),
    );
    if (status.profiles.includes(previous)) el("profile").value = previous;
    const prevTemplate = el("template").value;
    el("template").replaceChildren(
      ...status.templates.map((t) => new Option(t.id, t.id)),
    );
    el("template").value = status.templates.some((t) => t.id === prevTemplate)
      ? prevTemplate
      : (status.templates[0]?.id ?? "");
    const templateHelp = () => {
      const t = status.templates.find((t) => t.id === el("template").value);
      renderWorkflowInputs(t);
      text(
        "template-help",
        t
          ? "Required inputs: " + (t.inputs.join(", ") || "none")
          : "No templates configured.",
      );
    };
    el("template").onchange = templateHelp;
    templateHelp();
    el("workflow-form").querySelector("button").disabled =
      !status.templates.length || !can("workflows");
    // Refresh the pages the operator opened, keeping recent jobs first as history grows.
    const refreshed = [];
    let after = "";
    for (let page = 0; page < loadedPages; page++) {
      const data = await api(
        "/jobs?limit=200&order=desc&after=" + encodeURIComponent(after),
      );
      refreshed.push(...data.jobs);
      after = data.nextCursor;
      if (!after) break;
    }
    jobs = refreshed;
    cursor = after;
    renderJobs();
    if (selected)
      await selectJob(
        selected,
        jobs.find((job) => job.id === selected),
        false,
      );
    if (!el("workflows-view").hidden) await renderWorkflows();
    if (!el("diagnostics-view").hidden) await renderTokens();
  } catch (e) {
    if (connected && e.name !== "AbortError") notice(e.message);
    if (connected && e.name !== "AbortError") {
      el("health").dataset.state = "attention";
      text("health", "Connection needs attention");
    }
  } finally {
    refreshing = false;
  }
}
function renderProvider(status) {
  text("provider-name", selectedWorker);
  text(
    "provider-readiness",
    status.readiness.ready
      ? "Subscription ready on this machine"
      : (status.readiness.reason ?? "Checking official CLI login"),
  );
  text("provider-url", location.origin + "/v1");
  el("provider-facts").replaceChildren();
  const config = status.configuration;
  const facts = config
    ? [
        ["Execution", status.execution],
        ["Parallel jobs", config.concurrency],
        ["Queue capacity", config.queueCapacity],
        [
          "Inference",
          "Native actions disabled; caller executes declared functions",
        ],
        [
          "Native agents",
          config.capabilities.nativeAgents
            ? "Claude profile agents"
            : "Codex threads; Claude agent definitions are not applied",
        ],
        [
          "Tool restrictions",
          config.capabilities.profileToolAllowlist
            ? "Claude profile tool allowlist"
            : "Codex sandbox; Claude tool allowlist is not enforced",
        ],
      ]
    : [
        [
          "Configuration",
          "Owner authentication required to inspect profiles and limits",
        ],
      ];
  for (const [label, value] of facts) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = String(value);
    el("provider-facts").append(dt, dd);
  }
  el("profile-cards").replaceChildren();
  if (!config) {
    text("profile-cards", "Owner authentication required.");
    return;
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    const card = document.createElement("article"),
      heading = document.createElement("h3");
    card.className = "profile-card";
    card.dataset.profile = name;
    heading.textContent = "bridge/" + name;
    card.append(heading);
    for (const value of [
      "Model: " + (profile.model ?? "Official CLI default"),
      "Permissions: " +
        (profile.permissionMode === "bypass"
          ? "Explicit bypass; trusted host required"
          : "Default enabled"),
      "Deadline: " +
        profile.timeoutMs / 1000 +
        "s · Output limit: " +
        profile.maxOutputBytes +
        " bytes",
    ]) {
      const p = document.createElement("p");
      p.textContent = value;
      card.append(p);
    }
    el("profile-cards").append(card);
  }
}
async function renderTokens() {
  if (!access.owner) {
    text("tokens", "Application access is managed by the bridge owner.");
    return;
  }
  try {
    const { tokens } = await api("/admin/tokens");
    el("tokens").replaceChildren();
    for (const t of tokens) {
      const row = document.createElement("div");
      row.className = "token-row";
      const name = document.createElement("span");
      name.textContent = t.id + (t.revoked ? " (revoked)" : "");
      row.append(name);
      if (!t.owner && !t.revoked)
        row.append(
          action("Revoke", async () => {
            await api("/admin/tokens/revoke", { id: t.id });
            await renderTokens();
          }),
        );
      el("tokens").append(row);
    }
  } catch (e) {
    text("tokens", e.message);
  }
}
function keepCurrentNavVisible() {
  const nav = document.querySelector(".rail nav");
  const selected = nav?.querySelector("[data-view].selected");
  if (!nav || !selected) return;
  const rail = nav.getBoundingClientRect();
  const button = selected.getBoundingClientRect();
  const left =
    button.left < rail.left
      ? button.left - rail.left
      : button.right > rail.right
        ? button.right - rail.right
        : 0;
  const top =
    button.top < rail.top
      ? button.top - rail.top
      : button.bottom > rail.bottom
        ? button.bottom - rail.bottom
        : 0;
  nav.scrollBy({ left, top, behavior: "instant" });
}
const navigationResize = new ResizeObserver(keepCurrentNavVisible);
navigationResize.observe(document.querySelector(".rail nav"));
function showView(name, { history = true } = {}) {
  if (!Object.hasOwn(viewLabels, name)) name = "jobs";
  currentView = name;
  if (history && location.hash !== "#" + name)
    window.history.pushState({ view: name }, "", "#" + name);
  for (const node of document.querySelectorAll(".view"))
    node.hidden = node.id !== name + "-view";
  for (const button of document.querySelectorAll("[data-view]")) {
    button.setAttribute("aria-label", viewLabels[button.dataset.view]);
    button.classList.toggle(
      "selected",
      connected && button.dataset.view === name,
    );
    button.dataset.access = connected ? "available" : "locked";
    if (connected && button.dataset.view === name)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
    if (!connected) button.setAttribute("aria-describedby", "nav-access-state");
    else button.removeAttribute("aria-describedby");
  }
  text("nav-access-state", connected ? "Workspace" : "Connect required");
  text("shell-context", connected ? viewLabels[name] : "Connect");
  text(
    "view-title",
    connected
      ? {
          jobs: "Jobs & conversations",
          workflows: "Workflows",
          providers: "Providers & setup",
          diagnostics: "Diagnostics",
        }[name]
      : "Connect",
  );
  text(
    "view-description",
    connected
      ? {
          jobs: "Inspect work and continue native sessions.",
          workflows: "Run saved steps in order and inspect each checkpoint.",
          providers: "Set up your worker and application access.",
          diagnostics: "Inspect service state and application permissions.",
        }[name]
      : "Open your private bridge with an owner or application token.",
  );
  text(
    "connection-destination",
    "Continue to " + viewLabels[name] + " after connection.",
  );
  document.body.dataset.connection = connected ? "connected" : "disconnected";
  document.querySelector(".toolbar").hidden =
    !connected || !["jobs", "workflows"].includes(name);
  document.querySelector(".activity").hidden = name === "providers";
  el("diagnostic-activity-toggle").hidden =
    !connected || name !== "diagnostics";
  el("new-job").hidden =
    !connected || !can("submit") || !["jobs", "workflows"].includes(name);
  el("mobile-disconnect").hidden = !connected;
  el("header-connect").hidden = connected;
  el("connect-session").hidden = connected;
  el("content").scrollTop = 0;
  mobileNavigation.close();
  requestAnimationFrame(keepCurrentNavVisible);
  if (connected) void refresh();
}
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => showView(button.dataset.view);
window.addEventListener("popstate", () =>
  showView(hashView(), { history: false }),
);
function lockSession(message = "") {
  sessionEpoch++;
  connected = false;
  token = "";
  for (const id of [
    "job-form",
    "message-form",
    "workflow-form",
    "token-form",
    "template-form",
  ])
    el(id).reset();
  controller?.abort();
  access = { owner: false, scopes: [] };
  runtimeStatus = undefined;
  modelCards = [];
  jobs = [];
  templates = [];
  workflowInputSignature = "";
  lastJobPayload = "";
  lastWorkflowPayload = "";
  el("workflow-advanced").open = false;
  selected = "";
  selectionRevision++;
  eventCursor = 0;
  seenEvents.clear();
  document.body.dataset.jobDetail = "closed";
  cursor = null;
  attemptsSnapshot = undefined;
  imageInput.disconnect();
  for (const id of ["job-dialog", "template-dialog"])
    if (el(id).open) el(id).close();
  for (const id of [
    "jobs",
    "messages",
    "templates-list",
    "workflow-runs",
    "events",
    "health-facts",
    "tokens",
    "profile-cards",
    "template-steps",
    "workflow-fields",
  ])
    el(id).replaceChildren();
  el("job-detail").hidden = true;
  el("login").hidden = false;
  el("workspace").hidden = true;
  el("logout").hidden = true;
  el("job-count").hidden = true;
  el("new-token").hidden = true;
  el("created-token").value = "";
  el("token").value = "";
  text("attempts", "");
  text("diagnostics", "");
  text("job-error", "");
  text("connection", "Disconnected");
  text("session-kind", "Not connected");
  text("health", "Not connected");
  el("health").dataset.state = "disconnected";
  text("sidebar-description", "Connect to inspect runtime");
  showView(currentView, { history: false });
  notice(message);
}
function focusConnection() {
  el("content").scrollTop = 0;
  el("token").focus({ preventScroll: true });
}
el("header-connect").onclick = focusConnection;
el("connect-session").onclick = focusConnection;
const detailViewport = matchMedia("(max-width: 1100px)");
detailViewport.addEventListener("change", () => {
  if (detailViewport.matches && selected)
    document.body.dataset.jobDetail = "open";
});
el("back-to-jobs").onclick = () => {
  document.body.dataset.jobDetail = "closed";
  el("content").scrollTop = 0;
};
/* fetch streaming permits bearer headers; EventSource would force a cookie or a URL token. */
async function stream(signal) {
  let delay = 1000;
  while (token && !signal.aborted) {
    try {
      const response = await fetch("/v1/bridge/events", {
        headers: {
          Authorization: "Bearer " + token,
          "Last-Event-ID": String(eventCursor),
        },
        signal,
      });
      if (response.status === 409) {
        eventCursor = (await api("/status")).eventCursorFloor;
        await refresh();
        const data = await response.json();
        notice(data.error.message + " State refreshed.");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (response.status === 401) {
        lockSession("Session expired. Connect with a valid token to continue.");
        return;
      }
      if (!response.ok)
        throw new Error("Event connection rejected (" + response.status + ")");
      text("stream-state", "Live / SSE");
      text("connection", "Connected");
      delay = 1000;
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const id = frame.match(/^id: (\d+)/m)?.[1],
            data = frame.match(/^data: (.+)$/m)?.[1];
          if (id) eventCursor = Number(id);
          if (!data || seenEvents.has(eventCursor)) continue;
          seenEvents.add(eventCursor);
          if (seenEvents.size > 500)
            seenEvents.delete(seenEvents.values().next().value);
          const event = JSON.parse(data),
            li = document.createElement("li"),
            time = document.createElement("time"),
            body = document.createElement("span");
          time.textContent = new Date(event.createdAt).toLocaleTimeString();
          body.textContent =
            event.type +
            " / " +
            (event.data.text ?? event.data.error ?? event.jobId);
          li.append(time, body);
          el("events").prepend(li);
          while (el("events").children.length > 80)
            el("events").lastChild.remove();
          if (
            ["job.paused", "job.rate_limit", "job.compaction"].includes(
              event.type,
            )
          )
            notice(event.data.error ?? event.data.text ?? event.type);
        }
      }
    } catch {
      if (signal.aborted) return;
      text("stream-state", "Reconnecting…");
      text("connection", "Reconnecting");
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(15000, delay * 2);
  }
}
const pending = (form, label) => {
  const button = form.querySelector("button.primary:not([hidden])"),
    original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  form.setAttribute("aria-busy", "true");
  return () => {
    button.disabled = false;
    button.textContent = original;
    form.removeAttribute("aria-busy");
  };
};
el("connect-form").onsubmit = async (event) => {
  event.preventDefault();
  const finished = pending(el("connect-form"), "Connecting…");
  token = el("token").value.trim();
  try {
    runtimeStatus = await api("/status");
    access = runtimeStatus.access ?? {
      owner: Boolean(runtimeStatus.configuration),
      scopes: [],
    };
    connected = true;
    el("token").value = "";
    el("login").hidden = true;
    el("workspace").hidden = false;
    el("logout").hidden = false;
    showView(currentView, { history: false });
    notice("");
    controller = new AbortController();
    void stream(controller.signal);
    await refresh();
  } catch (e) {
    token = "";
    notice(e.message);
    el("token").focus();
  } finally {
    finished();
  }
};
el("logout").onclick = () => {
  void api("/hosts/disconnect", { id: hostId }).catch(() => {});
  lockSession();
  focusConnection();
};
el("refresh").onclick = () => {
  notice("");
  void refresh();
};
for (const cmd of ["pause", "resume"])
  el(cmd + "-all").onclick = () =>
    api("/admin/" + cmd, {})
      .then(() => {
        notice("");
        return refresh();
      })
      .catch((e) => notice(e.message));
el("job-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!jobWizard.reviewing()) {
    jobWizard.next();
    return;
  }
  const body = {
    model: "bridge/" + el("profile").value,
    messages: [{ role: "user", content: el("prompt").value }],
    bridge: {
      execution: el("mode").value === "cli" ? "agent" : el("mode").value,
      background: true,
    },
  };
  const fingerprint = JSON.stringify(body);
  if (fingerprint !== lastJobPayload) {
    jobRequestId = crypto.randomUUID();
    lastJobPayload = fingerprint;
  }
  const finished = pending(el("job-form"), "Queueing…");
  try {
    const job = await api("/chat/completions", body, "POST", jobRequestId);
    el("prompt").value = "";
    el("job-dialog").close();
    selected = job.id;
    if (detailViewport.matches) document.body.dataset.jobDetail = "open";
    lastJobPayload = "";
    showView("jobs");
    notice("");
    await refresh();
  } catch (error) {
    text(
      "job-form-error",
      error.message +
        " Queue again reuses this request when its content is unchanged.",
    );
    el("job-form-error").hidden = false;
  } finally {
    finished();
  }
};
el("message-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/jobs/" + selected + "/messages", {
      text: el("followup").value,
    });
    el("followup").value = "";
    await refresh();
  } catch (e) {
    notice(e.message);
  }
};
el("workflow-form").onsubmit = async (event) => {
  event.preventDefault();
  let finished;
  try {
    const body = { templateId: el("template").value, inputs: workflowValues() };
    const fingerprint = JSON.stringify(body);
    if (fingerprint !== lastWorkflowPayload) {
      workflowRequestId = crypto.randomUUID();
      lastWorkflowPayload = fingerprint;
    }
    finished = pending(el("workflow-form"), "Starting…");
    await api("/workflow-runs", body, "POST", workflowRequestId);
    lastWorkflowPayload = "";
    notice("");
    await refresh();
  } catch (error) {
    if (error.name !== "AbortError")
      notice(
        error.message +
          " Start again reuses this request when its inputs are unchanged.",
      );
  } finally {
    finished?.();
    el("workflow-form").querySelector("button").disabled =
      !connected || !can("workflows") || !runtimeStatus?.templates.length;
  }
};
el("token-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api("/admin/tokens", {
      id: el("client-name").value,
      profiles: el("client-profiles")
        .value.split(",")
        .map((x) => x.trim()),
      scopes: el("client-permissions").value.split(","),
    });
    el("created-token").value = result.token;
    el("created-token").type = "password";
    text("show-token", "Show");
    el("show-token").setAttribute("aria-pressed", "false");
    el("new-token").hidden = false;
    el("token-created-help").hidden = false;
    await renderTokens();
  } catch (e) {
    notice(e.message);
  }
};
el("more").onclick = async () => {
  if (refreshing) return;
  loadedPages++;
  await refresh();
};
setInterval(() => {
  if (token) {
    void api("/hosts/heartbeat", { id: hostId }).catch(() => {});
    void refresh();
  }
}, 5000);

el("new-job").onclick = () => {
  if (connected && can("submit")) jobWizard.open();
};
const mobileNavigation = createMobileNavigation();
const jobWizard = createJobWizard(() => runtimeStatus);
const imageInput = createImageInput(api, async (id) => {
  showView("jobs");
  await selectJob(id);
});
el("setup-profile").addEventListener("change", () =>
  imageInput.render(
    modelCards,
    runtimeStatus,
    el("setup-profile").value || "default",
  ),
);
const providerSetup = createProviderSetup(
  refresh,
  () => showView("diagnostics"),
  () => el("new-job").click(),
  notice,
);
el("close-job").onclick = () => el("job-dialog").close();
el("new-template").onclick = () => openTemplate();
el("close-template").onclick = () => el("template-dialog").close();
el("add-step").onclick = () => {
  if (el("template-steps").children.length < 32) addStep();
};
el("template-form").onsubmit = async (event) => {
  event.preventDefault();
  const body = {
    id: el("template-id").value,
    description: el("template-description").value,
    inputs: el("template-input-names")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    steps: [...el("template-steps").children].map((card) => ({
      id: card.querySelector('[name="step-id"]').value,
      prompt: card.querySelector('[name="step-prompt"]').value,
      profile: card.querySelector('[name="step-profile"]').value,
    })),
  };
  try {
    await api("/admin/templates/" + encodeURIComponent(body.id), body, "PUT");
    el("template-dialog").close();
    await refresh();
  } catch (e) {
    text("template-error", e.message);
    el("template-error").hidden = false;
  }
};

el("template-form").addEventListener("input", () => {
  el("template-error").hidden = true;
});

showView(currentView, { history: false });
el("copy-token").onclick = async () => {
  try {
    await navigator.clipboard.writeText(el("created-token").value);
    notice("Token copied.");
  } catch {
    notice(
      "Clipboard access is unavailable. Show and copy the token manually.",
    );
  }
};
el("show-token").onclick = () => {
  const hidden = el("created-token").type === "password";
  el("created-token").type = hidden ? "text" : "password";
  text("show-token", hidden ? "Hide" : "Show");
  el("show-token").setAttribute("aria-pressed", String(hidden));
};

el("mobile-disconnect").onclick = () => {
  mobileNavigation.close();
  el("logout").click();
};

el("workflow-json-mode").onchange = () => {
  if (el("workflow-json-mode").checked) {
    el("workflow-inputs").value = JSON.stringify(
      Object.fromEntries(
        [...el("workflow-fields").querySelectorAll("textarea")].map((field) => [
          field.name,
          field.value,
        ]),
      ),
      null,
      2,
    );
  } else {
    try {
      el("workflow-json-mode").checked = true;
      const values = workflowValues();
      el("workflow-json-mode").checked = false;
      for (const field of el("workflow-fields").querySelectorAll("textarea"))
        field.value = values[field.name] ?? "";
    } catch (error) {
      notice(error.message);
    }
  }
  const advanced = el("workflow-json-mode").checked;
  el("workflow-fields").hidden = advanced;
  for (const field of el("workflow-fields").querySelectorAll("textarea"))
    field.disabled = advanced;
  el("workflow-json-values").hidden = !advanced;
};
