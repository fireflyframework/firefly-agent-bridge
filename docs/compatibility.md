<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Supported execution surfaces

Firefly Agent Bridge is private infrastructure for individual Firefly developers. Official Codex ChatGPT login or official Claude subscription login remains with the installed CLI; the bridge never collects provider credentials or silently changes billing.

| Surface                       | Execution                                                           |
| ----------------------------- | ------------------------------------------------------------------- |
| Firefly Forge / FireflyAgent  | OpenAI-compatible Chat Completions with caller-owned functions      |
| Official Codex CLI            | Native JSONL worker, thread resume, default workspace-write sandbox |
| Official Claude Code 2.1.260+ | Native stream-json worker, session resume, profile subagents        |
| Claude Desktop / Code MCP     | Private native installation and local management tools              |
| Internal applications         | Authenticated jobs, workflows, audit and orchestration events       |

Source requires Node.js 24+. Native packaging uses official Node.js 26.3.0 for macOS arm64/x64, Linux arm64/x64 and Windows x64. Desktop extensions target macOS/Windows. Intel macOS packaging retains the unmodified runtime beside its launcher.

The OpenAI-compatible contract includes text Chat Completions, client function calls, structured output and buffered SSE. Responses and multimodal endpoints are outside this contract. Claude-defined native subagent configurations apply to Claude, not Codex. Bridge workflow checkpoints apply to both workers.

Default permissions are enabled. Managed client policies, installation consent and provider availability still apply. Unknown quota reset times stay paused for operator recovery. Private release downloads require authenticated GitHub CLI access.

Official references: [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Claude programmatic CLI](https://code.claude.com/docs/en/headless).
