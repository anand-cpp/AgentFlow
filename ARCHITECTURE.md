# AgentFlow — Architecture

Dense reference for how the code is actually organised. Every statement here
reflects the code on `main` at the time of writing; where something is not yet
built it is marked as such. For provenance and upstream derivation see
[`PROJECT_ORIGIN.md`](PROJECT_ORIGIN.md); for the security model see
[`SECURITY.md`](SECURITY.md).

## Overview

AgentFlow is a terminal-first CLI (`aflow`) that fronts an OpenAI-compatible model
gateway. It exposes a routing/fallback engine, a persistent session store, a
per-project "Blackboard" for durable workflow state, a bounded, registry-driven
agent runtime with a scoped tool permission model, a five-stage self-adversarial
tribunal, and a standalone in-repo gateway. It ships **zero runtime
dependencies** (Node builtins only, Node ≥ 20) and runs directly from source with
no build step. The gateway can be an external OpenAI-compatible server (a 9Router
instance by default) or the bundled one, started with `aflow server`.

## Repository structure

```
bin/            aflow entry point (bin/aflow.js)
src/
  cli/          argv parsing, command registry, output + ANSI colour
  commands/     one module per top-level command (13 commands)
  config/       layered configuration resolution
  core/         domain logic (routing, gateway, sessions, blackboard, …)
    agents/     agent runtime, registry, tools, permissions, bounds
    tribunal/   five adversarial stages, schemas, oracle gate, fight-card renderer
    gateway-server.js  standalone in-repo OpenAI-compatible gateway
  tui/          hand-rolled ANSI dashboard (no TUI framework)
open-sse/       imported 9Router routing/translation engine (402 files)
test/           Node built-in test runner suite (38 files)
scripts/        test runner, secret scan, exposure check
config/         exposure.json (known public-exposure tracker)
AUDIT/          upstream audits and study documents
.github/        CI workflows
```

`open-sse/` is inherited from 9Router (MIT) and is the substantive model-facing
engine; the `src/` tree is AgentFlow's own code.

## Core modules (`src/core/`)

| Module | Responsibility |
|---|---|
| `routing.js` | Fallback cascade: failure classification, candidate ordering, `Router`, provider health-aware ordering |
| `provider-health.js` | Circuit-breaker/health tracking for providers (consumed by the router via injection) |
| `gateway.js` | HTTP client for the OpenAI-compatible gateway: `getVersion`, `listModels`, `probeModel`, `ping`, `complete` |
| `gateway-server.js` | Standalone in-repo OpenAI-compatible gateway: routing, SSE translation, API-key/bind guards, lifecycle |
| `sessions.js` | Durable per-project session store (atomic writes, append lock, typed entries) |
| `blackboard.js` | Durable per-project workflow state (goal, tasks, decisions, blockers, bugs, findings, tests, timeline) |
| `persist.js` | Atomic JSON read/write helper shared by the stores |
| `events.js` | Append-only JSONL event log and event-type constants |
| `redact.js` | Credential redaction by field name and by pattern; refuses values that survive redaction |

### Agent subsystem (`src/core/agents/`)

| Module | Responsibility |
|---|---|
| `registry.js` | Declarative agent definitions: capabilities, tool scopes, state, limits |
| `definitions.js` | The eight built-in agents: planner, coder, reviewer, debugger, tester, researcher, security, release |
| `runtime.js` | `AgentRuntime`: the bounded model↔tool iteration loop, state, timeouts, output-contract enforcement |
| `tools.js` | Tool registry, permission evaluation, `runTool` |
| `real-tools.js` | Concrete tool wiring (filesystem, shell) |
| `tool-filesystem.js`, `tool-shell.js`, `tool-paths.js` | Tool implementations and path containment |
| `tool-bounds.js`, `tool-errors.js` | Bound enforcement and error shapes |
| `workspace.js` | Workspace root resolution (resolved to a physical path, not negotiable mid-run) |
| `context.js` | Context assembly for a run |
| `requirements.js` | Model-hint inference and requirement checking |

### Tribunal (`src/core/tribunal/`)

| Module | Responsibility |
|---|---|
| `review-schema.js` | Self-review schema, validation (fail-closed), finding classification |
| `confidence.js` | Confidence-downgrade policy; a failing executed test overrides confidence |
| `self-review.js` | Identity-blind self-review call: prompt build, parse, validate |
| `stage.js` | Bounded self-review stage over a set of candidates (Forge) |
| `crucible.js`, `crucible-schema.js`, `stage-crucible.js` | Cross-examination from four attack vectors, each finding carrying a falsifiable proof |
| `merge.js`, `merge-schema.js`, `stage-merge.js` | Hybrid synthesis of surviving proposals with provenance tracking and finding resolution |
| `trial.js`, `trial-schema.js`, `stage-trial.js` | Prosecution of the hybrid for merge-specific vectors, with a bounded retry loop |
| `oracle.js`, `oracle-schema.js`, `stage-oracle.js` | Weighted confidence gate (VERIFIED / INSUFFICIENT_CONFIDENCE / REJECTED / ABORTED), battle report, and the full-pipeline orchestrator `runFullTribunal` |
| `formatter.js` | ANSI fight-card renderer over a pipeline result |

The orchestrator runs the five stages in order and terminates early (cascading
`SKIPPED`, then an `ABORTED` oracle) when the Crucible kills every proposal. A
`aflow tribunal run` command builds the candidate proposals, drives the pipeline
with a mock-injectable `completeFn`, prints the fight card, and records the run
in the session store.

