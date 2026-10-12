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
export function createProviderSetup(refresh, showAccess, openJob, notice) {
  const element = (id) => document.getElementById(id);
  let step = 0,
    reached = 0,
    guide = null,
    worker = "Codex",
    status;
  const profile = element("setup-profile");
  const client = element("setup-client");
  const mobileDiagnostics = matchMedia("(max-width: 760px)");
  let diagnosticSection = "service";
  function selectDiagnostics(section, focus = false) {
    diagnosticSection = section;
    for (const button of document.querySelectorAll("[data-diagnostic-tab]")) {
      const active = button.dataset.diagnosticTab === section;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus({ preventScroll: true });
    }
    for (const [name, id] of [
      ["service", "diagnostic-status-panel"],
      ["access", "diagnostic-access-panel"],
    ]) {
      const panel = element(id);
      panel.hidden = mobileDiagnostics.matches && name !== section;
      panel.setAttribute(
        "role",
        mobileDiagnostics.matches ? "tabpanel" : "region",
      );
      panel.setAttribute(
        "aria-labelledby",
        mobileDiagnostics.matches
          ? "diagnostic-" + name + "-tab"
          : "diagnostic-" +
              (name === "service" ? "status" : "access") +
              "-heading",
      );
    }
  }
  for (const button of document.querySelectorAll("[data-diagnostic-tab]")) {
    button.onclick = () => selectDiagnostics(button.dataset.diagnosticTab);
    button.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      selectDiagnostics(
        event.key === "Home"
          ? "service"
          : event.key === "End"
            ? "access"
            : button.dataset.diagnosticTab === "service"
              ? "access"
              : "service",
        true,
      );
    };
  }
  mobileDiagnostics.addEventListener("change", () =>
    selectDiagnostics(diagnosticSection),
  );
  selectDiagnostics(diagnosticSection);
  function details() {
    const name = profile.value || "default";
    element("setup-profile-alias").textContent = "bridge/" + name;
    for (const card of element("profile-cards").children)
      card.hidden =
        card.dataset.profile !== name && card.dataset.profile !== undefined;
    const app = client.value;
    element("provider-url").textContent =
      location.origin +
      (app === "openai" ? "/v1" : app === "chatgpt" ? "/mcp" : "/v1/bridge");
    element("setup-client-instructions").textContent = {
      codex:
        "Install the private Codex plugin and use its stdio MCP adapter. The plugin includes bridge operation skills.",
      claude:
        "Use the Claude Code plugin or the Claude Desktop bundle. Both include the stdio MCP adapter.",
      chatgpt:
        "ChatGPT needs an approved HTTPS endpoint it can reach. Connect /mcp with your scoped application token; a loopback address is for local clients.",
      openai:
        "Set this base URL, use your scoped application token as the API key, and choose bridge/" +
        name +
        " as the model.",
    }[app];
  }
  function show(next, focus = true) {
    step = next;
    reached = Math.max(reached, step);
    for (const panel of document.querySelectorAll("[data-setup-panel]"))
      panel.hidden = Number(panel.dataset.setupPanel) !== step;
    for (const button of document.querySelectorAll("[data-setup-step]")) {
      const index = Number(button.dataset.setupStep);
      button.disabled = index > reached;
      if (index === step) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    }
    element("setup-back").hidden = step === 0;
    element("setup-next").hidden = step === 3;
    element("setup-start-job").hidden = step !== 3;
    element("setup-step-count").textContent = "Step " + (step + 1) + " of 4";
    details();
    if (focus)
      document
        .querySelector('[data-setup-panel="' + step + '"] h2')
        .focus({ preventScroll: true });
    document.querySelector(".setup-body").scrollTop = 0;
  }
  function subscription() {
    const provider = guide === "claude" ? "Claude Code" : "Codex";
    const current = guide === (status?.worker ?? "codex");
    element("setup-provider-detail-name").textContent = provider;
    element("setup-provider-detail-badge").textContent = current
      ? "Current worker"
      : "Setup guide";
    element("setup-provider-detail-summary").textContent =
      guide === "claude"
        ? "Run Claude Code through its official CLI. Your Claude subscription and login remain with that client."
        : "Run Codex through its official CLI. Your ChatGPT subscription and login remain with that client.";
    element("setup-provider-route-command").textContent =
      "$ " + (guide === "claude" ? "claude auth login" : "codex login");
    element("setup-provider-detail-running").textContent = worker;
    element("setup-provider-detail-readiness").textContent = status?.readiness
      .ready
      ? "Ready on this machine"
      : "Needs attention";
    element("setup-provider-detail-instruction").textContent = current
      ? ""
      : "This guide does not change your worker. Stop the bridge, update its worker and executable, then restart before checking this login.";
    element("setup-login-command").textContent =
      guide === "claude" ? "claude auth login" : "codex login";
    element("setup-worker-instructions").textContent =
      guide === (status?.worker ?? "codex")
        ? "After signing in, refresh the running worker's readiness below."
        : "The running bridge uses " +
          worker +
          ". Update its worker and executable in the configuration, then restart it to use this provider.";
    for (const button of document.querySelectorAll("[data-setup-provider]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.setupProvider === guide),
      );
  }
  for (const button of document.querySelectorAll("[data-setup-step]"))
    button.onclick = () => show(Number(button.dataset.setupStep));
  for (const button of document.querySelectorAll("[data-setup-provider]"))
    button.onclick = () => {
      guide = button.dataset.setupProvider;
      subscription();
    };
  element("setup-next").onclick = () => show(Math.min(3, step + 1));
  element("setup-back").onclick = () => show(Math.max(0, step - 1));
  profile.onchange = details;
  client.onchange = details;
  element("setup-refresh").onclick = () => void refresh();
  element("refresh-diagnostics").onclick = () => void refresh();
  async function copy(id) {
    try {
      await navigator.clipboard.writeText(element(id).textContent);
      notice("Copied to clipboard.");
    } catch {
      notice("Clipboard access is unavailable. Select and copy the text.");
    }
  }
  element("setup-copy-login").onclick = () => void copy("setup-login-command");
  element("setup-copy-url").onclick = () => void copy("provider-url");
  element("setup-client-access").onclick = () => {
    element("client-profiles").value = profile.value || "default";
    selectDiagnostics("access");
    showAccess();
    element("client-name").focus({ preventScroll: true });
  };
  element("setup-start-job").onclick = () => {
    element("profile").value = profile.value || "default";
    openJob();
  };
  show(0, false);
  return {
    render(value, currentWorker) {
      status = value;
      worker = currentWorker;
      guide ??= value.worker;
      const selected = profile.value;
      profile.replaceChildren(
        ...value.profiles.map((name) => new Option("bridge/" + name, name)),
      );
      if (value.profiles.includes(selected)) profile.value = selected;
      element("setup-codex-current").textContent =
        value.worker === "codex" ? "Running" : "Guide";
      element("setup-claude-current").textContent =
        value.worker === "claude" ? "Running" : "Guide";
      element("setup-access-status").textContent =
        worker +
        ": " +
        (value.readiness.ready
          ? "Ready on this machine"
          : value.readiness.reason || "Checking login");
      element("diagnostic-worker").textContent = worker;
      element("diagnostic-readiness").textContent = value.readiness.ready
        ? "Ready"
        : "Needs attention";
      element("diagnostic-dispatch").textContent = value.scheduler.paused
        ? "Paused"
        : "Running";
      element("diagnostic-active").textContent = String(value.activeJobs);
      subscription();
      details();
    },
  };
}
