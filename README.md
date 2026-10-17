<div align="center">

<img src="docs/assets/readme/agentflow-hero.svg" alt="AgentFlow: a task flows through the Agent Runtime, the Router, and twelve model providers to a verification step, with durable state held in sessions, the blackboard, and an append-only event log." width="100%">

**A terminal-first CLI that routes a coding task across twelve model providers, keeps the thread alive when one of them dies, and puts the answer on trial in a five-stage adversarial review.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](THIRD_PARTY_NOTICES.md)
[![Tests: 1336](https://img.shields.io/badge/tests-1336-blue.svg)](test)

[Quick start](#quick-start) · [Why AgentFlow](#why-agentflow) · [Architecture](#architecture) · [The Tribunal](#the-tribunal) · [Providers](#providers-and-local-models) · [Security](#trust-safety-and-verification)

</div>

---

**AgentFlow is an open-source coding agent for the terminal.** It fronts an
OpenAI-compatible model gateway with a routing engine that measures which models
actually answer, a durable session and project-state layer that survives a
provider switch, and a self-adversarial tribunal that reviews a proposal before
you act on it. It ships with **zero runtime dependencies** — the Node standard
library and nothing else — and runs straight from source on Node ≥ 20.

## The problem

A gateway hands you a catalogue of models. What it does not tell you is which of
them will answer *right now*.

Free-tier and aggregator endpoints are the worst offenders: the catalogue is
large, the credentials shared or expired, and a dead model often fails as a `200`
with an empty body rather than an error you can catch. Your tool reports success.

**Advertised** and **working** are different facts, and most tooling collapses
them into one. AgentFlow measures the gap — in `aflow doctor` (probes specific
models), in `aflow route` (walks a fallback order and records why each step
failed), and in the router itself, which orders candidates by observed health
rather than by the order a provider happened to list them. The same discipline
runs through the review layer: a proposal is a claim, and the tribunal exists to
test it rather than agree with it.

## See it working

No build step, no `npm install`. Clone it and run a diagnostic:

```sh
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow
node bin/aflow.js doctor
```

<img src="docs/assets/readme/agentflow-terminal.svg" alt="Real terminal output of node bin/aflow.js doctor: node and config are ok, provider keys and OAuth clients are unconfigured, and the gateway is unreachable; one problem is reported." width="100%">

<sub>Actual output, captured from this checkout on Node v24.19.0 (Windows). Long detail cells trimmed to fit the panel.</sub>

**What this proves:** the CLI runs with no install step, and `doctor` reports the
truth — environment, missing keys, and an unreachable gateway — instead of
failing silently or inventing success. The redaction chokepoint is visible too:
`aflow config` shows `apiKey ***` for a value that is set.

**What it does not prove:** that model-backed coding works. That requires a
provider credential and a running gateway — the next section gets you there. A
clean `doctor` is a statement about your setup, not about model quality.

## Why AgentFlow

These are the capabilities that are actually built today. Each is implemented in
`src/` and covered by the test suite; where something is partial or planned, the
[roadmap](#roadmap) says so.

| Capability | What it means for you |
|---|---|
| **Continuity across a dead provider** | When a model fails or returns an empty body, the next candidate answers. The conversation continues, context is intact, and the switch is recorded — you never retype a thing. Failover is a *decision*, not a blind retry: a write or shell command whose outcome is unknown pauses for approval instead of running twice (`src/core/continuity.js`). |
| **Health-aware routing** | The router orders candidates by observed health, not catalogue order, so a model that just failed cools down instead of being tried first. Failures are classified (empty, rate-limited, timeout, auth, …) before a switch is even considered. |
| **Self-contained gateway** | `aflow server` runs an OpenAI-compatible `/v1` endpoint inside the repo, with SSE translation and API-key/bind guards. Anything that speaks `/v1` can sit in front of it — including a `9Router` instance or Ollama. |
| **An adversarial tribunal** | Five bounded stages — Forge, Crucible, Merge, Trial, Oracle — review a proposal across models and return a verdict against a confidence gate. It fails *closed*: a run that cannot finish is `ABORTED`, never a quiet success. |
| **Durable, resumable state** | Sessions, a per-project Blackboard, and a structured JSONL event log live outside the repo. Resume with `aflow chat --resume <id>`. |
| **Safe tool execution** | The model is untrusted input. Permissions are enforced by allowlist, filesystem tools are confined to a resolved workspace root, and approvals fail closed (no TTY → deny). |
| **Zero runtime dependencies** | Nothing to audit, nothing to install for the tests to run, no transitive supply chain. |

## Quick start

**Requirements:** Node.js **≥ 20** ([CI](.github/workflows/test.yml) runs 20, 22,
and 24). No `npm install` is required to run the CLI or the test suite.

```sh
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow

node bin/aflow.js --version      # aflow 0.3.0
node bin/aflow.js doctor         # environment + reachability check
```

### Configure a provider

The fastest path is the wizard. It tests a key against the provider **before**
writing it, and stores keys in a single owner-only `keys.env` under your state
directory — never in the repo, never in your shell history.

```sh
node bin/aflow.js setup          # pick a provider, paste a key, it is verified, then saved
node bin/aflow.js setup --check  # probe every configured provider and report reachability
```

Eleven hosted providers are free to start and need no credit card (Groq,
Cerebras, Mistral, Gemini, OpenRouter, Cloudflare, Hugging Face, Together,
Fireworks, DeepInfra, SambaNova). Prefer to stay fully local? Install
[Ollama](https://ollama.com), pull a model, and AgentFlow will use it with no key
at all:

```sh
ollama pull llama3.1
node bin/aflow.js setup --check    # ollama should now report reachable
```

### Run something useful

```sh
node bin/aflow.js chat                                   # interactive session
node bin/aflow.js chat --resume <session-id>             # pick the thread back up
node bin/aflow.js route "explain this stack trace"       # one completion through the fallback cascade
node bin/aflow.js agent run coder "add a --dry-run flag" # a bounded agent task
node bin/aflow.js tribunal run "Should we use microservices for a team of 3?"
node bin/aflow.js dashboard                              # live status board (full-screen, read-only)
```

Inside a session you never leave the terminal to look around. `/diff` opens a
keyboard-driven reviewer over uncommitted workspace changes; `/timeline` browses
the session's entry stream; `/swarm` draws the agent-handoff graph; `/context`,
`/add`, `/drop`, and `/compact` manage what is in the prompt. `/tribunal` and
`/agent` run the tribunal or a bounded agent task inline.

Full command surface: `aflow --help`. Configuration precedence, low → high:
`defaults < global file < project file < AGENTFLOW_* env < flags`.

## Architecture

<img src="docs/assets/readme/agentflow-architecture.svg" alt="AgentFlow architecture: the aflow CLI above a control plane of Configuration, Agent Runtime, and Tribunal, beside durable state; below them the Router and ProviderHealth feed an OpenAI-compatible gateway that reaches eleven hosted providers plus local Ollama." width="100%">

A single request flows **CLI → runtime → router → gateway → provider**. The
runtime drives the model↔tool loop for an agent; the router walks quality tiers
and reorders them by observed health; the gateway speaks the OpenAI `/v1` wire
either in-repo (`aflow server`) or against an external gateway. Tribunal runs
hang off the runtime, and every write to a session, the Blackboard, or the event
log passes through one redaction chokepoint first.

`src/` is AgentFlow's own code. The model-facing routing/translation engine under
`open-sse/` is inherited from 9Router (MIT) and adapted — see
[Project origin](#project-origin-and-license). A module-by-module map lives in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Capabilities

**Runtime** — eight built-in agents (`planner`, `coder`, `reviewer`, `debugger`,
`tester`, `researcher`, `security`, `release`), each a *declaration* with a
narrow tool scope rather than a prompt with a name. The `reviewer` and `security`
agents are read-only by design: an agent that can edit is not an independent
check. Bounded iterations, tool calls, and wall-clock limits; enforced output
contracts.

**Routing** — a fallback cascade with failure classification, candidate
ordering, and a `ProviderHealth` circuit breaker that the runtime constructs and
feeds. Continuation is deliberate about what it will *not* replay.

**Task state** — persistent sessions (atomic writes, corruption-safe), a
per-project Blackboard (goal, tasks, decisions, blockers, bugs, findings, tests,
timeline), and an append-only JSONL event log. All stored outside the repo and
redacted before they are written.

**Security** — allowlist permissions resolving
`deny → scope approval → allow → ask → deny`, workspace path containment,
fail-closed approvals, and redaction by field name *and* by value shape. See
[Trust, safety, and verification](#trust-safety-and-verification).

**Verification** — the five-stage tribunal below, plus `doctor`/`models` live
reachability probing.

## The Tribunal

A model asked to check its own work tends to agree with itself. The tribunal is
the answer to that: a proposal is treated as a defendant and run through five
adversarial stages, each able to kill it.

<img src="docs/assets/readme/agentflow-tribunal.svg" alt="The five tribunal stages left to right: Forge self-review, Crucible cross-examination, Merge hybrid synthesis, Trial prosecution, and the Oracle confidence gate. The Trial can send the hybrid back to Merge on CONVICTED_RETRY." width="100%">

Forge reviews a proposal against itself. Crucible cross-examines it from four
adversarial vectors and scores its survival; every finding must carry a
falsifiable proof. Merge synthesizes the survivors into a hybrid with provenance
tracked per element. Trial prosecutes the hybrid for merge-specific faults and
can send it back for another merge. Oracle weighs all five scores — self `0.15`,
survival `0.25`, merge `0.20`, trial `0.30`, validation `0.10` — against a
`0.95` gate and returns `VERIFIED`, `INSUFFICIENT_CONFIDENCE`, `REJECTED`, or
`ABORTED`.

The real command surface:

```console
$ node bin/aflow.js tribunal run "<proposal>" [--domain DOMAIN] [--model ID[,ID]]
$ node bin/aflow.js tribunal history [--limit N]
$ node bin/aflow.js fight "<proposal>"        # alias for: tribunal run
$ node bin/aflow.js --tribunal "<proposal>"   # alias for: tribunal run
```

**Read the confidence number correctly.** It is a weighted blend of the stages'
own scores — consistent and reproducible for a given run, but **not a calibrated
probability**. The fight card prints the weights and the findings behind the
score precisely so you can argue with them, and it carries this caveat itself.
Two invariants keep the number honest: the verdict and the confidence cannot
disagree (a `VERIFIED` report below `0.95` is rejected by the validator), and
**a failing executed test overrides any confidence value** — the outcome becomes
`TESTS_FAILED`, not a number.

Two further limits matter. First, **the stages may run on the same model**, so
"self-review" is genuine self-critique, not an independent second opinion; the
diagram does not pretend otherwise. Second, **it fails closed** — an unreadable
model output becomes a named `INVALID_*` finding or an `ABORTED` run, never a
crash and never a silent pass. The full confidence model, verdict vocabulary,
and invariants are in [`docs/TRIBUNAL.md`](docs/TRIBUNAL.md).

## Providers and local models

Every provider below is OpenAI-compatible. `aflow setup` writes the key to a
single owner-only `keys.env`; the exact env-var names and model-id resolution
rules live in [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

| Provider | Model id prefix | Free to start |
|---|---|---|
| Groq | `groq/` | free tier, no credit card |
| Cerebras | `cerebras/` | free tier, no credit card |
| Mistral | `mistral/` | free tier (rate-limited) |
| Google Gemini | `gemini/` | free tier, no credit card |
| OpenRouter | `openrouter/` | free models available |
| Cloudflare Workers AI | `cloudflare/` | 10,000 neurons/day |
| Hugging Face Inference | `hf/` | shared rate limit |
| Together AI | `together/` | $5 signup credit |
| Fireworks AI | `fireworks/` | $1 signup credit |
| DeepInfra | `deepinfra/` | free tier available |
| SambaNova | `sambanova/` | free tier available |
| **Ollama** (local) | `ollama/` | unlimited, no key |

Address a model by prefix (`groq/llama-3.3-70b-versatile`), or leave it off and
let AgentFlow infer the provider from the model id's shape when only one
provider can serve it. `process.env` always overrides the keys file. A missing
remote credential fails loudly — the error names the exact variable — and
`/v1/models` only advertises a provider once its credential is present.

> **Local-only operation.** Point AgentFlow at a local Ollama and no hosted key
> is configured; requests resolve to `ollama/`. This is a configuration property,
> not a verified network egress guarantee — review the provider resolution in
> `src/core/gateway-server.js` if strict local-only behaviour is a requirement
> for you.

## Configuration and examples

Configuration resolves in five layers (`aflow config` shows the effective value
and its origin):

```sh
node bin/aflow.js config                 # effective config, with origin per key
node bin/aflow.js config --json          # machine-readable; apiKey renders as ***
node bin/aflow.js models                 # list models by provider (needs a gateway)
node bin/aflow.js models --probe         # additionally probe reachability
```

```sh
node bin/aflow.js init                   # write a starter .agentflow.json
node bin/aflow.js sessions               # list persistent sessions
node bin/aflow.js blackboard             # durable project workflow state
node bin/aflow.js logs --limit 20        # read the structured event log
```

`keys.env` lives under the platform state directory
(`%LOCALAPPDATA%\agentflow` on Windows, `~/Library/Application Support/agentflow`
on macOS, `$XDG_STATE_HOME/agentflow` elsewhere), overridable with
`AGENTFLOW_STATE_DIR`. Reference documentation is kept in the repo rather than
duplicated here: [`ARCHITECTURE.md`](ARCHITECTURE.md),
[`docs/PROVIDERS.md`](docs/PROVIDERS.md), [`docs/TRIBUNAL.md`](docs/TRIBUNAL.md).

## Trust, safety, and verification

Security controls exist; they are not a promise that nothing can go wrong.

- **Redaction at one chokepoint.** `src/core/redact.js` masks by field name *and*
  by value shape (bearer tokens, `sk-…`, `GOCSPX-…`, JWTs, `ghp_…`). A
  credential-shaped value that survives redaction is refused rather than stored.
- **Untrusted by default.** Model output, tool results, and fetched files are
  treated as data, not instructions. Permissions are enforced by allowlist, not
  by prompt text, and approvals **fail closed** when there is no TTY.
- **Workspace containment.** Filesystem tools are confined to a workspace root
  resolved to a physical path before a run, and it cannot be widened from inside.
- **Secret scanning in CI.** `npm run scan-secrets` scans the working tree;
  `--history` scans every reachable blob. Both run in
  [CI](.github/workflows/test.yml). Passing a shape-and-context scanner is scoped
  evidence, not proof that no credential exists.
- **Honest about upstream risk.** The upstream credential exposure at
  `decolua/9router` (advisory **GHSA-35rj-mq32-7gcj**) is that project's to
  rotate; AgentFlow replaced the hardcoded values during import and tracks the
  remaining public exposure with `scripts/check-exposure.mjs`, whose CI job is
  **intentionally red** until rotation is confirmed. A fresh clone being clean is
  not the same as the credentials being revoked. Full account, including what was
  purged and what is still outstanding, in [`SECURITY.md`](SECURITY.md).

Not claimed: "secure", "zero vulnerabilities", or "safe". Read
[`SECURITY.md`](SECURITY.md) before pointing AgentFlow at an untrusted gateway.

## Quality

- **1,336 tests** (`npm test`) across routing, continuity, the five tribunal
  stages, the gateway and its SSE translation, the session/Blackboard stores, the
  agent runtime and tools, redaction, and every command — **1,334 passing, 2
  skipped, 0 failing** on Node v24.19.0 at the time of writing. Run `npm test`
  for the current count; [CI](.github/workflows/test.yml) runs the suite on Node
  20, 22, and 24.
- **Zero runtime dependencies** — Node builtins only. Dev tooling (ESLint,
  TypeScript) is pinned via the lockfile.
- **Blocking gates**: `npm run lint` and `npm run typecheck` must both pass
  before a change lands. Neither is advisory.

## Development and contribution

```sh
npm test              # node:test suite; no install required
npm install           # dev tooling: eslint, typescript, @types/node
npm run lint          # eslint
npm run typecheck     # tsc --noEmit (JSDoc-checked)
npm run scan-secrets  # credential scan of the working tree
```

The project is ESM-only, Node ≥ 20, and dependency-free in production. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the branch and commit conventions, and
[`docs/DEBT_LEDGER.md`](docs/DEBT_LEDGER.md) for known, deferred debt.

## Roadmap

Pre-release (**0.3.0**). Planned, not yet built — listed so the line between today
and later is explicit:

- A unified full-screen TUI workspace (the read-only `dashboard` status board
  exists; an interactive workspace does not)
- Repository map / code-graph view and in-session git workflows
- Plugin loader for third-party agents and tools
- Agent orchestration (running several agents together)
- SQLite persistence and OAuth provider flows (upstream components not imported)

## Project origin and license

AgentFlow is derived from **9Router** (`decolua/9router`, commit `a99cf572`, tag
`v0.5.95`, MIT). The provider/routing engine and gateway were inherited; the
routing policy, tribunal, session, and continuity layers are this project's own.
Provenance is carried by documentation rather than history — the repository
begins from an independent initial commit, because copying upstream history would
republish credentials upstream must still rotate. Full account in
[`PROJECT_ORIGIN.md`](PROJECT_ORIGIN.md); inherited notices in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Licensed under the [MIT License](LICENSE).

<div align="center">

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Architecture](ARCHITECTURE.md) · [Tribunal](docs/TRIBUNAL.md) · [Providers](docs/PROVIDERS.md) · [Origin](PROJECT_ORIGIN.md) · [MIT License](LICENSE)

<br>

If AgentFlow saves you one dead-provider mystery, a star helps other developers find it.

[github.com/anand-cpp/AgentFlow](https://github.com/anand-cpp/AgentFlow)

</div>
