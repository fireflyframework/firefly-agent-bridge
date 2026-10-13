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

const el = (id) => document.getElementById(id);
const node = (tag, value, className) => {
  const result = document.createElement(tag);
  if (value !== undefined) result.textContent = value;
  if (className) result.className = className;
  return result;
};
// Preserve focus, selection, and scroll when a polling refresh contains no changes.
function replaceIfChanged(parent, children) {
  if (
    parent.childNodes.length === children.length &&
    children.every((child, index) => parent.childNodes[index] === child)
  )
    return;
  parent.replaceChildren(...children);
}
const pretty = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const timestamp = (value) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Time unavailable";
const state = (value) =>
  ({
    requested: "Awaiting result",
    succeeded: "Reported success",
    failed: "Reported failure",
    unknown: "Outcome unknown",
  })[value] ?? value;
export function previewText(value, characters = 10000, lines = 120) {
  const text = value
    .slice(0, characters)
    .split("\n")
    .slice(0, lines)
    .join("\n");
  return { text, omitted: value.length - text.length };
}
export function codeTokens(value, path = "") {
  if (
    !/\.(?:[cm]?[jt]sx?|py|java|php|css|json|ya?ml|sh|sql|rs|go)$/i.test(
      path,
    ) ||
    value.length > 4000
  )
    return [{ text: value, kind: "plain" }];
  const comments = /\.(?:py|ya?ml|sh)$/i.test(path);
  const pattern = comments
    ? /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
    : /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*.*?\*\/|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  const keywords = new Set(
    "const let var function return import export from class def async await if else elif for while try catch except finally throw raise new public private static void interface type extends implements null undefined true false True False None self this as in with package fn use select where create table".split(
      " ",
    ),
  );
  const tokens = [];
  let position = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > position)
      tokens.push({ text: value.slice(position, match.index), kind: "plain" });
    const text = match[0],
      kind = /^["'`]/.test(text)
        ? "string"
        : /^(?:#|\/\/|\/\*)/.test(text)
          ? "comment"
          : /^\d/.test(text)
            ? "number"
            : keywords.has(text)
              ? "keyword"
              : "plain";
    tokens.push({ text, kind });
    position = match.index + text.length;
  }
  if (position < value.length)
    tokens.push({ text: value.slice(position), kind: "plain" });
  return tokens;
}
export function reportedPatch(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (hunk) =>
        hunk &&
        Number.isInteger(hunk.oldStart) &&
        Number.isInteger(hunk.newStart) &&
        hunk.oldStart >= 0 &&
        hunk.newStart >= 0 &&
        Array.isArray(hunk.lines) &&
        hunk.lines.every((line) => typeof line === "string"),
    )
  )
    return undefined;
  const rows = [];
  for (const hunk of value) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("+"))
        rows.push({
          text: line.slice(1),
          kind: "addition",
          newLine: newLine++,
        });
      else if (line.startsWith("-"))
        rows.push({
          text: line.slice(1),
          kind: "deletion",
          oldLine: oldLine++,
        });
      else if (line.startsWith(" "))
        rows.push({
          text: line.slice(1),
          kind: "context",
          oldLine: oldLine++,
          newLine: newLine++,
        });
      else rows.push({ text: line, kind: "metadata" });
    }
  }
  return rows;
}
const fieldLabel = (value) => {
  const words = value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
function copyButton(value, label = "Copy full output") {
  const wrapper = node("span", undefined, "audit-copy"),
    button = node("button", label),
    status = node("span", "");
  button.type = "button";
  status.setAttribute("role", "status");
  button.onclick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy unavailable. Select the text to copy.";
    }
  };
  wrapper.append(button, status);
  return wrapper;
}
function compact(value, limit = 350) {
  const text = String(value ?? ""),
    preview = previewText(text, limit, 4),
    result = node("span", preview.text, "audit-compact");
  if (preview.omitted)
    result.append(
      node("small", `… (${preview.omitted.toLocaleString()} more characters)`),
      copyButton(text, "Copy full text"),
    );
  return result;
}
function codeLine(value, path) {
  const code = node("code");
  for (const token of codeTokens(value, path))
    code.append(node("span", token.text, "audit-token-" + token.kind));
  return code;
}
function outputView(value, path) {
  const view = node("div", undefined, "audit-output"),
    pre = node("pre"),
    controls = node("div", undefined, "audit-output-controls"),
    more = node("button", "Show more"),
    limit = node("span");
  pre.tabIndex = 0;
  more.type = "button";
  let expanded = false;
  function render() {
    const preview = previewText(
      value,
      expanded ? 100000 : 10000,
      expanded ? 1000 : 120,
    );
    pre.replaceChildren();
    if (path)
      for (const [index, text] of preview.text.split("\n").entries()) {
        const row = node("span", undefined, "audit-code-line"),
          number = node("span", String(index + 1), "audit-line-number");
        number.setAttribute("aria-hidden", "true");
        row.append(number, codeLine(text, path));
        pre.append(row);
      }
    else pre.textContent = preview.text || "(empty)";
    limit.textContent = preview.omitted
      ? `${preview.omitted.toLocaleString()} characters outside this preview. Copy includes the full recorded text.`
      : "";
    more.hidden = !previewText(value).omitted;
    more.textContent = expanded ? "Show less" : "Show more";
  }
  more.onclick = () => {
    expanded = !expanded;
    render();
  };
  controls.append(copyButton(value), limit, more);
  view.append(pre, controls);
  render();
  return view;
}
function structuredValue(value, depth = 0, path, budget = { remaining: 200 }) {
  if (budget.remaining-- <= 0)
    return node(
      "span",
      "Additional fields are retained in the advanced record.",
      "hint",
    );
  if (typeof value === "string")
    return value.length > 350 || value.includes("\n") || path
      ? outputView(value, path)
      : compact(value);
  if (value === null || typeof value !== "object")
    return node("code", String(value));
  if (depth >= 3) return advancedRecord(value);
  if (Array.isArray(value)) {
    const list = node("div", undefined, "audit-value-list");
    for (const item of value.slice(0, 20)) {
      if (budget.remaining <= 0) break;
      list.append(structuredValue(item, depth + 1, path, budget));
    }
    const shown = list.childNodes.length;
    if (value.length > shown)
      list.append(
        node(
          "p",
          `Showing ${shown} of ${value.length} items. The advanced record retains all items.`,
          "hint",
        ),
      );
    if (!value.length) list.append(node("span", "No items recorded.", "hint"));
    return list;
  }
  const fields = node("dl", undefined, "audit-fields"),
    entries = Object.entries(value),
    file = typeof value.file_path === "string" ? value.file_path : path;
  for (const [key, item] of entries.slice(0, 40)) {
    if (budget.remaining <= 0) break;
    const row = node("div"),
      label = node("dt"),
      body = node("dd");
    label.append(compact(fieldLabel(key), 120));
    body.append(
      structuredValue(
        item,
        depth + 1,
        ["content", "code", "originalFile"].includes(key) ? file : undefined,
        budget,
      ),
    );
    row.append(label, body);
    fields.append(row);
  }
  if (entries.length > fields.childNodes.length)
    fields.append(
      node(
        "p",
        "Additional fields are retained in the advanced record.",
        "hint",
      ),
    );
  return fields;
}
function advancedRecord(value) {
  const details = node("details", undefined, "raw-payload");
  details.append(
    node("summary", "Advanced record"),
    outputView(pretty(value) ?? String(value)),
  );
  return details;
}
function payload(container, label, value, className = "", path) {
  if (value === undefined) return;
  const section = node("section", undefined, "payload-section " + className),
    heading = node("h4");
  heading.append(compact(label));
  section.append(heading, structuredValue(value, 0, path));
  container.append(section);
}
function patchView(container, value, path) {
  const rows = reportedPatch(value);
  if (!rows) {
    payload(container, "Patch reported by Claude", value);
    return;
  }
  const section = node("section", undefined, "payload-section audit-patch"),
    scroll = node("div", undefined, "audit-patch-scroll"),
    table = node("table"),
    head = node("thead"),
    heading = node("tr"),
    body = node("tbody");
  section.append(
    node("h4", "Patch reported by Claude"),
    copyButton(pretty(value), "Copy full patch record"),
  );
  for (const label of ["Old line", "New line", "Change", "Code"]) {
    const cell = node("th", label);
    cell.scope = "col";
    heading.append(cell);
  }
  head.append(heading);
  let characters = 0;
  for (const row of rows.slice(0, 1000)) {
    if (characters >= 100000) break;
    const item = node("tr", undefined, "audit-patch-" + row.kind),
      text = previewText(row.text, Math.min(4000, 100000 - characters), 1);
    characters += text.text.length;
    item.append(
      node("td", row.oldLine ?? ""),
      node("td", row.newLine ?? ""),
      node(
        "td",
        row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : "",
      ),
    );
    const code = node("td");
    code.append(codeLine(text.text, path));
    if (text.omitted) code.append(node("small", "… preview truncated"));
    item.append(code);
    body.append(item);
  }
  if (body.childNodes.length < rows.length)
    section.append(
      node(
        "p",
        "Patch preview limited. Copy and the advanced record retain the complete patch.",
        "hint",
      ),
    );
  table.append(head, body);
  scroll.append(table);
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "Reported code changes");
  section.append(scroll);
  container.append(section);
}
function inspector(container, tool) {
  const input = tool.input ?? {},
    output = tool.output ?? {},
    result = output.result ?? {},
    path = tool.file?.path ?? input.file_path;
  const info = node(
    "p",
    `${tool.name ?? "Tool"} · ${state(tool.status)} · ${tool.parentToolUseId ? "Subagent" : "Main session"}`,
    "tool-provenance",
  );
  container.append(info);
  if (tool.name === "Bash") {
    payload(container, "Command", input.command, "command-output");
    payload(container, "Standard output", result.stdout);
    payload(container, "Standard error", result.stderr);
    const metadata = Object.fromEntries(
      Object.entries(result).filter(
        ([key]) =>
          ![
            "stdout",
            "stderr",
            "structuredPatch",
            "originalFile",
            "file",
          ].includes(key),
      ),
    );
    if (Object.keys(metadata).length)
      payload(container, "Recorded command result", metadata);
  }
  if (tool.name === "Write")
    payload(
      container,
      tool.status === "succeeded" ? "Written content" : "Requested content",
      input.content,
      "",
      path,
    );
  if (
    tool.name === "Edit" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    container.append(
      node("h4", "Replacement diff"),
      node(
        "p",
        input.replace_all
          ? "Replace all matching occurrences. These are the exact submitted fragments."
          : "Exact submitted replacement fragments; surrounding file content is not implied.",
        "hint",
      ),
    );
    const diff = node("div", undefined, "diff-grid");
    payload(diff, "− Before", input.old_string, "diff-before", path);
    payload(diff, "+ After", input.new_string, "diff-after", path);
    container.append(
      node(
        "p",
        "Line numbers in these fragments start at 1. File positions were not reported.",
        "hint",
      ),
    );
    container.append(diff);
  }
  if (result.structuredPatch)
    patchView(container, result.structuredPatch, path);
  if (result.originalFile !== undefined)
    payload(
      container,
      "Original file reported by Claude",
      result.originalFile,
      "",
      path,
    );
  if (result.file?.content !== undefined)
    payload(
      container,
      "File content reported by Claude",
      result.file.content,
      "",
      path,
    );
  payload(container, "Tool output", output.content);
  if (output.sharedMessageResult) {
    container.append(
      node(
        "p",
        "Claude emitted this structured result for a message containing several tool results. It is not attributed to an individual tool.",
        "hint",
      ),
    );
    payload(container, "Shared message result", output.sharedMessageResult);
  }
  if (!tool.completedAt)
    container.append(
      node(
        "p",
        "No terminal tool result was observed. A side effect may still have occurred.",
        "hint",
      ),
    );
  const raw = node("details", undefined, "raw-payload");
  raw.append(node("summary", "Advanced record"));
  if (tool.input !== undefined)
    raw.append(node("h4", "Input"), outputView(pretty(tool.input)));
  if (tool.output !== undefined)
    raw.append(node("h4", "Result"), outputView(pretty(tool.output)));
  const { input: _input, output: _output, ...metadata } = tool;
  void _input;
  void _output;
  raw.append(node("h4", "Observation"), outputView(pretty(metadata)));
  container.append(raw);
}
export function createAuditPanel(api, notice) {
  let jobId = "",
    revision = 0,
    tab = "conversation",
    toolPages = 1,
    filePages = 1,
    eventPages = 1;
  const cards = new Map();
  const loadedFor = new Map();
  function showTab(name, focus = false) {
    tab = name;
    for (const button of document.querySelectorAll("[data-job-tab]")) {
      const active = button.dataset.jobTab === name;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    }
    for (const panel of document.querySelectorAll("[data-job-panel]"))
      panel.hidden = panel.dataset.jobPanel !== name;
  }
  for (const button of document.querySelectorAll("[data-job-tab]")) {
    button.onclick = () => {
      showTab(button.dataset.jobTab);
      if (jobId) void select({ id: jobId }).catch((e) => notice(e.message));
    };
    button.onkeydown = (event) => {
      const names = ["conversation", "activity", "files"],
        index = names.indexOf(tab);
      const next =
        event.key === "ArrowRight"
          ? (index + 1) % 3
          : event.key === "ArrowLeft"
            ? (index + 2) % 3
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? 2
                : -1;
      if (next >= 0) {
        event.preventDefault();
        showTab(names[next], true);
        if (jobId) void select({ id: jobId }).catch((e) => notice(e.message));
      }
    };
  }
  function reset() {
    jobId = "";
    revision++;
    toolPages = filePages = eventPages = 1;
    cards.clear();
    loadedFor.clear();
    showTab("conversation");
    for (const id of [
      "tool-list",
      "file-list",
      "audit-entries",
      "audit-summary",
    ])
      el(id).replaceChildren();
  }
  function begin(id) {
    if (jobId === id) return;
    reset();
    jobId = id;
  }
  function toolCard(tool, kind, id) {
    const key = kind + ":" + tool.id,
      signature = JSON.stringify(tool),
      old = cards.get(key);
    if (old?.signature === signature) return old.element;
    const card = node("details", undefined, "tool-card");
    card.open = old?.element.open ?? false;
    const summary = node("summary"),
      icon = node(
        "span",
        kind === "files" ? "↗" : tool.name === "Bash" ? ">_" : "⌘",
        "tool-icon",
      ),
      title = node("span", undefined, "tool-title");
    title.append(
      node(
        "strong",
        kind === "files" ? tool.file.path : (tool.name ?? "Unmatched result"),
      ),
    );
    title.append(
      node(
        "small",
        kind === "files"
          ? tool.name + " · " + tool.file.operation
          : (tool.file?.path ??
              (tool.parentToolUseId ? "Subagent tool" : "Main session")),
      ),
    );
    const status = node("span", state(tool.status), "pill " + tool.status);
    const time = node(
      "small",
      tool.durationMs === undefined
        ? timestamp(tool.requestedAt ?? tool.completedAt)
        : (tool.durationMs / 1000).toFixed(2) + " s",
      "tool-time",
    );
    summary.append(icon, title, status, time);
    const body = node("div", undefined, "tool-inspector");
    card.append(summary, body);
    let loaded = false;
    const load = async () => {
      if (!card.open || loaded) return;
      loaded = true;
      body.replaceChildren(node("p", "Loading observation…", "hint"));
      try {
        const value = await api(`/jobs/${id}/tools/${tool.id}`);
        if (jobId !== id || cards.get(key)?.element !== card) return;
        body.replaceChildren();
        inspector(body, value);
      } catch (error) {
        loaded = false;
        body.replaceChildren(node("p", error.message, "error"));
      }
    };
    card.ontoggle = () => void load();
    cards.set(key, { signature, element: card });
    if (card.open) void load();
    return card;
  }
  async function listPages(path, pages, firstPage) {
    let after = 0,
      values = [],
      nextCursor = null;
    for (let page = 0; page < pages; page++) {
      const data =
        page === 0 && firstPage
          ? firstPage
          : await api(
              path +
                "&after=" +
                after +
                (firstPage ? "&through=" + firstPage.through : ""),
            );
      values.push(...(data.tools ?? data.entries));
      nextCursor = data.nextCursor;
      if (nextCursor === null) break;
      after = nextCursor;
    }
    return { values, nextCursor };
  }
  function journal(entries, id) {
    const children = [];
    for (const entry of entries) {
      const key = "event:" + entry.id;
      if (cards.has(key)) {
        children.push(cards.get(key).element);
        continue;
      }
      const row = node("details", undefined, "audit-entry"),
        summary = node("summary");
      const title = entry.type.replaceAll(".", " / ").replaceAll("_", " ");
      summary.append(
        node("time", timestamp(entry.createdAt)),
        node("strong", title),
        node("span", entry.source, "audit-source"),
      );
      row.append(summary);
      let loaded = false;
      row.ontoggle = async () => {
        if (!row.open || loaded) return;
        loaded = true;
        try {
          const data = await api(
            `/jobs/${id}/audit?after=${entry.id - 1}&through=${entry.id}&limit=1&includePayloads=true`,
          );
          if (jobId === id) {
            payload(row, "Recorded observation", data.entries[0]);
            row.append(advancedRecord(data.entries[0]));
          }
        } catch (error) {
          loaded = false;
          notice(error.message);
        }
      };
      cards.set(key, { element: row });
      children.push(row);
    }
    replaceIfChanged(el("audit-entries"), children);
  }
  async function select(job) {
    begin(job.id);
    const current = ++revision,
      id = jobId;
    const first = await api(`/jobs/${id}/audit?limit=30`);
    if (current !== revision || jobId !== id) return;
    const count = first.summary;
    el("audit-summary").replaceChildren(
      ...[
        [count.tools, "tool calls"],
        [count.files, "file targets"],
        [count.changedFiles, "reported changed"],
        [count.events, "audit events"],
      ].map(([value, label]) => {
        const item = node("div");
        item.append(node("strong", String(value)), node("span", " " + label));
        return item;
      }),
    );
    el("activity-count").textContent = String(count.tools);
    el("files-count").textContent = String(count.files);
    el("audit-count").textContent = String(count.events);
    const coverage =
      count.coverage === "client_functions"
        ? "Functions run in the calling application. Inspect requests and client-reported results in the audit log; their filesystem effects are not observed here."
        : count.coverage === "host_lifecycle"
          ? "The host conversation reports job progress. Its internal tool calls and file changes are not exposed to this bridge."
          : "Complete tool payloads as emitted by Claude. Outcomes are provider-reported; shell and external tool side effects may not identify files.";
    el("audit-coverage").textContent = coverage;
    el("file-coverage").textContent =
      "Read, Write, Edit, and NotebookEdit targets reported by the coding agent. Expand an action to inspect content and available diffs. A successful command alone does not verify a file change.";
    const view = tab,
      stamp =
        first.through + ":" + toolPages + ":" + filePages + ":" + eventPages;
    if (view === "conversation" || loadedFor.get(view) === stamp) return;
    const data = await listPages(
      `/jobs/${id}/tools?limit=25` +
        (view === "files" ? "&filesOnly=true" : ""),
      view === "files" ? filePages : toolPages,
    );
    const events =
      view === "activity"
        ? await listPages(`/jobs/${id}/audit?limit=30`, eventPages, first)
        : null;
    if (current !== revision || jobId !== id || tab !== view) return;
    const kind = view === "files" ? "files" : "tools",
      list = view === "files" ? "file-list" : "tool-list",
      button = view === "files" ? "more-files" : "more-tools";
    const nodes = data.values.map((tool) => toolCard(tool, kind, id));
    replaceIfChanged(
      el(list),
      nodes.length
        ? nodes
        : [
            node(
              "p",
              view === "files"
                ? "No file targets observed for this job."
                : "No native tool calls observed for this job.",
              "audit-empty",
            ),
          ],
    );
    el(button).hidden = data.nextCursor === null;
    if (events) {
      journal(events.values, id);
      el("more-audit").hidden = events.nextCursor === null;
      if (count.coverage !== "native_tools") el("audit-journal").open = true;
    }
    loadedFor.set(view, stamp);
    showTab(tab);
  }
  for (const [id, increment] of [
    ["more-tools", () => toolPages++],
    ["more-files", () => filePages++],
    ["more-audit", () => eventPages++],
  ])
    el(id).onclick = async () => {
      increment();
      try {
        await select({ id: jobId });
      } catch (e) {
        notice(e.message);
      }
    };
  el("export-audit").onclick = async () => {
    const id = jobId,
      button = el("export-audit");
    button.disabled = true;
    try {
      let after = 0,
        through,
        bytes = 0,
        first = true;
      const parts = [];
      do {
        const page = await api(
          `/jobs/${id}/audit?limit=200&includePayloads=true&after=${after}` +
            (through === undefined ? "" : `&through=${through}`),
        );
        if (jobId !== id)
          throw new Error(
            "Selection changed. Select the job again to export its audit.",
          );
        through ??= page.through;
        if (!parts.length)
          parts.push(
            JSON.stringify({
              schemaVersion: 1,
              jobId: id,
              through,
              exportedAt: new Date().toISOString(),
            }).slice(0, -1) + ',"entries":[',
          );
        for (const entry of page.entries) {
          const encoded = JSON.stringify(entry);
          bytes += new TextEncoder().encode(encoded).length;
          if (bytes > 64_000_000)
            throw new Error(
              "This audit exceeds the 64 MB browser export limit. Export all pages with the audit API; no partial download was created.",
            );
          parts.push((first ? "" : ",") + encoded);
          first = false;
        }
        after = page.nextCursor;
      } while (after !== null);
      parts.push("]}");
      const url = URL.createObjectURL(
        new Blob(parts, { type: "application/json" }),
      );
      const link = node("a");
      link.href = url;
      link.download = `bridge-audit-${id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notice(error.message);
    } finally {
      button.disabled = false;
    }
  };
  return { select, reset, begin };
}
