---
title: Documentation home
hide:
  - toc
---

<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

<div class="bridge-home" markdown="1">

<div class="bridge-home__hero" markdown="1">

<div class="bridge-home__intro" markdown="1">

<div class="bridge-home__identity">
<img src="../assets/brand/bridge-mark.svg" alt="" width="48" height="48">
<span>Developer documentation</span>
</div>

# Use your coding subscription in your applications.

Firefly Agent Bridge runs on your developer machine.[^local-development] Connect Firefly Forge,
application SDKs or coding-agent hosts to your signed-in Codex or Claude Code CLI.

<div class="bridge-home__actions" markdown="1">

[Install the bridge](installation.md){ .bridge-button .bridge-button--primary }
[Connect an application](integrations.md){ .bridge-button }

</div>

The software is licensed under Apache-2.0. Running work requires your provider login and local bridge token.
{: .bridge-home__note }

</div>

<figure class="bridge-home__flow docs-scene" data-docs-scene data-renderer="fallback" aria-describedby="scene-demo-note" aria-label="Application messages cross the Bridge API to a signed-in coding CLI chat subscription; responses return on a separate lane">
<div class="docs-scene__viewport" data-scene-viewport>
<div class="docs-scene__fallback">
<svg viewBox="0 0 480 280" role="img" aria-label="Applications connected through Bridge to Codex or Claude">
<g fill="none" stroke="currentColor" stroke-width="2">
<rect x="12" y="116" width="86" height="64" rx="8"/>
<rect x="382" y="116" width="86" height="64" rx="8"/>
<path d="M100 144H380" stroke="#ffb34a" stroke-width="4"/>
</g>
<path d="M166 76H314V100H166Z M178 100H302V188H276V144C276 106 204 106 204 144V188H178Z" fill="currentColor"/>
<path d="M115 137l8 7-8 7m248-14-8 7 8 7" fill="none" stroke="#ffb34a" stroke-width="3"/>
</svg>
</div>
</div>

<div class="docs-scene__controls">
<span class="docs-scene__status" data-scene-status aria-live="polite">Illustration · no live activity</span>
<button type="button" data-scene-toggle aria-pressed="false" disabled>Loading…</button>
</div>

</figure>

</div>

<div class="bridge-home__start" markdown="1">

## Run your first job

<div class="bridge-home__steps" markdown="1">

<div markdown="1">

### Install and sign in

Download the archive for your platform, verify its checksum and sign in through
the official provider CLI. Source installation is also available.

[Installation guide](installation.md)

</div>

<div markdown="1">

### Open the local console

Start the service, connect with your owner token and check the worker and profile.
Use a disposable job directory to verify the result and inspect its activity.

[Console tour](dashboard.md) · [Find your token](tokens.md)

</div>

<div markdown="1">

### Connect your application

Choose the host plugin, stdio MCP or an application SDK. Create a scoped token for
HTTP callers and check the connection with a small job.

[Host integrations](integrations.md) · [SDK examples](openai-compatible.md)

</div>

</div>

</div>

<div class="bridge-home__guides" markdown="1">

## Continue with the work you need

<div class="bridge-home__guide" markdown="1">

### Run and inspect work

Submit a job, continue its conversation or run an ordered workflow. Inspect tool
inputs, results and known file changes before retrying interrupted work.

[Jobs in the console](dashboard.md#jobs-and-conversations) ·
[Workflow templates](workflows.md) · [Activity and audit](audit.md)

</div>

<div class="bridge-home__guide" markdown="1">

### Operate the service

Manage lifecycle, paused dispatch and backups. Resolve access, profile or provider
readiness failures using the reported state.

[Recovery and operations](operations.md) · [Troubleshooting](troubleshooting.md) ·
[Security boundaries](security.md)

</div>

<div class="bridge-home__guide" markdown="1">

### Build an integration

Use the supported Chat Completions contract or the authenticated management API.
The calling application executes its declared functions; native agent jobs run in
the bridge's workspace.

[Chat Completions and functions](openai-compatible.md) · [HTTP API](api.md) ·
[CLI and MCP tools](reference.md)

</div>

<div class="bridge-home__guide" markdown="1">

### Connect from another host

A hosted application needs an organization-owned HTTPS gateway that can reach the
bridge. Its server's loopback address does not reach your developer machine.

[Remote access](tunnels.md) · [ChatGPT MCP requirements](integrations.md#chatgpt-remote-mcp)

</div>

</div>

<div class="bridge-home__boundary" markdown="1">

## Verify on your developer machine

Local protocol tests and console screenshots establish specific interface and
execution behavior. Provider permission, account availability and host consent
need checks on the actual developer machine. ChatGPT remote access also needs the
organization's gateway and supported authentication.

[Supported surfaces](compatibility.md) · [Verification evidence](verification.md)

</div>

</div>

[^local-development]: Firefly Agent Bridge is intended for local development and testing. It uses your signed-in coding CLI subscription rather than a separately billed model API; subscription quotas still apply. We advise against using it for production workloads: provider license and usage restrictions, local security boundaries, and performance limits may make it unsuitable. Check the terms of your plan and provider before connecting an application. See [OpenAI's terms](https://openai.com/policies/terms-of-use/) and [Anthropic's consumer terms](https://www.anthropic.com/legal/consumer-terms).

<p id="scene-demo-note" class="docs-scene-note">The home-page animation is a demonstration. It reads no run data and makes no model calls. <a href="assets/docs-scene/THIRD_PARTY_NOTICES.txt">Illustration licenses and notices</a>.</p>
