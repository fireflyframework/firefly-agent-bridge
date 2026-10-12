<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Changelog

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
