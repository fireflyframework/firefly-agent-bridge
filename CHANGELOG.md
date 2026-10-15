<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Changelog

## 0.2.11 - 2026-10-15

- Maintain completion, continuation, MCP host and tool instructions in native Agentic YAML resources with explicit versions and a generated catalog.
- Verify source and rendered-text digests before bundling; preserve the existing instruction bytes, message ordering and user workflow syntax.
- Keep Python as a build-time authoring dependency. The installed bridge remains Node-only.
- Compile prompts with a separate Python environment selected by `BRIDGE_PROMPT_PYTHON`, preserving the pinned SDK client and documentation environment selected by `BRIDGE_PYTHON`.

## 0.2.10 - 2026-10-14

- Claude keeps its final process-group cleanup signal after the executable closes. A transient permission error no longer marks cleanup failed when a bounded read-only check subsequently confirms that the group is absent. Persistent or unexpected errors remain explicit cleanup errors; they cannot establish successful execution or cancellation. An existing pause request keeps its paused status.
- Cleanup diagnostics include only a fixed shutdown phase and an allowlisted error code. Final output parsing cannot leave an escalation timer running after the attempt settles.
- Console, documentation, plugin manifests and native package metadata identify version 0.2.10. Current guide images use controlled local fixtures; provider login and real model execution remain separate acceptance checks.

## 0.2.9 - unpublished tag, 2026-10-14

- Compact console navigation uses the canonical solid Firefly parent mark while preserving the Manrope wordmark, Bridge span, and existing desktop and phone spacing.
- Release builds embed the same compact artwork as the source console. Native package checks compare both returned logo variants with their generated assets.
- Documentation headers use the compact solid mark at small sizes. The 0.2.9 source refreshed guide images using fixture services; the phone access guide keeps its fields and action visible without creating a token.

The 0.2.9 tag is retained unchanged. Its release verification failed on a macOS cancellation check, so the publisher did not publish release assets. The original CI signal error did not retain enough detail to establish its operating-system cause. Version 0.2.10 supersedes that unpublished release attempt.

## 0.2.8 - 2026-10-13

- Task-based local setup guides, a shared light/dark documentation theme, and a synchronized 3D message illustration with pause and reduced-motion controls.
- Readable command, tool, file, and message evidence in the console, with bounded previews and the original audit record available for inspection.
- Claude Code bootstrap downloads checksum-verified native archives over HTTPS without requiring a GitHub login. CLI, HTTP, MCP, UI, integration manifests, and installation examples identify the same version.
- Work guides explain each wizard stage with expandable screenshot galleries, light/dark images, bounded phone captures and links to the full screenshots.
- Checksum validation reads archive bytes directly, so Windows cache paths do not affect the digest. Installer fixtures also use relative archive paths for Git Bash.
- GitHub Pages builds the MkDocs site from main after documentation checks. Screenshot checks decode the visible theme, and the reading view has no floating control over the figures.
- Selecting a job opens its mobile detail before loading audit history, so a concurrent background refresh cannot leave its conversation hidden.

## 0.2.7 — 2026-10-12

- Off-screen setup and workflow actions have a scroll-and-focus shortcut on desktop as well as phones.
- Long conversations scroll with the page on phones and short windows, preserving access to the latest response and continuation form.
- Diagnostics can expand recent recorded activity with keyboard-accessible View activity and Hide activity controls.
- File inspection describes the configured coding agent without attributing Codex observations to Claude.

## 0.2.6 — 2026-10-12

- Preserve cancellation when readiness subsequently fails in both official-agent workers. Uncanceled readiness failures retain their original errors.

## 0.2.5 — 2026-10-12

- Paused image checks point to the Jobs resume control instead of requesting a new login.
- Read-only provider setup explains submission access and omits its unavailable job action.
- Phones show an Actions shortcut when setup or workflow controls are below the visible content. The shortcut scrolls and focuses those controls without advancing or submitting.

## 0.2.4 — 2026-10-12

