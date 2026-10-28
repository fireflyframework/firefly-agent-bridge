---
description: Inspect bridge CLI commands and MCP tools for job submission, workflow execution, session access and local service management.
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# CLI and MCP reference

Run `bridge help` for the installed version (`firefly-bridge` remains a compatibility alias). For source installations, use `node dist/cli.cjs` in place of the native executable. Commands that connect to a service need the same `--data-dir` as that instance.

## Commands

| Command     | Behavior                                                      | Options                                                                |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `init`      | Create local configuration, preserving an existing file       | `--worker codex` or `--worker claude`; default initial worker is Codex |
| `serve`     | Run the HTTP service and worker scheduler                     | `--managed` follows host/work idle lifecycle                           |
| `mcp`       | Start the stdio MCP adapter and discover or start its service | `--channel` enables Code channel notifications                         |
| `status`    | Return authenticated service status                           | `--data-dir PATH`                                                      |
| `panel`     | Print console URL and owner token path, then open the browser | `--data-dir PATH`                                                      |
| `pause`     | Pause dispatch and request pauses for active CLI jobs         | `--data-dir PATH`                                                      |
| `resume`    | Clear the global dispatch pause when eligible                 | Resume individual paused jobs separately                               |
| `stop`      | Gracefully stop the local service                             | `--data-dir PATH`                                                      |
| `token`     | Create an application token                                   | `--id NAME --profiles default --scopes read,submit,control,workflows`  |
| `revoke`    | Revoke all tokens for a principal                             | `--id NAME`                                                            |
| `--version` | Print the release version                                     | No service required                                                    |

The CLI prints a new application token once. Keep that output private. `panel` returns the console URL and owner token file location. The MCP `bridge_panel` tool returns the URL and instructions to locate that file through the CLI.

## MCP tools

The adapter's `tools/list` response contains the complete installed schemas. These tools use the shared local service:

| Tool                      | Purpose                                                   |
| ------------------------- | --------------------------------------------------------- |
| `bridge_status`           | Selected worker, readiness, dispatch, profiles, templates |
| `bridge_panel`            | Console URL and owner-token location instructions         |
| `bridge_submit`           | Admit a native CLI or host-conversation job               |
| `bridge_jobs`             | List jobs                                                 |
| `bridge_job`              | Inspect one job                                           |
| `bridge_control`          | Pause, resume, cancel, or retry a job                     |
| `bridge_message`          | Continue a native job conversation                        |
| `bridge_workflow_start`   | Start a saved sequential workflow                         |
| `bridge_workflows`        | List recent runs                                          |
| `bridge_workflow_control` | Pause, resume, or cancel a run                            |
| `bridge_templates`        | List saved definitions                                    |
| `bridge_template_save`    | Validate and persist a definition                         |
| `bridge_scheduler`        | Pause or resume dispatch                                  |
| `bridge_channel_pending`  | List host-conversation jobs awaiting a claim              |
| `bridge_channel_claim`    | Claim a host-conversation job with an exclusive receipt   |
| `bridge_channel_progress` | Report host progress using that receipt                   |
| `bridge_channel_complete` | Commit host result using that receipt                     |
| `bridge_channel_stopped`  | Acknowledge requested host pause or cancellation          |

Host tools have owner access through the local adapter. They can manage local state and admit native execution; approve them only in a trusted host. The bridge requires claim identity and fencing for channel progress, completion, and stop acknowledgments.

## Local state

The data directory contains saved configuration, discovery identity, owner token, SQLite queue and sidecars, and logs. The configured workspace contains job directories. Native transcripts and provider login remain in the official CLI's own storage.

The [HTTP API](api.md), [configuration](configuration.md), [token guide](tokens.md), and [operations guide](operations.md) describe request and lifecycle details. The machine-readable [OpenAPI document](openapi.json) covers the HTTP management surface.
