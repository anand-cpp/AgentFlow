<div align="center">

```
▄▀█ █▀▀ █▀▀ █▄█ ▀█▀ █▀▀ █   █▀█ █ █
█▀█ █▄█ ██▄ █ █  █  █▀  █▄▄ █▄█ ▀▄▀
```

**A terminal-first CLI that routes work across many models — and tells you which of them actually answer.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](THIRD_PARTY_NOTICES.md)

</div>

---

### The tribunal puts a proposal on trial before you commit to it.

Five stages. Five models. One verdict, with a confidence score you can argue with.

```
$ aflow tribunal run "Should we use microservices for a team of 3?"

╔══════════════════════════════════════════════════════════════════╗
║  TRIBUNAL FIGHT CARD                                             ║
║                                                                  ║
║  id       ea1b9d40-2c7f-4c1e-9c2b-7a5f0d3e8b41                   ║
║  domain   architecture                                           ║
║  started  2026-10-15 17:25                                       ║
║  finished 2026-10-15 17:26                                       ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 1 · FORGE  self-adversarial review                        ║
║  proposal-1           -                reviewed  conf 0.62 → 0.91║
║                                                                  ║
║  1 candidate(s) · 1 reviewed · 0 unreadable · 0 revised          ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 2 · CRUCIBLE  cross-examination                           ║
║  proposal-1  survival 0.90  2 finding(s)                         ║
║    P2 · scope  Hybrid omits the rollback path                    ║
║    P3 · evidence  No benchmark cited for the claim               ║
║                                                                  ║
║  2 finding(s) across 1 report(s) · avg survival 0.90             ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 3 · MERGE  hybrid synthesis                               ║
║  status   COMPLETED                                              ║
║  gate     Two proposals — synthesizing a hybrid                  ║
║  decision SYNTHESIZED                                            ║
║  elements 3                                                      ║
║    e1 from proposal-1, proposal-2                                ║
║    e2 from proposal-1                                            ║
║    e3 from proposal-2                                            ║
║  findings                                                        ║
║    f1 ADDRESSED                                                  ║
║    f2 DISPUTED                                                   ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 4 · TRIAL  prosecution                                    ║
║  status   COMPLETED                                              ║
║  verdict  ACQUITTED                                              ║
║  no findings raised by the prosecutor                            ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 5 · ORACLE  the gate                                      ║
║   VERIFIED   confidence 96.5%                                    ║
║  Five stage scores weighed; every validation check passed.       ║
║  findings P0 0 · P1 0 · P2 2 · P3 1 · unresolved critical 0      ║
║                                                                  ║
║  weights self 0.15 · survival 0.25 · merge 0.20 · trial 0.30 · v…║
║  scores  self 0.93 · survival 0.90 · merge 1.00 · trial 1.00 · v…║
║                                                                  ║
║  validation checks                                               ║
║    ✓ schema     report conforms to the oracle schema             ║
║    ✓ threshold  confidence 0.965 ≥ gate 0.95                     ║
║                                                                  ║
║  caveats                                                         ║
║    ! Confidence is a weighted blend, not a calibrated probabilit…║
╚══════════════════════════════════════════════════════════════════╝
```

One command. A verdict, the findings behind it, and the exact weights that
produced the score — so you can see *why* the tribunal trusts the answer, not
just that it does.

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
rather than by the order a provider happened to list them.

## Quick start

No build step. No `npm install`. Zero runtime dependencies — it runs on the Node
standard library alone. Clone it and go:

```sh
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow
node bin/aflow.js setup --check
```

```
$ node bin/aflow.js setup --check

keys file: C:\Users\anand\AppData\Local\agentflow\keys.env
  · ollama                 fetch failed

No hosted providers are configured yet — run `aflow setup`.
```

`setup` writes keys to a single `keys.env` under your state directory — never to
the repo, never to your shell history. Run the wizard once, add any of the free
providers, and you are routing.

```sh
node bin/aflow.js setup      # wizard: pick a provider, paste a key, it is tested before it is saved
node bin/aflow.js chat       # start a session
```

```
$ node bin/aflow.js chat

aflow chat · coder · no model · session ses_20261015T172503281Z_93qr3p (new)
workspace C:\Users\anand\9router (git)
type /help for commands, /quit to exit. Ctrl+C cancels a response.

>
```

## Installation

Three ways in, from least to most involved.

**npm** (recommended). Installs the `agentflow` command, with `aflow` kept as an
alias:

```sh
npm install -g agentflow-cli
aflow doctor       # proves the install before you configure anything
```

