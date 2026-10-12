<!-- Copyright (c) 2026 Signature Management Consultants SLU; Author: @ancongui. Modified by Firefly Software Foundation for Firefly Agent Bridge (2026). SPDX-License-Identifier: Apache-2.0. -->

# Verification

`npm run check` is the complete local release gate: TypeScript, ESLint, formatting, unit/integration tests, Python OpenAI/Pydantic AI clients, browser interactions, bundled build, notice/documentation/OpenAPI checks, platform packaging and clean-directory native MCP smoke test.

Deterministic tests cover transactional admission, principal isolation, idempotency, fenced attempts, restart recovery, pause/resume, cancellation, quota gates, workflow checkpoints, channel claims, audit retention and native subprocess bounds. Codex tests specifically cover ChatGPT readiness, alternate-billing rejection, native session continuity, explicit terminal success, audit provenance, default sandbox and unknown quota reset times.

Browser tests cover job conversations, workflows, token access, command/file inspections, event replay, keyboard use and 320–1440 pixel layouts. Screenshots are produced from the actual running console with deterministic fixtures.

The opt-in `npm run test:live:codex` records local evidence for a real official signed-in Codex worker. It creates and reads only a file in its job directory, resumes that same native thread, and verifies a standard Chat Completion. Evidence stays under ignored `work/` and contains no printed bearer credentials.

Provider login, CLI availability, managed policy, rate limits and host extension consent must be checked on the actual developer host. A deterministic test worker is not live provider acceptance. A successful native process exit alone is not job success; a completed validated turn is required. Native external actions still require reconciliation after uncertain outcomes.
