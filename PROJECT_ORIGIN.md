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

The routing and provider engine is the substantive foundation:

| Component | Path | Status |
|---|---|---|
| Provider-agnostic routing/translation engine | `open-sse/` | Inherited |
| Request handler, retry, token refresh | `open-sse/handlers/chatCore.js` | Inherited |
| Per-provider executors | `open-sse/executors/` | Inherited |
| Format translators | `open-sse/translator/` | Inherited |
| Provider registry (~125 providers) | `open-sse/providers/registry/` | Inherited |
| `tool_result` token compression | `open-sse/rtk/` | Inherited |
| SQLite persistence layer | `src/lib/db/` | Inherited |
| OAuth provider flows | `src/lib/oauth/` | Inherited |
| Standalone server + client-IP hardening | `custom-server.js` | Inherited |
| Test suite | `tests/` | Inherited |

## Newly written for AgentFlow

No upstream equivalent exists for any of the following:

- Terminal CLI command router and command surface
- Agent runtime and built-in agents
- Agent orchestration
- Tool registry and permission/approval system
- Plugin architecture
- Session manager and conversation history
- Provider adapter interface and provider-neutral model registry
- Routing policy engine with observable structured events
- `doctor` diagnostics, structured logging, secret redaction

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

Pre-release. Audit phase complete; implementation not yet started. See `AUDIT/` for the full
evidence base and `AUDIT/FEATURE_AUDIT.md` for verified capabilities and known gaps.