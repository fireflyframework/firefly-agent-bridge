/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
function validDuration(policy) {
  return (
    policy?.version === 1 &&
    (policy.timeoutMs === null ||
      (Number.isSafeInteger(policy.timeoutMs) && policy.timeoutMs > 0))
  );
}
export function workDurationLabel(policy) {
  if (policy === undefined) return "Legacy execution policy";
  if (!validDuration(policy)) return "Execution policy unavailable";
  return policy.timeoutMs === null
    ? "Until completion or cancellation"
    : `${(policy.timeoutMs / 1000).toLocaleString("en-US")} seconds after admission`;
}
export function createJobWizard(runtime) {
  const el = (id) => document.getElementById(id);
  let step = 0;
  let deadlineBeforeChannel = false;
  function duration(report = false) {
    const state = runtime(),
      profile = el("profile").value;
    const profileDuration =
      state?.workDurationProfiles?.[profile] ??
      state?.configuration?.profiles[profile]?.workDuration;
    if (el("mode").value === "channel" && profileDuration?.timeoutMs != null) {
      if (report) {
        if (step !== 1) show(1, false);
        el("job-form-error").textContent =
          "This profile requires a deadline. Choose a local coding job or text completion.";
        el("job-form-error").hidden = false;
      }
      return undefined;
    }
    if (!el("job-deadline-enabled").checked)
      return { version: 1, timeoutMs: null };
    const input = el("job-deadline"),
      value = input.value.trim(),
      milliseconds = Number(value) * 1000;
    const valid =
      /^\d+$/.test(value) &&
      Number.isSafeInteger(milliseconds) &&
      milliseconds > 0;
    input.setCustomValidity(
      valid ? "" : "Enter a positive whole number of seconds.",
    );
    if (!valid) {
      if (report) {
        if (step !== 1) show(1, false);
        input.reportValidity();
      }
      return undefined;
    }
    return { version: 1, timeoutMs: milliseconds };
  }
  const details = () => {
    const state = runtime(),
      profile = el("profile").value,
      options = state?.configuration?.profiles[profile],
      mode = el("mode").value;
    const selected = duration(),
      profileDuration =
        state?.workDurationProfiles?.[profile] ?? options?.workDuration;
    const channel = mode === "channel";
    const blocked = channel && profileDuration?.timeoutMs != null;
    el("job-deadline-enabled").disabled = channel;
    el("job-deadline-field").hidden =
      channel || !el("job-deadline-enabled").checked;
    el("job-deadline").disabled =
      channel || !el("job-deadline-enabled").checked;
    el("job-next").disabled = blocked && step === 1;
    el("queue-job").disabled = blocked;
    el("job-deadline-help").textContent = channel
      ? blocked
        ? "This profile requires a deadline. Bridge cannot enforce a work deadline in a connected host; choose local coding or text completion."
        : "Bridge cannot enforce a work deadline in a connected host. Use local coding or text completion to choose one."
      : "Leave this off when the duration is unknown. An explicit profile deadline still applies. Chosen deadlines include time in the queue.";
    const limits = [profileDuration?.timeoutMs, selected?.timeoutMs].filter(
      (value) => value !== null,
    );
    const effectiveDuration =
      validDuration(profileDuration) && selected
        ? { version: 1, timeoutMs: limits.length ? Math.min(...limits) : null }
        : undefined;
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
        "Work deadline",
        effectiveDuration
          ? workDurationLabel(effectiveDuration)
          : "Confirmed when queued",
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
    if (step === 1 && !duration(true)) return;
    show(Math.min(2, step + 1));
  }
  el("prompt").addEventListener("input", () =>
    el("prompt").setCustomValidity(""),
  );
  el("job-next").onclick = next;
  el("job-back").onclick = () => show(Math.max(0, step - 1));
  el("mode").addEventListener("change", () => {
    const checkbox = el("job-deadline-enabled");
    if (el("mode").value === "channel") {
      deadlineBeforeChannel = checkbox.checked;
      checkbox.checked = false;
    } else if (checkbox.disabled) checkbox.checked = deadlineBeforeChannel;
    details();
  });
  el("profile").addEventListener("change", details);
  el("job-deadline-enabled").addEventListener("change", () => {
    const enabled = el("job-deadline-enabled").checked;
    el("job-deadline-field").hidden = !enabled;
    el("job-deadline").disabled = !enabled;
    el("job-deadline").setCustomValidity("");
    details();
  });
  el("job-deadline").addEventListener("input", details);
  return {
    open() {
      show(0, false);
      el("job-dialog").showModal();
      el("prompt").focus();
    },
    reviewing: () => step === 2,
    duration: () => duration(true),
    admitted() {
      deadlineBeforeChannel = false;
      el("job-deadline-enabled").checked = false;
      el("job-deadline-enabled").disabled = el("mode").value === "channel";
      el("job-deadline").value = "";
      el("job-deadline").disabled = true;
      el("job-deadline").setCustomValidity("");
      el("job-deadline-field").hidden = true;
    },
    next,
  };
}
