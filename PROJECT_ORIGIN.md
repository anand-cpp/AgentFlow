# Project Origin

AgentFlow is derived from **9Router**. This document records exactly what came from where, so
that no contributor is misattributed and no upstream work is claimed as original.

## Upstream

| Field | Value |
|---|---|
| Project | 9Router |
| Repository | https://github.com/decolua/9router |
| Commit | `a99cf572` (tag `v0.5.95`) |
| License | MIT |
| Copyright | Copyright (c) 2024-2026 decolua and contributors |
| Primary author | `decolua` |

9Router itself aggregates work from roughly 350 further contributors across 1,364 commits. The
upstream repository remains the authoritative record of that history and is configured as the
`upstream` remote in this repository.

## How history is structured in this repository

This repository begins from an independent `Initial commit` and does **not** carry 9Router's
1,364 upstream commits. Provenance is therefore carried by documentation rather than by history:

- This file — what is inherited, modified, or new.
- `AUDIT/UPSTREAM_CODE_MAP.md` — path-level provenance ledger.
- `LICENSE` — retains the upstream MIT copyright notice alongside this project's own notice.

The upstream commit remains fetchable at any time:

```sh
git fetch upstream
git show a99cf572:open-sse/handlers/chatCore.js
```

### Why history was not copied

Copying upstream history would republish committed OAuth client credentials that GitHub's push
protection correctly blocks. Those credentials exist in 9Router's history and in parts of its
source tree; they belong to upstream and are not this project's to redistribute. See
`AUDIT/LICENSE_AUDIT.md`.

## Retained from upstream (MIT, attribution required)

The routing and provider engine is the substantive foundation. Status is
recorded honestly: *Inherited* means the files are on `main` as imported;
*Not yet imported* means it exists upstream and is still to be brought across.

| Component | Path | Status |
|---|---|---|
| Provider-agnostic routing/translation engine | `open-sse/` | Inherited |
| Request handler, retry, token refresh | `open-sse/handlers/chatCore.js` | Inherited |
| Per-provider executors | `open-sse/executors/` | Inherited |
| Format translators | `open-sse/translator/` | Inherited |
| Provider registry (132 providers registered) | `open-sse/providers/registry/` | Inherited |
| `tool_result` token compression | `open-sse/rtk/` | Inherited |
| CLI entry point | `bin/aflow.js` | Adapted from upstream CLI |
| SQLite persistence layer | `src/lib/db/` | Not yet imported |
| OAuth provider flows | `src/lib/oauth/` | Not yet imported |
| Standalone server + client-IP hardening | `custom-server.js` | Not yet imported |
| Test suite | `tests/` (upstream) | Not yet imported — AgentFlow keeps its own suite under `test/` (38 files) |

### Modifications made to inherited code

All of these replace hardcoded third-party credentials with environment-sourced
values. Each is annotated in the file itself.

| File | Change |
|---|---|
| `open-sse/providers/shared.js` | Added `oauthClientFromEnv()` / `oauthClientConfigured()`; added per-provider OAuth clients for Google, Antigravity, iFlow, Windsurf |
| `open-sse/providers/registry/gemini.js` | Inline OAuth client replaced with imported constant |
| `open-sse/providers/registry/gemini-cli.js` | Inline OAuth client replaced with imported constant |
| `open-sse/providers/registry/antigravity.js` | Inline OAuth client replaced with imported constant |
| `open-sse/providers/registry/iflow.js` | Hardcoded iFlow OAuth client id/secret replaced with env-sourced client |
| `open-sse/providers/registry/windsurf.js` | Hardcoded Windsurf OAuth client id and Firebase API key replaced with env-sourced values |

Credential shapes removed: Google OAuth client id/secret, Antigravity OAuth
client id/secret, iFlow OAuth client id/secret, Windsurf OAuth client id, and a
Windsurf Firebase web API key. See `SECURITY.md` for how the last two were
missed by the initial targeted scan and caught by a broader sweep.

## Newly written for AgentFlow

No upstream equivalent exists for any of the following. Built items name the
files that implement them.

**Built**

- Terminal CLI command router and command surface — `src/cli/`, `src/commands/`
- `doctor` diagnostics, secret redaction, TUI dashboard — `src/commands/doctor.js`,
  `src/core/redact.js`, `src/tui/dashboard.js`
- `aflow` bin entry, config hierarchy with documented precedence — `bin/aflow.js`,
  `src/config/index.js`
- Committed-credential scanner run in CI — `scripts/scan-secrets.mjs`,
  `.github/workflows/test.yml`
- Session manager and conversation history — `src/core/sessions.js`
- Blackboard (durable per-project workflow state) — `src/core/blackboard.js`
- Routing policy engine with observable structured events — `src/core/routing.js`,
  `src/core/events.js`
- Provider health / circuit breaker — `src/core/provider-health.js`
- Agent runtime and eight built-in agents — `src/core/agents/runtime.js`,
  `src/core/agents/definitions.js`, `src/core/agents/registry.js`
- Tool registry and permission/approval system — `src/core/agents/tools.js`,
  `src/core/agents/real-tools.js`
- Self-adversarial tribunal, all five stages (Forge/self-review, Crucible
  cross-examination, Merge synthesis, Trial prosecution, Oracle confidence gate),
  the full-pipeline orchestrator, and the ANSI fight-card renderer —
  `src/core/tribunal/`
- `aflow tribunal`, `aflow tribunal history`, and the `fight` alias — the CLI
  surface over the tribunal pipeline — `src/commands/tribunal.js`
- Standalone in-repo OpenAI-compatible gateway with SSE translation and
  API-key/bind guards, plus its lifecycle command — `src/core/gateway-server.js`,
  `src/commands/server.js`

**Not started**

- Agent orchestration (running several agents together) — the runtime bounds a
  single agent's recursion depth, but there is no multi-agent orchestrator
- Plugin architecture
- Automatic cross-provider switching wired into the runtime — the primitives
  (`src/core/provider-health.js`, continuity/session support) exist, but
  `AgentRuntime` does not yet construct `ProviderHealth` and pass it to the
  `Router` (Blackboard task `t7`)
- SQLite persistence and OAuth provider flows — upstream components not imported

## Architectural references studied (no code incorporated)

| Project | License | Use |
|---|---|---|
| [OpenCode](https://github.com/anomalyco/opencode) | MIT | Permission ruleset design, tool registry shape, config layering |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Tool-execution pipeline, composable config layers, defensive patterns |

Both licenses were verified before study. Architectural ideas were studied; **no source code was
copied from either project.** Findings are recorded in `AUDIT/OPENCODE_STUDY.md` and
`AUDIT/DEEPSEEK_HARNESS_STUDY.md`.

## Excluded

No code, weights, prompts, assets, or dependencies from https://github.com/QwenLM/Qwen are
included in this project.

## Status

Pre-release (`0.1.0`). Status as of 2026-10-11. The routing engine and the
`aflow` CLI are built and tested, as are the session and Blackboard stores, the
agent runtime with its tool registry and permission system, provider health, the
standalone in-repo gateway, and all five stages of the self-adversarial tribunal.
Run `npm test` for the current count. The plugin loader, automatic cross-provider
switching in the runtime, agent orchestration, and the un-imported upstream
SQLite/OAuth components are not yet built. See `AUDIT/` for the full evidence
base and `AUDIT/FEATURE_AUDIT.md` for verified capabilities and known gaps.