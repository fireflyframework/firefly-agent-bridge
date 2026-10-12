<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Management console tour

[README](../README.md) · [Install](installation.md) · [Operations](operations.md)

The console is served by the local bridge. Open the URL returned by `bridge_panel` and authenticate with a bridge token. It submits through `/v1/chat/completions` and uses the same `/v1/bridge` management and notification extensions as other applications.

The screenshots show the running console. Job and tool examples use deterministic fixtures; the current provider and Diagnostics views use an isolated local bridge with an authenticated official Codex CLI. They document interface behavior and login readiness, not production tasks or new model-execution acceptance.

## Jobs and conversations

Select a row to inspect messages, attempts, session continuity, and reported child tasks. Follow-ups remain associated with the same job. A message submitted while work is running is queued until the current attempt completes.

![Job queue and conversation on desktop](../assets/screenshots/dashboard-desktop.png)

**New job** opens a focused dialog. Choose a configured profile and native coding-agent execution, a Chat Completion, or the current host conversation.

![New-job dialog](../assets/screenshots/new-job-desktop.png)

Pause, resume, cancel, and retry are shown according to the job's state. Retry is explicitly different from resume: it starts a new session and can repeat prior effects.

## Tool activity, files, and audit

Each job has **Conversation**, **Activity**, and **Files** tabs. Activity exposes complete emitted tool inputs and outputs, including shell commands and stdout/stderr. Files exposes known targets, returned or submitted content, and available before/after edit fragments. Expand **Raw input, result, and correlation** for the underlying observation.

![Tool inspector](../assets/screenshots/activity-desktop.png)

![File targets and a replacement diff](../assets/screenshots/files-desktop.png)

The audit log retains tool and lifecycle observations across service restarts and SSE retention. **Export audit** downloads a consistent JSON snapshot, including full payloads. Failed or interrupted actions remain clearly labeled; the console does not claim to observe every indirect filesystem effect. See [audit coverage, access, and export](audit.md).

[Mobile activity](../assets/screenshots/activity-mobile.png) · [Mobile file details](../assets/screenshots/files-mobile.png)

## Chat Completions

SDK requests and console-created completions appear in the same queue. Select one to inspect its submitted message history, validated answer or client function requests, observed token usage, and execution attempts. The inference view hides native follow-up controls because the calling application supplies complete history for its next model turn.

![A completion and its observed usage](../assets/screenshots/completion-desktop.png)

[Mobile completion view](../assets/screenshots/completion-mobile.png)

## Workflows

Choose a configured template, provide its required inputs as a JSON object, and start a run. Each run shows its current state and links to the jobs created for its steps. **Open step** switches directly to that job's conversation.

![Workflow administration](../assets/screenshots/workflows-desktop.png)

A workflow pause blocks the next step and requests a pause of its current job. Resuming the workflow clears that barrier. A failed step can be retried from its job view after reviewing its effects.

## Reusable template editor

Use **New template** to define inputs, ordered steps, instructions, and execution profiles. **Edit** updates future runs; existing runs keep their original definition. The form checks references before saving. See [template authoring](workflows.md) for valid use cases and rules.

![Template editor](../assets/screenshots/template-editor-desktop.png)

[Mobile template editor](../assets/screenshots/template-editor-mobile.png)

## Diagnostics and application access

Service health explains login readiness, dispatch state, active jobs, connected hosts, profiles, OpenAI base URL, model aliases, and the workspace. Expand **Connection and execution details** for the full status payload. Readiness reflects the current official CLI login; it does not establish that every configured model can complete a job.

Create a separate token for each trusted application. New tokens are displayed once in the panel; revocation immediately invalidates requests and active event streams.

![Diagnostics and client access](../assets/screenshots/diagnostics-desktop.png)

[Mobile service status](../assets/screenshots/diagnostics-mobile.png) · [Mobile application access](../assets/screenshots/diagnostics-access-mobile.png)

## Responsive navigation

The sidebar becomes a compact navigation row on narrow screens. Queue and conversation panels stack, controls remain accessible, and long diagnostics wrap rather than widening the page. Jobs scroll within the shell. Provider setup keeps its step navigation, current-worker context and action bar visible while only the step body scrolls. Diagnostics keeps each card header and action row visible while its details scroll. Phones separate Service and Application access into keyboard-accessible tabs; Create token stays with the visible application form. Neither action bar covers the global footer. The copyright footer occupies its own row, clear of job and connection controls. On desktop its 64-pixel row aligns with the sidebar connection and disconnect rows.

| Mobile jobs                                                | Mobile workflows                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| ![Mobile jobs](../assets/screenshots/dashboard-mobile.png) | ![Mobile workflows](../assets/screenshots/workflows-mobile.png) |

[Tablet jobs](../assets/screenshots/jobs-tablet.png) · [Tablet workflows](../assets/screenshots/workflows-tablet.png) · [Mobile diagnostics](../assets/screenshots/diagnostics-mobile.png)

## Live activity

The activity stream receives authenticated SSE events and reconnects with the last event ID. When retention has removed older events, it refreshes current job state before reconnecting. Tokens stay in tab memory and are never placed in a URL or browser local storage.

## Appearance and provider setup

Appearance follows the system by default. Choose Light or Dark to save an explicit preference on this browser. The console stores only that preference; reloading clears authentication. The fixed 76-pixel header, 248-pixel desktop rail, Manrope typography, and amber controls match the Firefly developer suite. Mobile navigation preserves access to every view.

Providers & setup guides you through four focused steps:

1. **Provider:** choose a Codex or Claude Code setup guide. The current running worker stays visible; selecting another guide does not change it.
2. **Login:** copy the official login command, run it on the bridge host, then refresh the running worker's readiness. Provider credentials are never entered in this form.
3. **Profile:** choose an existing profile and inspect its effective model, permissions, timeout and output bounds. Advanced provider capabilities remain available when needed.
4. **Tools:** select your development application, create a scoped token and follow its integration instructions. The Codex and Claude plugins use their stdio adapters; a loopback management address is not a remote ChatGPT connection.

The wizard keeps your selected profile when you move back between steps. Earlier visited steps remain accessible. **Start a job** opens the normal job dialog with that profile; it does not submit work automatically.

![Provider setup and profiles](../assets/screenshots/providers-light-desktop.png)

Change worker and profile configuration in the saved file while stopped, restart, then check the effective settings here. The console does not accept provider credentials or rewrite executable paths. Claude tool and agent definitions apply to Claude execution; they do not imply restrictions on Codex.