**Single-file binary.** No Node required. Download the executable for your
platform from the [latest release](https://github.com/anand-cpp/AgentFlow/releases/latest),
check it against `checksums.txt`, then put it on your `PATH`:

```sh
# Linux / macOS
chmod +x agentflow-<version>-<os>-<arch>
mv agentflow-<version>-<os>-<arch> /usr/local/bin/agentflow
```

```powershell
# Windows
Move-Item .\agentflow-<version>-windows-x64.exe $env:LOCALAPPDATA\Microsoft\WindowsApps\agentflow.exe
```

**From source.**

```sh
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow
npm install
npm link           # makes `agentflow` and `aflow` available globally
```

### Requirements

- **Node.js >= 20** — for the npm and source installs. The binary carries its own.
- **Git >= 2.30** — used for workspace detection and the Git-integration commands.
- **Provider credentials** — at least one hosted provider key, or a local Ollama.
  Nothing routes until one is configured; add it with `aflow setup`.

## What you get

```
╔═══════════════════════════════╗   ╔═══════════════════════════════╗
║ THE TRIBUNAL                  ║   ║ NEVER LOSES WORK              ║
║                               ║   ║                               ║
║ Five adversarial stages       ║   ║ A dead model fails over       ║
║ review a proposal across      ║   ║ mid-conversation. Context     ║
║ models, then a confidence     ║   ║ is preserved and the switch   ║
║ gate decides if it ships.     ║   ║ is recorded. No retyping.     ║
╚═══════════════════════════════╝   ╚═══════════════════════════════╝
╔═══════════════════════════════╗   ╔═══════════════════════════════╗
║ TWELVE FREE PROVIDERS         ║   ║ ZERO DEPENDENCIES             ║
║                               ║   ║                               ║
║ Groq · Cerebras · Mistral     ║   ║ Pure Node builtins. 1177+     ║
║ Gemini · OpenRouter ·         ║   ║ tests. Lint and typecheck     ║
║ Cloudflare · HuggingFace ·    ║   ║ block every change.           ║
║ Together · Fireworks ·        ║   ║                               ║
║ DeepInfra · SambaNova ·       ║   ╚═══════════════════════════════╝
║ Ollama (local).               ║                                    
╚═══════════════════════════════╝                                    
```

## The tribunal

Every proposal runs the same five stages, in order. Each stage narrows the field
and leaves behind a record the next one reads.

```
        proposal
           │
           ▼
      ╔════════╗
      ║ FORGE  ║   self-adversarial review
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║CRUCIBLE║   cross-examination
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║ MERGE  ║   hybrid synthesis
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║ TRIAL  ║   prosecution
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║ ORACLE ║   confidence gate
      ╚════╤═══╝
           │
           ▼
   VERIFIED · INSUFFICIENT_CONFIDENCE · REJECTED · ABORTED
```

Forge reviews a proposal against itself. Crucible cross-examines it from
adversarial vectors and scores its survival. Merge synthesizes the survivors
into a hybrid. Trial prosecutes the hybrid and can send it back for another
merge. Oracle weighs all five scores — self 0.15, survival 0.25, merge 0.20,
trial 0.30, validation 0.10 — and returns a verdict against a 0.95 gate.

A run that cannot finish is not a pass. A skipped stage yields **ABORTED**, not
a quiet success. The tribunal fails closed.

## Chat that survives a dead provider

When a model fails or returns an empty body, the next candidate answers. The
conversation continues, the context is intact, and the switch is on the record.
You never retype a thing.

```
$ aflow chat

aflow chat · coder · groq/llama-3.3-70b-versatile · session ses_20261015T172503281Z_93qr3p (new)
workspace C:\Users\anand\9router (git)
type /help for commands, /quit to exit. Ctrl+C cancels a response.

> why is an empty 200 worse than a 500?

A 500 tells you the truth. An empty 200 says the request succeeded and hands you
nothing, so every layer above assumes there was no output — the failure surfaces
later, as a wrong answer, far from its cause. Here it is retried, not returned.

> summarize src/core/continuity.js in three lines

It classifies an error into a failure class — empty, rate-limited, timeout,
auth, and so on — decides whether switching providers could change the outcome,
and asks for consent before a switch that might duplicate a tool call.

(answered by cerebras/llama3.1-70b)

> /status

model:    cerebras/llama3.1-70b (fallback)
provider: cerebras
status:   healthy
circuit:  closed
session:  ses_20261015T172503281Z_93qr3p  (4 message(s), ~1.9k tokens)

> /quit

session ses_20261015T172503281Z_93qr3p · 4 message(s) · ~1.9k tokens
resume: aflow chat --resume ses_20261015T172503281Z_93qr3p
```

Failover is not a retry of your message — it is the same turn, finished by
someone else, with the switch recorded so a later reader can tell what happened.

## Git, from the terminal or a chat

The same dispatcher backs `aflow git` and the in-chat `/git` command. It reads
and drives the working tree — status, log, diff, branches, staging, commits,
stashes, and merge-conflict resolution — while leaving the destructive verbs out
entirely.

```
$ aflow git status

git status · main

staged (1)
  M src/core/git/stash.js
unstaged (1)
  M src/core/git/tools.js
untracked (1)
  ? test/git/stash.test.js

$ aflow git diff --stat
1   0   src/core/git/stash.js
3   1   src/core/git/tools.js

$ aflow git commit --message 'fix(git): correct stash no-op detection'
committed 8f2c1a9 fix(git): correct stash no-op detection
```

It shells out to your `git` with an argument vector — never a shell string — and
validates every path and branch name before it reaches argv. Ignored files are
never staged implicitly, bare and missing repositories are reported rather than
crashed on, and nothing here pushes or rewrites history. Inside a chat, a model
reaches the same operations through ten `git.*` tools, and a model granted only
`read` can inspect a repository but cannot change it.

The full reference — subcommands, agent tools, and what it refuses to do — is in
[docs/GIT_INTEGRATION.md](docs/GIT_INTEGRATION.md).

## Architecture

```
               ┌───────────────┬──────────────┐
               │          aflow CLI           │
               │ 17 commands · --json · flags │
               └───────────────┬──────────────┘
                               │
      ┬────────────────────────┼────────────────────────┬
      │                        │                        │
┌─────┬──────┐        ┌────────┬───────┐        ┌────────┬───────────┐
│  TRIBUNAL  │        │ Agent Runtime  │        │     Sessions +     │
│  5 stages  │        │ agents · tools │        │     Blackboard     │
└────────────┘        │                │        │ resume · decisions │
                      └────────┬───────┘        └────────────────────┘
                               │
                  ┌────────────┬─────────────┐
                  │          Router          │
                  │tiers · health · failover │
                  └────────────┬─────────────┘
                               │
                  ┌────────────┬─────────────┐
                  │      Gateway Server      │
                  │  OpenAI-compatible /v1   │
                  └────────────┬─────────────┘
                               │
 ┌─────────────────────────────┬──────────────────────────────┐
 │           groq · cerebras · gemini · openrouter            │
 │           cloudflare · hf · together · fireworks           │
 │           deepinfra · sambanova · ollama (local)           │
 └─────────────────────────────┬──────────────────────────────┘
```

A single request flows CLI → runtime → router → gateway → provider. The router
walks quality tiers and reorders them by observed health, so a model that just
failed is not tried first. The gateway is OpenAI-compatible, so anything that
speaks `/v1` can sit in front of it. Tribunal and the session/blackboard stores
hang off the runtime — one reviews a proposal, the other remembers every decision.

## Twelve providers, one endpoint

Every provider below is OpenAI-compatible and free to start. `aflow setup` writes
the key to a single owner-only `keys.env`; the exact env-var names and model
prefixes live in [docs/PROVIDERS.md](docs/PROVIDERS.md).

| Provider | Models | Free tier | Rate limit | Credit card |
|---|---|---|---|---|
| **Groq** | llama-3.3-70b-versatile, llama-3.1-8b-instant, mixtral-8x7b-32768, gemma2-9b-it | yes | 30 req/min | no |
| **Cerebras** | llama3.1-8b, llama3.1-70b, qwen-3-32b | yes | 30 req/min | no |
| **Mistral** | mistral-small-latest, mistral-large-latest, open-mistral-nemo, codestral-latest | yes (rate-limited) | provider-set | no |
| **Google Gemini** | gemini-2.0-flash, gemini-2.5-flash, gemini-1.5-flash, gemini-1.5-pro | yes | 15 req/min | no |
| **OpenRouter** | auto, meta-llama/llama-3.3-70b-instruct:free, mistralai/mistral-7b-instruct:free | free models | provider-set | no |
| **Cloudflare Workers AI** | @cf/meta/llama-3.1-8b-instruct, @cf/deepseek-ai/deepseek-r1-distill-qwen-32b | 10,000 neurons/day | daily quota | no |
| **HuggingFace** | meta-llama/Llama-3.1-8B-Instruct, Qwen/Qwen2.5-72B-Instruct, mistralai/Mistral-7B-Instruct-v0.3 | shared | shared | no |
| **Together AI** | meta-llama/Llama-3.3-70B-Instruct-Turbo, Qwen/Qwen2.5-72B-Instruct-Turbo | $5 signup credit | provider-set | no |
| **Fireworks AI** | accounts/fireworks/models/llama-v3p3-70b-instruct, accounts/fireworks/models/qwen2p5-72b-instruct | $1 signup credit | provider-set | no |
| **DeepInfra** | meta-llama/Llama-3.3-70B-Instruct, Qwen/Qwen2.5-72B-Instruct | free tier | provider-set | no |
| **SambaNova** | Meta-Llama-3.3-70B-Instruct, Qwen2.5-72B-Instruct | free tier | provider-set | no |
| **Ollama** (local) | any model you pull | unlimited | none | no |

`process.env` always overrides the keys file, so a key you export in your shell
wins over one saved on disk. Address a model by prefix
(`groq/llama-3.3-70b-versatile`), or leave the prefix off and let AgentFlow
infer the provider from the model id's shape when only one can serve it.

## Command reference

```sh
aflow <command> [options]
```

| Command | Purpose |
|---|---|
| `agent` | run and inspect the built-in agents |
| `blackboard` | record and recover durable project workflow state |
| `chat` | interactive chat with streaming, sessions, and provider failover |
| `config` | show effective configuration and where each value came from |
| `dashboard` | open the interactive terminal dashboard |
| `doctor` | check environment, gateway, and live provider reachability |
| `fight` | alias for `aflow tribunal run` |
| `git` | inspect and drive the repository: status, log, diff, branch, stage, commit, stash, conflicts |
| `init` | create a starter project config |
| `logs` | read the structured event log |
| `models` | list models by provider, optionally probing reachability |
| `route` | run a completion through the fallback cascade |
| `server` | run and control the standalone in-repo gateway |
| `sessions` | start, resume, and inspect persistent sessions |
| `setup` | configure free provider API keys with a guided wizard |
| `status` | show gateway health and version |
| `tribunal` | run the five-stage self-adversarial tribunal on a proposal |

Global flags: `--json`, `--quiet`, `--verbose`, `--no-color`, `--port`,
`--model`, `--base-url`. Configuration resolves low → high:
`defaults < global file < project file < AGENTFLOW_* env < flags`.

## Philosophy

- **Advertised ≠ working.** A model in a catalogue is a claim; a model that
  returns content is a fact. The tool is built around the gap between them.
- **Continuity over provider loyalty.** The conversation matters more than which
  model serves it. Failover is automatic and recorded, never silent.
- **Truth over impressive claims.** If the tribunal cannot reach a verdict it
  reports `ABORTED`. If a key is missing the error names the variable. There is
  no lenient fallback to a plausible-looking success.
- **Safety by default.** Destructive tools ask first. A switch that might repeat
  a tool call asks first. EOF means no.
- **Honest provenance.** Every verdict is your own model's output, with the
  weights and the findings shown. Nothing is presented as more certain than it
  is.

## Quality

- **1177+ tests** (`npm test`) across the router, the tribunal stages, the
  gateway, continuity, and every command.
- **Zero runtime dependencies** — the Node standard library and nothing else.
- **Blocking CI**: `npm run lint` and `npm run typecheck` must both pass before a
  change lands. Neither is advisory.

## Security

- **Credentials are redacted at one chokepoint** (`src/core/redact.js`) before
  any output, log, or session file — by field name *and* by value shape, so a
  leak under either is masked.
- **`npm run scan-secrets`** scans the working tree, and `--history` scans every
  reachable blob. Both run in CI.
- **Honest about upstream risk.** AgentFlow is dependency-free, so it carries no
  transitive supply chain. The upstream credential exposure at `decolua/9router`
  (advisory **GHSA-35rj-mq32-7gcj**) is that project's to fix; AgentFlow's
  exposure-check job stays intentionally red until the rotation is confirmed.
  Details in [SECURITY.md](SECURITY.md).

## Project origin

AgentFlow is derived from **9Router** (`decolua/9router`, commit `a99cf572`, tag
`v0.5.95`, MIT). The provider engine and the gateway were inherited; the routing,
tribunal, session, and continuity layers are this project's own. Provenance is
carried by documentation rather than by history — the repository begins from an
independent initial commit, because copying upstream history would republish
credentials upstream must still rotate. Full account: [PROJECT_ORIGIN.md](PROJECT_ORIGIN.md).

<div align="center">

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md) · [Architecture](ARCHITECTURE.md) · [Tribunal](docs/TRIBUNAL.md) · [Providers](docs/PROVIDERS.md) · [Origin](PROJECT_ORIGIN.md) · [MIT License](LICENSE)

<br>

**If this saves you one dead-provider mystery, star the repo.**

[github.com/anand-cpp/AgentFlow](https://github.com/anand-cpp/AgentFlow)

</div>
