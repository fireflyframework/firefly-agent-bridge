/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * Licensed under https://www.apache.org/licenses/LICENSE-2.0
 */
export function createImageInput(api, openJob) {
  const el = (id) => document.getElementById(id);
  let models = [],
    status,
    profile = "default",
    checking = false,
    probeId,
    requestId,
    revision,
    generation = 0;
  function paint() {
    const model = models.find((value) => value.id === "bridge/" + profile),
      capability = model?.image_input,
      verified = capability?.status === "verified",
      owner = Boolean(status?.access?.owner ?? status?.configuration);
    el("image-state").textContent = verified
      ? "Verified"
      : capability?.status === "unsupported"
        ? "Unsupported"
        : "Not verified";
    el("image-state").className =
      "pill " + (verified ? "succeeded" : "unknown");
    el("image-description").textContent = capability
      ? "Running " +
        (model.worker === "claude" ? "Claude Code" : "Codex") +
        " profile: up to " +
        capability.max_images +
        " PNG, JPEG or WebP images, " +
        capability.max_decoded_bytes / 1000000 +
        " MB in total. " +
        (verified
          ? "Verified " +
            new Date(capability.verified_at).toLocaleString() +
            "."
          : "A successful image-only check is required before claiming image support.")
      : "Image capability is unavailable from this bridge.";
    el("verify-image").hidden = !owner;
    el("verify-image").disabled =
      checking ||
      !capability ||
      !status?.readiness.ready ||
      status.scheduler.paused;
    el("verify-image").textContent = checking
      ? "Checking…"
      : "Verify image input";
    el("image-owner-help").textContent = !owner
      ? "Ask the bridge owner to verify image input. Text jobs remain available."
      : !status?.readiness.ready
        ? "Sign in through the running worker's official CLI before checking. Text requests can still enter the queue."
        : status.scheduler.paused
          ? "Resume dispatch in Diagnostics before checking image input."
          : "Runs one image-only check through this profile. Text jobs do not require it.";
  }
  el("verify-image").onclick = async () => {
    checking = true;
    paint();
    const ownGeneration = ++generation;
    try {
      const model = models.find((value) => value.id === "bridge/" + profile);
      if (revision !== model?.image_input?.config_revision) {
        revision = model?.image_input?.config_revision;
        requestId = undefined;
        probeId = undefined;
      }
      requestId ??= crypto.randomUUID();
      el("image-feedback").textContent = "Submitting an image check…";
      const admitted = await api("/image-input/probes", {
        profile,
        request_id: requestId,
      });
      if (ownGeneration !== generation) return;
      probeId = admitted.job_id;
      el("open-image-job").hidden = false;
      const deadline = Date.now() + 125000;
      while (Date.now() < deadline && ownGeneration === generation) {
        const proof = await api("/image-input/probes/" + probeId);
        if (ownGeneration !== generation) return;
        if (proof.status !== "pending") {
          const model = models.find(
            (value) => value.id === "bridge/" + profile,
          );
          if (model) model.image_input = proof.image_input;
          el("image-feedback").textContent =
            proof.status === "verified" &&
            proof.image_input.status === "verified"
              ? "The running model read the image correctly."
              : "Image check failed. Open its job to inspect the result and official CLI readiness.";
          requestId = undefined;
          break;
        }
        el("image-feedback").textContent =
          "Checking image input through your subscription. You can continue with text work.";
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (ownGeneration === generation && Date.now() >= deadline)
        el("image-feedback").textContent =
          "The check is still pending. Open its job to inspect it before trying again.";
    } catch (error) {
      if (ownGeneration === generation)
        el("image-feedback").textContent =
          error.message + " Repeating this check reuses the same request.";
    } finally {
      if (ownGeneration === generation) {
        checking = false;
        paint();
      }
    }
  };
  el("open-image-job").onclick = () => {
    if (probeId) openJob(probeId);
  };
  return {
    render(values, currentStatus, currentProfile) {
      models = values;
      status = currentStatus;
      if (profile !== currentProfile) {
        generation++;
        checking = false;
        requestId = undefined;
        probeId = undefined;
        revision = undefined;
        el("image-feedback").textContent = "";
        el("open-image-job").hidden = true;
      }
      profile = currentProfile;
      paint();
    },
    disconnect() {
      generation++;
      checking = false;
      models = [];
      probeId = undefined;
      requestId = undefined;
      el("image-feedback").textContent = "";
      el("open-image-job").hidden = true;
    },
  };
}
