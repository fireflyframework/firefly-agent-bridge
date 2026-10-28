---
description: Diagnose bridge installation, provider login, job execution, native packaging and connection failures from actual local evidence.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Troubleshoot a local bridge

Start with `bridge status` or the console's Diagnostics view. Inspect the selected worker's readiness reason, dispatch state, profile, and job error before retrying work. `panel` prints the actual address and owner token file path without printing the token.

## Installation and startup

| Symptom                  | Check                                                                      | Action                                                                                            |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Release download fails   | Release tag, asset name and HTTPS response                                 | Use the matching platform archive and checksum list from the repository's release page.           |
| Executable cannot run    | OS, architecture, intact runtime files, organizational installation policy | Use the matching native archive and keep its files together. Verify its checksum.                 |
| `owner.token` is missing | Whether the service started successfully                                   | `init` creates configuration only. Start `serve`, then use the token file in that data directory. |
| Connection refused       | Actual console URL and whether the service is running                      | Start `serve` or a host's MCP adapter. Use `panel` with the same `--data-dir`.                    |
| Port already in use      | Saved port and the other listener's identity                               | Choose a free loopback port in configuration. Do not stop an unrelated service.                   |
| State is already owned   | Existing bridge process using the same data directory                      | Connect to the existing service or stop it deliberately. Two services must not own one database.  |

## Subscription readiness

| Symptom                         | Check                                                                | Action                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Codex is not ready              | `codex login status` and selected absolute executable                | Sign in through official `codex login` on this machine. Restart the bridge after configuration changes.                |
| Claude is not ready             | `claude auth status` and CLI version                                 | Sign in through official Claude. The adapter expects Claude Code 2.1.260 or later.                                     |
| Alternate billing rejected      | API-key or third-party provider overrides in the service environment | Start the bridge with the intended subscription environment. Do not copy provider credentials into config.             |
| Configured model is unavailable | Profile `model` and account's model access                           | Choose an available native model or omit the profile model so the official CLI selects its default.                    |
| Dispatch is quota-paused        | Provider reset timestamp and affected job                            | Wait for a reported reset or explicitly resume after checking account availability. Unknown reset times remain paused. |

The bridge starts Codex with user configuration ignored while preserving its official authentication. A personal CLI model setting is not applied to the worker; the bridge profile's configured model is the deliberate override.

## Cluster pool

| Symptom                                     | Check                                                                                 | Action                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `eligibleNodes` is 0 while nodes are online | `bridge cluster status` → each node's `authentication`, memory/disk/CPU, `quotaState` | Sign in the official CLI on that host; free RAM/disk or lower floors; wait out `limited` or resume after provider reset |
| Join fails against `http://`                | Worker refuses cleartext coordinator                                                  | Use `https://`, or lab-only `--allow-insecure`                                                                          |
| Join rejected for worker type               | Coordinator `config.worker` vs join worker                                            | Keep one CLI type per coordinator; run a second pool for the other CLI                                                  |
| Worker starts then exits on missing key     | `cluster.json` without `nodePrivateKey`                                               | Re-run `bridge cluster join`                                                                                            |
| Jobs stay queued                            | `dispatch`, `eligibleNodes`, worker logs                                              | Confirm workers are serving (`--cluster-worker`) and heartbeating; see [Cluster quota pool](cluster.md)                 |
| Sticky follow-up never moves                | Expected: session bound to home node                                                  | Wait for that node, or `retry` to clear sticky binding                                                                  |

## Requests and application access

| Symptom            | Meaning                                                                       | Action                                                                                          |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| HTTP 400           | Invalid input, unsupported Chat Completions field, schema, or execution shape | Compare the request with the [supported SDK contract](openai-compatible.md#supported-contract). |
| HTTP 401           | Missing, invalid, or revoked bearer token                                     | Use the complete bridge token in the Authorization header.                                      |
| HTTP 403           | Scope, profile, host, or origin denied                                        | Check client assignment and exact host/origin allowlists.                                       |
| HTTP 404 for a job | Missing resource or another principal's resource                              | Use the owning client's token or the local owner console.                                       |
| HTTP 409           | State or idempotency conflict                                                 | Inspect current state; preserve the original body for an uncertain retry.                       |
| HTTP 429           | Rate, capacity, or subscription limit                                         | Respect `Retry-After` when present and inspect durable job state.                               |
| HTTP 503           | Dispatch or configuration unavailable                                         | Resolve the status reason, then reattach using the same request body and idempotency key.       |

`max_tokens` and `max_completion_tokens` are rejected. Set execution bounds in the bridge profile; generation-token request fields are unsupported. In Pydantic AI, use `OpenAIChatModel` and an OpenAI model profile that omits unsupported token settings when your application has a global token cap. Responses is outside this API. Image input is limited to the [documented inference attachment contract](openai-compatible.md#image-input).

## Jobs and workflow steps

A failed or interrupted attempt may already have changed files or remote state. Read Activity, Files, and the result before choosing Retry. Retry starts a new native session. Resume continues a paused job's existing session when it is still available.

A paused workflow blocks its next step. Resume the workflow before retrying its current job. Editing a reusable template changes future runs; an existing run retains its snapshot. Create a corrected run for a definition error in an old snapshot.

If a child task is absent, check that Claude is selected, `Agent` is allowed, and the named native agent exists in that profile. Codex does not translate Claude agent definitions. A requested delegation is not evidence that it occurred.

## Console and event streams

The theme preference survives reload; authentication does not. Reconnect using the owner or client token when a tab reloads. A failed token connection leaves job data closed and reports the error.

SSE reconnects with the last event ID. An expired cursor returns `event_cursor_expired`; refresh current state and start from `eventCursorFloor`. Through a tunnel, preserve Authorization and Last-Event-ID and disable proxy response buffering.

An unknown tool outcome means no terminal tool result was observed. A successful process exit does not fill in a missing result. See [audit coverage](audit.md) and [crash recovery](operations.md#crashes-and-external-effects).

## Image requests

`invalid_image` indicates a media signature, canonical encoding, pixel, expansion, or attachment limit failure. Check that the data URL media type matches the actual file. Use `detail: "auto"`; the CLI adapter cannot select other detail levels. `image_replay_unsupported` requires a new completion request after you inspect the previous job. Reusing the original idempotency key still reads the original outcome and does not execute a second model call.

If a profile remains `unverified`, inspect its owner-only probe job and official subscription readiness. A failed probe never establishes image capability. Changing the executable or execution profile requires a fresh probe request ID.
