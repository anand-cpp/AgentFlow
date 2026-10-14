# AgentFlow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](THIRD_PARTY_NOTICES.md)

**A terminal-first CLI that routes work across many models — and tells you which
of them actually answer.**

A gateway hands you an API key and a catalogue of models. What it does not tell
you is which of those models will reply *right now*. Free-tier endpoints list
themselves and then return empty bodies, 404s, or expired OAuth. AgentFlow probes
them and reports what actually happened.

```
$ aflow doctor

CHECK                               STATUS        DETAIL
──────────────────────────────────  ────────────  ──────────────────────────────────────────────────────
node                                ok            24.19.0
config                              ok            defaults
google-oauth                        unconfigured  set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable
antigravity-oauth                   unconfigured  set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET…
gateway                             ok            http://localhost:20127 reachable in 32ms
oc/muse-spark-1.3-contributor-free  error         local provider unreachable: fetch failed
ocz/deepseek-v4-flash-free          error         local provider unreachable: fetch failed
bzl/auto:free                       error         local provider unreachable: fetch failed

x 3 problem(s) found
```

That is a real run against the bundled gateway (`aflow server`) with no model
backend configured: the gateway answers in 32 ms and every advertised model
fails. **Reachable** and **listed** are different facts, and most tooling
collapses them into one. This one does not.

---

## The problem

Model catalogues describe intent, not availability. A provider that has no active
credential, that has rate-limited you, or that is simply down, will still appear
in `/v1/models` alongside the ones that work. Nothing in the response tells you
which is which.

That matters most where it is least obvious: free-tier and aggregator endpoints,
where the catalogue is large, the credentials are shared or expired, and the
failure is a silent 200 with an empty body rather than an error you can catch.

AgentFlow takes the position that the gap between *advertised* and *working* is
the thing worth measuring — in `aflow doctor` (probes specific models), in
`aflow route` (walks a fallback order and records why each step failed), and in
the routing engine itself, which orders candidates by observed health rather than
by the order a provider listed them.

---

## What makes it different

- **Reachability is measured, not assumed.** A probe requires actual content. A
  200 with an empty body is reported as `empty`, distinct from both `ok` and
  `error`, because a provider that answers with nothing is a different problem
  from one that is down.
