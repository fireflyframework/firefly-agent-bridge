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

Firefly Agent Bridge runs on your developer machine. Connect Firefly Forge,
application SDKs or coding-agent hosts to your signed-in Codex or Claude Code CLI.

<div class="bridge-home__actions" markdown="1">

[Install the bridge](installation.md){ .bridge-button .bridge-button--primary }
[Connect an application](integrations.md){ .bridge-button }

</div>

The software is licensed under Apache-2.0. Running work requires your provider login and local bridge token.
{: .bridge-home__note }

</div>

<figure class="bridge-home__flow">
<div class="bridge-home__flow-item">
<strong>Your applications</strong>
<span>Firefly Forge, SDKs and MCP hosts</span>
</div>
<div class="bridge-home__flow-item bridge-home__flow-item--service">
<img src="../assets/brand/bridge-mark.svg" alt="" width="32" height="32">
<strong>Local bridge</strong>
<span>Admission, durable jobs and audit</span>
</div>
<div class="bridge-home__flow-item">
<strong>Official coding agent</strong>
<span>Codex or Claude Code login and native session</span>
</div>
<figcaption>Applications use scoped bridge tokens. Provider credentials stay with the official CLI.</figcaption>
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
