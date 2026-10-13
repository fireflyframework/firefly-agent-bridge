<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Supported execution surfaces

Firefly Agent Bridge is an open-source local service for trusted developer applications. The installed CLI keeps your Codex ChatGPT or Claude subscription login. The bridge does not collect provider credentials or change billing.

| Surface                       | Execution                                                           |
| ----------------------------- | ------------------------------------------------------------------- |
| Firefly Forge / FireflyAgent  | OpenAI-compatible Chat Completions with caller-owned functions      |
| Official Codex CLI            | Native JSONL worker, thread resume, default workspace-write sandbox |
| Official Claude Code 2.1.260+ | Native stream-json worker, session resume, profile subagents        |
| Claude Desktop / Code MCP     | Native installation and local management tools                      |
| Developer applications        | Authenticated jobs, workflows, audit and orchestration events       |

Source requires Node.js 24+. Native release CI uses official Node.js 26.3.0 on macOS arm64, Linux x64 and Windows x64. Other architectures need a separate build and acceptance check. Desktop extensions target macOS/Windows. Intel macOS packaging retains the unmodified runtime beside its launcher.

The OpenAI-compatible contract includes text Chat Completions, client function calls, structured output and buffered SSE. Responses and multimodal endpoints are outside this contract. Claude-defined native subagent configurations apply to Claude, not Codex. Bridge workflow checkpoints apply to both workers.

Default permissions are enabled. Managed client policies, installation consent and provider availability still apply. Jobs with unknown quota reset times stay paused for operator recovery. Download the native archive matching your operating system and architecture, then verify its checksum.

Official references: [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Claude programmatic CLI](https://code.claude.com/docs/en/headless).
