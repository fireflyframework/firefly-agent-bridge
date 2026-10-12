<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Verification

`npm run check` is the complete local release gate: TypeScript, ESLint, formatting, unit/integration tests, Python OpenAI/Pydantic AI clients, browser interactions, bundled build, notice/documentation/OpenAPI checks, scoped prose checks, strict private MkDocs build, platform packaging and clean-directory native MCP smoke test.

Deterministic tests cover transactional admission, principal isolation, idempotency, fenced attempts, restart recovery, pause/resume, cancellation, quota gates, workflow checkpoints, channel claims, audit retention and native subprocess bounds. Codex tests specifically cover ChatGPT readiness, alternate-billing rejection, native session continuity, explicit terminal success, audit provenance, default sandbox and unknown quota reset times.

Browser tests verify both theme palettes, system preference changes, theme-only storage, exact shared shell geometry, and mobile overflow. They also cover job conversations, workflows, token access, command/file inspections, event replay, keyboard use and 320 to 1440 pixel layouts. Screenshots are produced from the actual running console with deterministic fixtures.

The opt-in `npm run test:live:codex` records local evidence for a real official signed-in Codex worker. It creates and reads only a file in its job directory, resumes that same native thread, and verifies a standard Chat Completion. Evidence stays under ignored `work/` and contains no printed bearer credentials.

Provider login, CLI availability, managed policy, rate limits and host extension consent must be checked on the actual developer host. A deterministic test worker is not live provider acceptance. A successful native process exit alone is not job success; a completed validated turn is required. Native external actions still require reconciliation after uncertain outcomes.

## Private documentation

Install `docs/requirements.txt` into the Python environment selected by `BRIDGE_PYTHON`, then run `npm run docs:build`. The strict build writes `work/docs-site`; it has no public Pages deployment. Serve that directory on loopback for internal review. The builder stages normal Markdown links, canonical local assets, theme variants, fonts, and example files without publishing private brand-kit source.

The prose check catches a small set of editorial regressions outside code and links. It does not automate the Humanizer's contextual judgment. Manual review preserves technical claims, API labels, commands, and limitations while removing repetitive or promotional wording.

## 0.2.2 patch checks

The 0.2.1 release attempt stopped when repeated browser logins exhausted a shared test principal's request budget. That tag remains unpublished. Version 0.2.2 creates a separate owner principal for each default test login, with a regression proving distinct identities; production limits are unchanged.

The patch gate covers 103 unit/integration tests, seven real Python SDK compatibility cases against a deterministic worker, and 20 browser journeys. The new mobile navigation regression proves that switching views returns to the destination heading rather than keeping the previous panel's scroll position.

A separate isolated Chromium review covers all four provider-wizard steps and Diagnostics in light and dark at 320, 390, 1024, 1440, 1920 and 2560 pixels. The native local preview uses the official signed-in Codex worker for actual readiness checks; it submits no model jobs. Updated screenshots show the current wizard and Diagnostics. Existing subscription execution evidence below belongs to 0.2.0 and is not relabeled as a new patch acceptance.

Version and packaging checks include the CLI, HTTP, MCP, desktop/plugin manifests, installation examples, generated OpenAPI and embedded setup module. Release publication still depends on the complete three-platform native matrix and verified downloaded assets.

## 0.2.0 release checks

The local release checks cover 103 unit and integration tests, seven OpenAI/Pydantic AI SDK cases, and 13 browser journeys. Types, lint, formatting, generated API/version contracts, license notices, and the strict private documentation build also run before packaging. Native smoke checks compare CLI, HTTP, MCP, and Codex plugin release versions, then connect two stdio hosts to one authenticated service and inspect its embedded theme assets.

Browser screenshots use the running fixture service in light and dark at desktop and mobile widths. The shell keeps content in a scroll row and aligns desktop status and legal footer rows without covering forms. The footer regression compares connected and disconnected states in both themes at 1440, 1280, and 1024 pixels, plus a scaled 960-pixel viewport; borders, heights, and text positions match within one pixel. Fixture screenshots demonstrate console behavior; they do not claim that sample tasks ran against a provider.

Fresh official Codex subscription checks for this change verified file creation and reading inside a job directory, continuation of the same native session, a native packaged MCP submission, and a caller-owned `add(2,5)` function exchange returning `7`. The caller executed the function once, with no native inference actions. Claude subscription acceptance remains dependent on an authenticated developer host. ChatGPT remote MCP still requires the organization's reachable HTTPS gateway and supported authentication; no remote account connection is claimed.

The private release workflow must pass the complete native matrix on macOS arm64, Linux x64, and Windows x64 before publishing those assets. A local macOS package check does not establish the other two platforms.
