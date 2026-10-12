/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
export function createJobWizard(runtime) {
  const el = (id) => document.getElementById(id);
  let step = 0;
  const details = () => {
    const state = runtime(),
      profile = el("profile").value,
      options = state?.configuration?.profiles[profile],
      mode = el("mode").value;
    el("execution-help").textContent = {
      cli: "Uses the running coding agent and its native capabilities. Permission settings belong to this profile.",
      inference:
        "Native actions are disabled. This console displays the text completion; application callers execute their declared functions.",
      channel:
        "Waits for a connected host that supports conversation dispatch.",
    }[mode];
    const facts = [
      ["Worker", state?.worker === "claude" ? "Claude Code" : "Codex"],
      ["Profile", "bridge/" + profile],
      ["Model", options?.model ?? "Official CLI default"],
      [
        "Permissions",
        mode === "inference"
          ? "Native actions disabled"
          : options?.permissionMode === "bypass"
            ? "Bypass explicitly enabled"
            : options
              ? "Default permissions"
              : "Owner-configured policy",
      ],
      [
        "Deadline",
        options
          ? options.timeoutMs / 1000 + " seconds"
          : "Owner-configured limit",
      ],
    ];
    for (const id of ["execution-facts", "job-review-facts"]) {
      el(id).replaceChildren();
      for (const [label, value] of facts) {
        const dt = document.createElement("dt"),
          dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = value;
        el(id).append(dt, dd);
      }
    }
    el("job-review").textContent = el("prompt").value;
  };
  function show(next, focus = true) {
    step = next;
    for (const panel of document.querySelectorAll("[data-job-step-panel]"))
      panel.hidden = Number(panel.dataset.jobStepPanel) !== step;
    for (const item of document.querySelectorAll("[data-job-step]")) {
      if (Number(item.dataset.jobStep) === step)
        item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    }
    el("job-back").hidden = step === 0;
    el("job-next").hidden = step === 2;
    el("queue-job").hidden = step !== 2;
    el("job-step-count").textContent = "Step " + (step + 1) + " of 3";
    details();
    el("job-form-error").hidden = true;
    document.querySelector(".job-step-body").scrollTop = 0;
    if (focus)
      document
        .querySelector('[data-job-step-panel="' + step + '"] h3')
        .focus({ preventScroll: true });
  }
  function next() {
    if (step === 0) {
      el("prompt").setCustomValidity(
        el("prompt").value.trim() ? "" : "Describe the work before continuing.",
      );
      if (!el("prompt").reportValidity()) return;
    }
    show(Math.min(2, step + 1));
  }
  el("prompt").addEventListener("input", () =>
    el("prompt").setCustomValidity(""),
  );
  el("job-next").onclick = next;
  el("job-back").onclick = () => show(Math.max(0, step - 1));
  el("mode").addEventListener("change", details);
  el("profile").addEventListener("change", details);
  return {
    open() {
      show(0, false);
      el("job-dialog").showModal();
      el("prompt").focus();
    },
    reviewing: () => step === 2,
    next,
  };
}