## Data flow

```
user
 │  aflow <command> [flags]
 ▼
bin/aflow.js ──► src/cli/index.js  (parse argv, resolve command)
 │                       │
 │                       ▼
 │              src/commands/<cmd>.js
 │                       │
 │        ┌──────────────┼───────────────────────────┐
 │        ▼              ▼                            ▼
 │   config/index.js  core services              agent runtime
 │   (5-layer         ├ routing.js + provider-health.js   │
 │    precedence)     ├ sessions.js / blackboard.js       │
 │                    ├ events.js (JSONL log)             │
 │                    └ redact.js (before any write)      │
 │                              │                          │
 │                              ▼                          ▼
 │                        gateway.js ───────────► HTTP  (OpenAI-compatible)
 │                              │                  external gateway, e.g.
 │                              ▼                  http://localhost:20127
 │                        model completion
 ▼
stdout / stderr   (human text, or --json)
```

For `aflow route`, the `Router` walks a fallback order, consulting provider
health, and calls `gateway.complete()` on the first candidate that returns
content. For `aflow agent run`, the `AgentRuntime` drives repeated model calls
and interleaves tool calls; each tool call passes the permission check before
dispatch and is logged before it runs. For `aflow tribunal`, the command builds
candidate proposals, runs the five-stage pipeline, and renders the result. When
`aflow server` is running, `gateway.js` talks to `gateway-server.js` on the same
OpenAI-compatible interface it uses for an external gateway — the two are
interchangeable from the client's side.

## State locations

AgentFlow writes state outside the repository, under the platform state directory:
`AGENTFLOW_STATE_DIR` if set, else `%LOCALAPPDATA%\agentflow` on Windows,
`~/Library/Application Support/agentflow` on macOS, and
`$XDG_STATE_HOME`/`~/.local/state/agentflow` elsewhere:

| State | Location |
|---|---|
| Sessions | `<state-dir>/sessions/` — one JSON file per session |
| Blackboard | `<state-dir>/blackboard/<id>.state.json` + `<id>.events.jsonl` |
| Event log | `<state-dir>/agentflow.jsonl` (override with `AGENTFLOW_LOG_PATH`/`--file`) |

Configuration is read from a global file (platform config dir: `%APPDATA%\agentflow`
on Windows, `~/.config/agentflow` elsewhere) and a project file
(`.agentflow.json`, discovered by walking up from the working directory), plus
`AGENTFLOW_*` environment variables and CLI flags. Precedence, low to high:

```
defaults < global file < project file < AGENTFLOW_* env < flags
```

Every value written to any of the above passes through `src/core/redact.js` first.

## Implemented vs. planned

**Implemented and tested**

- CLI command router and the 13 commands (`doctor`, `models`, `status`, `config`,
  `init`, `sessions`, `blackboard`, `agent`, `route`, `tribunal`, `server`,
  `logs`, `dashboard`) plus the `fight` alias
- Configuration hierarchy with documented precedence and walk-up discovery
- Routing engine + fallback cascade + provider health (`routing.js`,
  `provider-health.js`)
- Gateway client and live reachability probing
- Standalone in-repo OpenAI-compatible gateway with SSE translation and
  API-key/bind guards, and its `aflow server` lifecycle command
- Session store and Blackboard (atomic writes, corruption-safe, redaction)
- Structured JSONL event log
- Secret redaction across output, logs, sessions, and Blackboard
- Agent runtime and eight built-in agents, with scoped tool permissions,
  approvals, bounds, and output contracts
- Self-adversarial tribunal, all five stages (Forge, Crucible, Merge, Trial,
  Oracle), the full-pipeline orchestrator, and the fight-card CLI

**Not built**

- Plugin loader / plugin architecture
- Automatic cross-provider switching wired into `AgentRuntime` — the primitives
  exist (`provider-health.js`, continuity support), the runtime integration does
  not (Blackboard task `t7`)
- Agent orchestration (running several agents together)
- SQLite persistence and OAuth provider flows (upstream components not imported)

## Security model

Summary (full detail in [`SECURITY.md`](SECURITY.md)):

- The model is treated as untrusted. Permissions are enforced by allowlist, not by
  prompt instructions; entries resolve `deny → scope approval → allow → ask → deny`.
- Approvals **fail closed**: with no TTY, gated tool actions are refused.
- Every value printed or persisted passes through `src/core/redact.js`; a
  credential-shaped value that survives redaction is refused rather than stored.
- Filesystem tools are confined to a workspace root that is resolved to a physical
  path before a run and cannot be widened from inside it.
- The imported `open-sse/` engine carried hardcoded third-party credentials, which
  were replaced with environment-sourced values during import; two known public
  exposures remain tracked in `config/exposure.json` until the upstream owner
  rotates them.

## Testing strategy

Tests use the Node built-in test runner, discovered and run by
`scripts/run-tests.mjs`; run them with `npm test`. The suite does not touch the
network — live probing is exercised separately by `aflow doctor` against a running
gateway. Coverage areas include config precedence, argv parsing, command
registration, the event log, redaction, persistence, routing, provider health,
sessions, the Blackboard, the agent runtime and its tools, the standalone gateway
and its SSE translation, and all five tribunal stages including the full pipeline.
For the current pass/fail count, run `npm test`.
