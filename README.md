<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

<p align="center"><img src="assets/banner.png" width="920" alt="Firefly Agent Bridge"></p>

# Firefly Agent Bridge

Firefly Agent Bridge connects firefly forge, application SDKs and coding-agent hosts to your signed-in Codex or Claude Code CLI. It runs on your developer machine and uses your own coding subscription.

The bridge admits work to a durable queue. It retains execution attempts, workflow checkpoints and audit records, and handles pause and resume. The official coding agent manages login, model access, native transcripts and context. Provider credentials stay with that client.

![Developer console](assets/screenshots/dashboard-desktop.png)

## Use it for local development and testing

Firefly Agent Bridge is intended for local development and testing. It uses your signed-in coding CLI subscription rather than a separately billed model API; subscription quotas still apply. We advise against using it for production workloads: provider license and usage restrictions, local security boundaries, and performance limits may make it unsuitable. Check the terms of your plan and provider before connecting an application. See [OpenAI's terms](https://openai.com/policies/terms-of-use/) and [Anthropic's consumer terms](https://www.anthropic.com/legal/consumer-terms).

## Run locally

Install and sign in to the official agent you intend to use:

```sh
codex login
codex login status
# Alternatively: claude auth login && claude auth status
npm ci
npm run build
node dist/cli.cjs init --worker codex
node dist/cli.cjs serve
```

The published executable is `firefly-bridge`; source commands above run the same CLI. `init --worker claude` selects Claude Code instead. The default data directory is `~/Library/Application Support/Firefly Agent Bridge/` on macOS, the matching Local AppData directory on Windows, and XDG state on Linux. Protect `owner.token` and `queue.sqlite` there.

Open [the local console](http://127.0.0.1:8766), then enter the owner token. For application callers create a token scoped to their profiles and operations. Never put a bearer token in a URL.

## Connect firefly forge

Set `FORGE_BRIDGE_URL` to the local service URL and `FORGE_BRIDGE_TOKEN` to a scoped token. firefly forge uses `bridge/default` through the OpenAI-compatible Chat Completions API. Its FireflyAgent executes the declared application tools inside the selected factory workspace.

The bridge also accepts native agent work:

```json
{
  "model": "bridge/default",
  "messages": [{ "role": "user", "content": "Write a release checklist" }],
  "bridge": { "execution": "agent", "background": true }
}
```

Send this to `POST /v1/chat/completions` with a bearer header and an idempotency key. The 202 response is a durable job. Poll `GET /v1/bridge/jobs/{id}/result` or subscribe to `GET /v1/bridge/events`. Native jobs use their own directories under the configured workspace; HTTP callers cannot select arbitrary executables, environments or working directories.

## Execution profiles

Configuration chooses `worker: "codex"` plus an absolute `codexPath`, or `worker: "claude"` plus an absolute `claudePath`. Profiles set model, tools, timeout, output bounds and permission mode. `/v1/bridge/status` and `/v1/models` expose the selected worker and actual configured model.

Default Codex jobs use `workspace-write` sandboxing and never request interactive approval. Default Claude jobs use `acceptEdits` with noninteractive permission prompts denied. An owner may explicitly choose `permissionMode: "bypass"` for a trusted execution host. CLI credentials and OS permissions remain local developer responsibilities.

Codex inference disables native command, patch, browser, app and agent tools, uses a read-only sandbox and validates a structured completion envelope. Any observed native action makes the inference fail. Claude inference grants no native tools. Both expose client function calls for FireflyAgent, OpenAI SDK and Pydantic AI. Inference also accepts [bounded image attachments](docs/openai-compatible.md#image-input), with per-profile capability verification through an owner-only pixel challenge.

Claude profile-defined subagents remain available with `Agent`; Codex does not translate those Claude definitions. Bridge workflows provide durable sequential stages with either worker. Subscription rejection pauses dispatch without switching billing or guessing reset times.

## Documentation

[Installation](docs/installation.md) · [Configuration](docs/configuration.md) · [Architecture](docs/architecture.md) · [API](docs/api.md) · [SDKs](docs/openai-compatible.md) · [Console](docs/dashboard.md) · [Workflows](docs/workflows.md) · [Audit](docs/audit.md) · [Operations](docs/operations.md) · [Verification](docs/verification.md)

<a id="development-and-internal-packaging"></a>

## Development and packaging

Source builds require Node.js 24+; native packages use official Node.js 26.3.0. `npm run check` runs type checks, lint, formatting, the full test suite, Python SDK interoperability, browser interactions, builds, documentation and API contract checks, native packaging and packaged MCP smoke tests. Desktop manifests use the official MCPB 0.3 JSON Schema. The builder produces unsigned deterministic ZIP bundles.

`npm run test:live:codex:images` verifies a pixel-only challenge through the signed-in official Codex client. `npm run test:live:codex` consumes your subscription allowance and records evidence locally under ignored `work/`.

Get source and native packages from `fireflyframework/firefly-agent-bridge`. Native plugin bootstrap verifies the release archive's checksum before caching its executable. firefly forge distributions include the HTTP client integration; install the bridge separately on the machine with your coding-agent login.

The software is open source under Apache-2.0. Keep the attribution in source notices and [NOTICE](NOTICE). Firefly marks and separately owned artwork retain the rights described in [Brand ownership](assets/BRAND-NOTICE.md). The bridge is independently operated. Provider access follows the official client's capabilities and your account permissions.