- Connection opens a compact access form, explains the selected destination, and continues there after authentication. Expired access clears private details and returns to the connection gate.
- Phones use a 120-pixel shell and a keyboard-accessible modal menu. Desktop keeps the shared 76-pixel header, 248-pixel rail and aligned 64-pixel footer.
- A three-step job dialog validates the task, preserves execution choices when moving back, and reviews the actual worker, profile and limits before admission. Unchanged failed submissions retain their idempotency key.
- Provider guides distinguish the running worker from another provider. Profiles expose image verification as an explicit owner action; read-only applications see inspection controls only.
- Local plugin instructions use stdio MCP. Hosted applications and ChatGPT require an explicitly configured reachable gateway; no automatic local relay or ChatGPT account connection is claimed.

## 0.2.3 — 2026-10-12

- Inference accepts up to five PNG/JPEG/WebP data-URL attachments, with aggregate decoded-byte, pixel, and expansion limits. Other API routes retain their existing body limit.
- Codex receives exclusive private image files; Claude supports stream-JSON image blocks. Native inference tools remain disabled, and image jobs require a new explicit request after a pause or uncertain outcome.
- Model discovery reports image-input proof tied to the actual worker configuration. An owner-only, idempotent pixel challenge verifies that the selected model read an image.
- Temporary Codex attachments are removed after success, failure, cancellation, and interrupted-job recovery.

## 0.2.2 — 2026-10-12

- Browser tests create a fresh owner principal for each default login. Repeated visual checks no longer share the service owner's request budget; production rate limits are unchanged.
- Publishes the provider-wizard and Diagnostics refinements prepared under the unpublished 0.2.1 tag, with consistent 0.2.2 native packages and integration manifests.

The 0.2.1 tag is retained for history. Its release verification stopped on shared test-principal rate limiting, and no 0.2.1 release assets were published. Version 0.2.2 supersedes that release attempt.

## 0.2.1 — unpublished tag, 2026-10-12

- A four-step provider setup wizard separates provider setup guides, official subscription login, execution profiles and development-tool connections.
- Diagnostics presents worker readiness, dispatch and active jobs together, with application-token management in a separate panel.
- Setup preserves the chosen profile when moving between steps and distinguishes the running worker from another provider's setup guide.
- Clearer local stdio MCP and remote HTTPS connection instructions, with the same scoped access and restart requirements.
- Embedded native packages include the setup module; CLI, HTTP, MCP, plugin manifests and installation examples identify this patch consistently.

The setup guide does not sign in to a provider, rewrite worker configuration or establish a remote ChatGPT connection. Real subscription access and model execution remain separate checks.

## 0.2.0 — 2026-10-12

- A distinct bridge mark and a shared Firefly grid, typography and light/dark/system appearances.
- Separate header, navigation, content and footer rows, with usable mobile navigation and no fixed footer covering forms.
- Native Codex plugin, marketplace and operation skill alongside the Claude Code integrations.
- Scoped Streamable HTTP MCP for authorized clients, preserving token scopes and revocation.
- Task-based MkDocs guides for installation, providers, integrations, diagnostics, recovery and security.
- Real Codex subscription file edits, session follow-ups and native plugin/MCP acceptance recorded separately from deterministic tests.

ChatGPT web connections require an organization-owned HTTPS/OAuth gateway and account-specific setup. Local Codex acceptance does not establish a completed ChatGPT web connection.

## 0.1.0 — 2026-10-11

Initial private developer release of Firefly Agent Bridge.

- Official Codex ChatGPT and Claude Code subscription workers, with explicit selection and accurate readiness/model discovery.
- Enabled permissions by default, Codex workspace sandboxing, and owner-selected bypass for trusted execution hosts.
- OpenAI-compatible Chat Completions, structured output, caller-owned functions and buffered completion streaming for FireflyAgent and SDK applications.
- Durable SQLite jobs, fenced attempts, native session follow-ups, recovery controls, workflow checkpoints and replayable events.
- Durable command/file/tool audit with observed-provider provenance, metadata views and JSON exports.
- Firefly developer console, native private Claude integrations and authenticated internal release bootstrap.
- Official-schema validated deterministic unsigned MCPB ZIP packaging; vulnerable packaging dependencies removed.
- Complete deterministic, SDK, browser and native-package gates; separate opt-in real subscription smoke.
- Private CI verifies Linux x64, macOS arm64 and Windows x64 before publishing internal GitHub release archives and checksums.

See [verification](docs/verification.md) for evidence boundaries and host-specific acceptance.