- **A five-stage adversarial tribunal.** A proposal is treated as a defendant and
  run through Forge, Crucible, Merge, Trial and Oracle, each stage able to kill
  it. See [The Tribunal](#the-tribunal).
- **A bundled gateway.** `aflow server` runs a zero-dependency, OpenAI-compatible
  gateway in-process over `node:http`, translating between OpenAI and Ollama and
  forwarding to hosted providers. You do not need a separate service to get
  started.
- **A bounded agent runtime.** Eight built-in agents, each a declaration of
  scopes, an output contract and a budget. Permissions are enforced by allowlist,
  not by prompt text, and approvals fail closed. See [The agent
  runtime](#the-agent-runtime).
- **Context-preserving failover.** After the provider cascade exhausts its retry
  budget on a transient fault, the runtime gives continuity one chance to hand
  the same work to a provider the retry cap never reached — never blindly
  replaying a non-idempotent action.
- **Durable per-project state.** Sessions record what happened in a run; the
  Blackboard records what the project is for. Both survive the process.
- **Redaction at one chokepoint.** Every value that reaches a terminal or a log
  passes through `src/core/redact.js` first.

---

## Quick start

Requires **Node.js 20 or newer**. **Zero runtime dependencies** — the CLI and the
bundled gateway import only Node builtins, so there is nothing to install before
it runs.

```bash
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow

# The gateway is usually the first thing you want, so doctor has something to talk to.
node bin/aflow.js server start --daemon
node bin/aflow.js doctor
```

`doctor` fails loudly until a gateway is reachable — that is the intended
behaviour, not a bug. To point at a gateway you already run:

```bash
node bin/aflow.js doctor --base-url http://host:port
```

To get `aflow` on your PATH:

```bash
npm link
aflow init          # write a starter .agentflow.json
```

`npm install` is needed only for the lint and typecheck tooling; it is not needed
to run the CLI or its tests.

---

## The Tribunal

A model asked to check its own work tends to agree with itself. The tribunal
takes that as the starting problem and runs a proposal through five adversarial
stages, each allowed to kill it:

```
Forge     the proposal is reviewed by a hostile-but-fair reader (self-review)
Crucible  it is cross-examined from four attack vectors; each finding must
          carry a falsifiable proof
Merge     surviving proposals are synthesized into one hybrid
Trial     the hybrid is prosecuted for regressions and scope inflation
Oracle    a weighted confidence gate decides the outcome
```

The Oracle emits one of four verdicts — `VERIFIED`, `INSUFFICIENT_CONFIDENCE`,
`REJECTED`, or `ABORTED` — and `VERIFIED` requires confidence at or above the
gate threshold (**0.95**). Individual trial outcomes are `ACQUITTED`,
`CONVICTED_RETRY`, `CONVICTED_FINAL`, or `MISTRIAL`.

Two things are worth being explicit about:

- **Confidence is not calibrated.** The gate is a weighted combination of the
  stages' own scores. It is a consistent, reproducible number for a given run,
  not a probability that a proposal is correct. Do not read `96%` as "96% likely
  to be right".
- **Every stage is fail-closed.** Unreadable model output becomes a named
  `INVALID_*` or `MISTRIAL` result — never a crash, and never a silent pass.

```bash
aflow tribunal run "switch the router to a least-recently-failed order"
aflow tribunal run "…" --domain architecture --model oc/muse
aflow tribunal history            # past verdicts, one line each
aflow fight "…"                   # alias for `tribunal run`
aflow --tribunal "…"              # flag sugar for the same thing
```

A real run against a dead gateway shows the pipeline terminating safely rather
than inventing a verdict:

```
$ aflow tribunal run "switch the router to a least-recently-failed order"

  TRIBUNAL FIGHT CARD
  id       ec7d5e3f-db50-4387-8b0a-45e332822cfa
  domain   code

  ROUND 1 · FORGE  self-adversarial review
  1 candidate(s) · 0 reviewed · 1 unreadable · 0 revised

  ROUND 2 · CRUCIBLE  cross-examination
  proposal-1  survival 1.00  0 finding(s)

  ROUND 3 · MERGE  hybrid synthesis
  status   INVALID_RESULT
  x completion failed: cannot reach gateway at http://1…

  ROUND 4 · TRIAL  prosecution
  status   SKIPPED
  reason   No merge to try

  ROUND 5 · ORACLE  the gate
   ABORTED   confidence 0.0%
  ABORTED: a stage was skipped or unreadable, so no verdict c…
```

Each run is recorded in the session store, so a later run can answer *what we
decided, and how sure we were*. Add `--record` to also write the verdict to the
project Blackboard, or `--json` for the full run record. Credentials are
redacted before any output or persistence.

---

## How it fits together

```
user
 │  aflow <command> [flags]
 ▼
bin/aflow.js ──► src/cli/index.js        parse argv, resolve the command
 │
 ▼
src/commands/<cmd>.js                    one module per command (13 commands)
 │
 ├── src/config/index.js                 5-layer configuration precedence
 │
 ├── src/core/                           routing.js · provider-health.js
 │                                       sessions.js · blackboard.js · persist.js
 │                                       events.js · redact.js
 │
 ├── src/core/agents/                    runtime.js · registry.js · tools.js
 │                                       tool-filesystem.js · tool-shell.js · workspace.js
 │
 ├── src/core/tribunal/                  self-review · crucible · merge · trial · oracle
 │
 ▼
src/core/gateway.js  ──HTTP (OpenAI-compatible)──►  a gateway
 (the client)                                        ├─ aflow server (src/core/gateway-server.js)
                                                     └─ any external OpenAI-compatible server
 │
 ▼
stdout / stderr                          human text, or --json
```

`open-sse/` is a routing and provider-translation engine inherited from 9Router
(MIT); the `src/` tree is AgentFlow's own. The client in `src/core/gateway.js`
treats an external gateway and the bundled one identically — they are the same
OpenAI-compatible interface, so `aflow server` can be swapped for a 9Router
instance or any other compatible server without changing anything else.

State is written outside the repository, under the platform state directory
(`AGENTFLOW_STATE_DIR`, else `%LOCALAPPDATA%\agentflow` on Windows,
`~/Library/Application Support/agentflow` on macOS, `$XDG_STATE_HOME` or
`~/.local/state/agentflow` elsewhere):

| State | Location |
|---|---|
| Sessions | `<state-dir>/sessions/` — one JSON file per session |
| Blackboard | `<state-dir>/blackboard/<id>.state.json` + `<id>.events.jsonl` |
| Event log | `<state-dir>/agentflow.jsonl` |
| Gateway | `<state-dir>/server/` — the daemon's pid/state file |

---

## The agent runtime

An agent is a **declaration** — a bounded permission set, an output contract and
a budget — not a prompt with a name. The runtime reads the fields; nothing
anywhere switches on an agent's id. Eight ship built in:

| Agent | Purpose | Privilege |
|---|---|---|
| `planner` | Turn an objective into an ordered, checkable plan | read-only |
| `coder` | Implement a change and show evidence it works | high |
| `reviewer` | Judge a change against what it was supposed to do | read-only |
| `debugger` | Find the actual cause, then fix that and nothing else | high |
| `tester` | Prove a change works, or prove precisely that it does not | high |
| `researcher` | Answer a question from evidence, and say how confident that is | elevated |
| `security` | Find the vulnerability that is actually there | read-only |
| `release` | Prepare and verify a release; publish only on explicit instruction | elevated |

```bash
aflow agent                                 # list, with each agent's privilege
aflow agent show coder                      # scopes, allowlist, gates, bounds, contracts
aflow agent run planner "add a health endpoint"
aflow agent run coder "fix the null deref in routing.js" --workspace . --json
```

### Scopes are the control; instructions are not

Every agent's prompt contains instructions — *run the tests before claiming
success*, *do not push*. None of them are security controls. The model is the
untrusted party in this system; "do not push" in a prompt is a request, and the
Coder cannot `git push origin main` because there is no allowlist entry for it,
not because it was told not to.

A permission is an entry, and entries resolve in a fixed order:

```
deny  ->  scope approval  ->  allow  ->  ask  ->  deny
```

`deny` is refused outright. Scope-level approval gates the whole scope, allowlist
included. `allow` runs silently. `ask` needs approval. Anything unmatched is
refused. `allow` and `ask` together are what make a narrow policy usable: the
Coder runs `git status`, `git diff`, `git log` and `npm test` without prompting,
because those change nothing — anything else in the shell scope asks first.

### Approvals fail closed

Interactive on a terminal, one prompt per gated call. Without a TTY there is
nobody to ask, so gated actions are refused and the refusal says how to override
it. `--yes` approves everything and `--deny` refuses everything; both must be
typed deliberately.

### Bounds are checked in both directions

Every agent declares a maximum iteration count, tool-call count, wall clock,
context size and recursion depth, all checked before the work *and* after each
model call. A deadline only enforced between iterations is not a deadline,
because a single slow call overruns it and then reports clean success. Run
outcomes keep `completed`, `timedOut`, `cancelled` and the terminal state
separate rather than collapsing them into "failed".

### The audit trail records what ran

Every tool call is logged before dispatch, so a crash mid-tool still leaves a
record. Only the pre-execute waterfall may rewrite a call; the execute waterfall
may not, because by then the call has been judged by the permission check and the
approver, and a rewrite there would dispatch something nobody approved. A
successful run is recorded in the Session (the full outcome) and the Blackboard
(an implementation note referencing the Session).

---

## Routing and failover

`aflow route` sends a prompt to the first model that actually answers, walking a
fallback order and recording why each step failed:

```bash
aflow route "ping" --fallback oc/muse,ocz/deepseek,bzl/auto:free
aflow logs --type route.fallback --json | jq '.events[].to'
```

The routing engine classifies failures, orders candidates, and consults a
provider-health circuit breaker. `AgentRuntime` constructs that breaker (or
reuses an injected one) and passes it to the `Router`, so a provider that just
failed cools down before it is retried. On a transient fault that exhausts the
cascade's retry budget, the runtime's continuity path can continue the same work
on a provider the cap excluded — gated so it never replays an uncertain
non-idempotent action, and never proceeds without a session to reconstruct the
work from.

Every routing decision, tool approval and provider error is written to the
append-only JSONL event log, so `aflow logs` can answer "why did it do that?"
without re-running anything.

---

## The bundled gateway

`aflow server` runs the gateway in-repo, so AgentFlow does not require a
separately installed routing service:

```bash
aflow server start            # foreground
aflow server start --daemon   # background
aflow server status           # reachable? pid + uptime
aflow server stop
```

It is built on `node:http` alone — no framework — and answers four routes:
`/api/version`, `/health`, `/v1/models`, and `/v1/chat/completions`. It binds to
loopback by default and **refuses to bind `0.0.0.0` without an API key**, because
an unauthenticated local gateway facing the network is an open proxy to the local
model. Set `AGENTFLOW_SERVER_API_KEY` to expose it, and that key is then required
on `/v1/*`.

Ollama does not speak the OpenAI contract natively, so the gateway translates at
the boundary: the request is rewritten into Ollama's native `/api/chat`, and the
reply is translated back — NDJSON to Server-Sent Events when streaming, and
`{ message }` to `{ choices[].message }` when not. Hosted providers already speak
OpenAI, so their bytes pass through untranslated. Callers see exactly one
contract regardless of backend.

---

## Provider support

Two layers provide model access, and they have different breadth. Both are stated
as they are wired, not as the catalogue implies.

**The bundled gateway (`aflow server`)** forwards to a fixed set:

| Provider | Kind | Credential (env) |
|---|---|---|
| Ollama | local | none — `AGENTFLOW_OLLAMA_URL` (default `http://127.0.0.1:11434`) |
| Groq | remote | `GROQ_API_KEY` |
| Cerebras | remote | `CEREBRAS_API_KEY` |
| Mistral | remote | `MISTRAL_API_KEY` |
| Gemini | remote | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| OpenRouter | remote | `OPENROUTER_API_KEY` |

A `<provider>/<model>` prefix selects a remote provider explicitly and is a hard
error if its key is missing; a bare, provider-shaped model id is matched
heuristically only when a key exists, and otherwise falls back to local Ollama.

**An external gateway** can offer anything that speaks the OpenAI-compatible API.
Point `AGENTFLOW_BASE_URL` at it. The inherited `open-sse/` engine that a 9Router
deployment is built on carries 133 provider registries, but AgentFlow's own
gateway wires only the six above — do not read the upstream catalogue as a list
of providers this CLI will authenticate for you.

Availability is honest in both directions: a provider appears in `/v1/models`
only when its credential is present, and **no provider path is exercised in CI** —
every model in the test suite is a deterministic mock, and live reachability is
checked by `aflow doctor` against a running gateway and real credentials.

---

## Configuration

Precedence, low to high:

```
defaults  <  global config file  <  project config file  <  AGENTFLOW_* env  <  flags
```

The global file is `%APPDATA%\agentflow\config.json` on Windows and
`~/.config/agentflow/config.json` elsewhere. The project file is
`.agentflow.json`, discovered by walking up from the working directory; when
several exist, **the nearest file wins**. `aflow config` prints the resolved
value and the layer each came from.

| Variable | Config key |
|---|---|
| `AGENTFLOW_BASE_URL` | `baseUrl` (default `http://localhost:20127`) |
| `AGENTFLOW_API_KEY` | `apiKey` |
| `AGENTFLOW_DEFAULT_MODEL` | `defaultModel` |
| `AGENTFLOW_PROBE_TIMEOUT_MS` | `probeTimeoutMs` |
| `AGENTFLOW_THEME` | `theme` |
| `AGENTFLOW_SERVER_PORT` / `AGENTFLOW_SERVER_HOST` | `serverPort` / `serverHost` |
| `AGENTFLOW_OLLAMA_URL` | `ollamaUrl` |
| `AGENTFLOW_SERVER_API_KEY` | `serverApiKey` |
| `AGENTFLOW_JSON` / `AGENTFLOW_QUIET` / `AGENTFLOW_VERBOSE` / `AGENTFLOW_NO_COLOR` | output mode |
| `AGENTFLOW_LOG_LEVEL` / `AGENTFLOW_LOG_PATH` | event log |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. An unrecognised
value falls back to the default rather than being coerced — `AGENTFLOW_JSON=maybe`
leaves JSON off instead of guessing. A malformed config file is reported as a
diagnostic and skipped; lower layers still apply, so a typo never makes the CLI
unusable.

---

## Commands

| Command | What it does |
|---|---|
| `aflow doctor` | Environment, gateway, and live provider reachability |
| `aflow models` | Catalogue grouped by provider; `--probe` to test which work |
| `aflow status` | Cheap health check, safe for a status bar |
| `aflow route` | Run a prompt through the fallback cascade, with a receipt |
| `aflow agent` | The built-in agents: list, inspect a declaration, run one |
| `aflow tribunal` | Run the five-stage self-adversarial tribunal on a proposal |
| `aflow sessions` | Persistent sessions: start, resume, inspect, annotate |
| `aflow blackboard` | Durable per-project workflow state |
| `aflow server` | Run and control the bundled gateway |
| `aflow logs` | Read the structured event log |
| `aflow config` | Resolved configuration, and where each value came from |
| `aflow init` | Write a starter project config |
| `aflow dashboard` | Interactive terminal dashboard |

`aflow fight` is an alias for `aflow tribunal run`, and `aflow --tribunal "…"` is
flag sugar for the same. Every command takes `--json` for machine-readable output.

### Sessions

A session is one unit of work that outlives the process, so the next command — or
the next agent — continues instead of starting from zero.

```bash
aflow sessions new "fix the routing cascade" --model oc/muse
aflow sessions note <id> "cascade now falls through" --as coder
aflow sessions resume                 # picks up the current session
aflow sessions inspect <id> --entries 0
```

Sessions are stored one JSON file per session, written to a temporary file and
renamed over the target so a process killed mid-write leaves the previous version
intact. A file that fails to parse is reported as corrupt and left untouched —
a damaged session may be the only surviving record of real work.

### Blackboard

Sessions record what happened *in* a run. The Blackboard records what the project
is *for*: the goal, what is open, why a decision was made, what is blocked, and
what should happen next — the state an agent needs when it restarts mid-task.

```bash
aflow blackboard goal "ship durable state" --objective "finish the milestone"
aflow blackboard task add "implement the store" --detail "corruption safe"
aflow blackboard block "waiting on upstream merge" --task t1 --severity high
aflow blackboard test unit --passed 304 --failed 0 --command "npm test"
aflow blackboard implemented "added store and cli" --files src/… --commit abc1234
aflow blackboard next "open the PR"
aflow blackboard show                 # goal, open work, blockers, next action
```

```
git         what the code is
blackboard  what we were doing to it
```

Only references are recorded — a path, a sha, a command, a URL — never file
contents. State is one `<id>.state.json` per project alongside an append-only
`<id>.events.jsonl` timeline, both written atomically; the timeline is never
replayed into state, which is what makes it useful when the state file is
damaged. Mutating commands create the Blackboard on demand, and every value is
redacted before either file is written.

---

## Security

AgentFlow prints gateway URLs, provider IDs and error payloads, which often embed
API keys and OAuth tokens. Every value that reaches a terminal or a log passes
through `src/core/redact.js` first — the single chokepoint — which masks
credentials both by sensitive field name and by pattern, and refuses to persist a
credential-shaped value that survives redaction.

```bash
aflow config          # apiKey and serverApiKey both render as ***
```

Filesystem tools are confined to a workspace root resolved to a physical path
before a run and not negotiable from inside it. Approvals fail closed.

### Inherited credentials and open disclosure

The `open-sse/` engine inherited from 9Router shipped hardcoded third-party
credentials in its source and history. They were replaced with environment
variables during import, and no credential value is present in this repository's
history:

| Provider | Variables |
|---|---|
| Google | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` |
| Antigravity | `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` |
| iFlow | `IFLOW_OAUTH_CLIENT_ID` / `IFLOW_OAUTH_CLIENT_SECRET` |
| Windsurf | `WINDSURF_OAUTH_CLIENT_ID` / `WINDSURF_OAUTH_CLIENT_SECRET` / `WINDSURF_FIREBASE_API_KEY` |

This is not the same as remediation. Two inherited values remain **publicly
retrievable** from this repository's pre-purge objects via the GitHub REST API;
force-pushing rewrote the refs but did not delete the objects. The upstream owner
(`decolua/9router`) has been notified through GitHub's private reporting flow as
advisory **`GHSA-35rj-mq32-7gcj`** (submitted 2026-10-04), and the credentials
have **not been confirmed rotated**. The secret-scanning alert is deliberately
left open.

Two CI jobs encode this rather than hide it:

- `secrets-history` scans every reachable blob for credentials and must pass.
- `secrets-exposure` asks whether the known-bad objects are still publicly
  retrievable and **is expected to fail** until rotation is confirmed. It fails
  closed on a rate limit or a dropped connection, because reading a network error
  as "not exposed" is the exact failure the monitor exists to prevent. Do not
  silence it.

`scripts/scan-secrets.mjs` runs against the working tree (clean, 538 tracked
files) and with `--history` in CI. If you depend on the affected providers, treat
the inherited values as compromised and obtain your own credentials. Full detail,
including the pre-purge commit ids and verification method, is in
[`SECURITY.md`](SECURITY.md) and [`SECURITY_DISCLOSURE_STATUS.md`](SECURITY_DISCLOSURE_STATUS.md).

---

## Project origin

AgentFlow is a derivation of **[9Router](https://github.com/decolua/9router)**
(MIT), taken at commit `a99cf572` (tag `v0.5.95`). The routing and
provider-translation engine in `open-sse/` is inherited; the CLI, agent runtime,
tribunal, sessions, Blackboard, redaction and bundled gateway are new
construction. The repository begins from an independent initial commit and does
not carry upstream's history — that history contains the credential-bearing
commits described above, which are not this project's to republish.

Two projects were studied for architecture only, with **no source code copied**:
[opencode](https://github.com/anomalyco/opencode) (MIT) and
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(MIT). Qwen code, weights, prompts and assets are excluded by policy.

Full file-level provenance is in [`PROJECT_ORIGIN.md`](PROJECT_ORIGIN.md),
[`AUDIT/`](AUDIT/) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

## Development

```bash
npm test           # full suite, no network or credentials required
npm run lint       # eslint, enforced in CI
npm run typecheck  # tsc --noEmit over JSDoc, enforced in CI
```

The suite runs on the Node built-in test runner via `scripts/run-tests.mjs` and
does not touch the network: every provider is a deterministic mock, and live
probing is exercised separately by `aflow doctor` against a running gateway. It
covers config precedence and walk-up discovery, argument parsing, command
registration, the event log, credential redaction, persistence, routing and
provider health, sessions, the Blackboard, the agent runtime and its tools, the
bundled gateway and its SSE translation, and all five tribunal stages including
the full pipeline. CI runs the suite on Node 20, 22 and 24.

The active codebase — everything outside the inherited `open-sse/` engine — is
kept lint-clean and typecheck-clean. `open-sse/` is excluded from both and that
exclusion is recorded, with the other known debt, in
[`docs/DEBT_LEDGER.md`](docs/DEBT_LEDGER.md).

---

## Contributing and roadmap

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for
conventions (zero runtime dependencies, ESM, Node ≥20, `node:test`, a changelog
line for any observable change) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Built and tested today: the CLI, routing and failover, the bundled gateway, the
session and Blackboard stores, the agent runtime with its tool and permission
system, and all five tribunal stages.

**Not built yet:** a plugin loader, agent orchestration (running several agents
together), and the upstream SQLite persistence and OAuth provider flows, which
were deliberately not imported. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
current module map and [`AUDIT/FEATURE_AUDIT.md`](AUDIT/FEATURE_AUDIT.md) for
verified capabilities and gaps.

---

## License

MIT — © 2026 anand-cpp, with the 9Router copyright (© 2024-2026 decolua and
contributors) retained for the inherited portions. See [`LICENSE`](LICENSE).

Retained third-party obligations, including the Google APIs Terms of Service for
Google-hosted providers, are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
