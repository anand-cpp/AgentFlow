# Historical snapshot (2026-10-11) - Forensic Status Report
> This is a point-in-time audit from the v0.1.x state. Some details (test counts, feature status) are now outdated.

# AgentFlow — Forensic Status Report

**Prepared:** 2026-10-11
**Repository:** `C:\Users\anand\9router` (remote `origin` = https://github.com/anand-cpp/AgentFlow.git)
**Branch analysed:** `feature/tribunal-self-review`
**HEAD:** `ec7e8f8abd6be55563ad87f5829511dee5c8d912` — "feat(tribunal): self-adversarial self-review core (schema, confidence, stage)" — 2026-10-11 10:34:44 +0530
**Working tree:** clean. No stashes.
**Node used for verification:** v24.19.0, npm 11.17.0 (Windows, PowerShell)

> **Assumptions made (as instructed, not asked):** (1) the deliverable is a single self-contained
> Markdown document; (2) it is written to the repository root as `FORENSIC_STATUS.md` and left
> **untracked/uncommitted**; (3) line numbers are cited where a file was read directly, and file
> paths alone are cited where a fact came from a scan. Anything that could not be verified on disk
> is explicitly marked **"does not exist"** or **"not verified"**. No value here is guessed.

---

## 1. Repository overview

**What it is.** AgentFlow is a terminal-first ("`aflow`") CLI that sits in front of an
OpenAI-compatible model gateway and answers one question its own README calls the product:
*which of the advertised models actually work right now?* (`README.md:5-11,29`). It combines a
routing/fallback engine imported from the MIT-licensed **9Router** project with a newly written
command surface, a persistent session store, a per-project "blackboard," and a bounded agent
runtime.

**Name / version / license.** From `package.json`: `name: "agentflow"`, `version: "0.1.0"`,
`description: "Terminal-first AI routing and agent platform"`, `license: "MIT"`. The version is
duplicated inside the code as `VERSION = "0.1.0"` in `src/cli/index.js:113` (verified by
`aflow --version` printing `aflow 0.1.0`).

**Git state.** The repository has an independent `Initial commit`
(`0aeb360f21ddcfe0035796db93f2c8f8fa357bb8`, 2026-10-03 23:10:17 +0530) and does **not** carry
upstream history — a deliberate choice documented in `PROJECT_ORIGIN.md:21-42` (copying upstream
history would republish committed OAuth credentials). Two remotes are configured (verified with
`git remote -v`):

| Remote | URL |
|---|---|
| `origin` | https://github.com/anand-cpp/AgentFlow.git |
| `upstream` | https://github.com/decolua/9router |

Branch tip counts: `main` = 53 commits, `feature/tribunal-self-review` = 54 (one ahead of `main`,
**unpushed** — `git log origin/main..HEAD` lists only `ec7e8f8a`). There are **90 tags**
(`v0.2.21` … `v0.5.95`); these are inherited labels from the 9Router import and do **not** tag
AgentFlow's own commits (`git describe --tags` on HEAD fell back to the short SHA `ec7e8f8a`).
The only committer on this branch is `anand-cpp <anand2007.amd@gmail.com>`.

**Working-tree layout** (root, excluding `.git/`, `node_modules/`, `.next/`):

```
.github/workflows/     AUDIT/        bin/          config/
open-sse/              scripts/      src/          test/
.env  .gitignore  LICENSE  package.json  PROJECT_ORIGIN.md
README.md  SECURITY.md  SECURITY_DISCLOSURE_STATUS.md
THIRD_PARTY_NOTICES.md  start.log  start.err.log
```

`open-sse/` is the substantive inherited engine (402 files across `config/ executors/ handlers/
providers/ rtk/ services/ shared/ transformer/ translator/ utils/`, per its own
`open-sse/AGENTS.md`). The newly written code lives under `src/` (**43 files, ~501 KB**).
`node_modules/` and `.next/` are present locally but git-ignored (`.gitignore:2-3`); `node_modules`
is a byproduct of a 9Router Next.js build, not an AgentFlow dependency (`.gitignore:36-43`).

**Tracked file count:** 495 on `feature/tribunal-self-review` (487 on `main`; the tribunal commit
added 8 files). Verified with `git ls-files`.

---

## 2. Technology stack

| Aspect | Finding | Source |
|---|---|---|
| Language | JavaScript (Node.js), no TypeScript, no compile step | file extensions; no `tsconfig.json` |
| Module system | ESM (`"type": "module"`, `import`/`export`) | `package.json` |
| Node requirement | `"engines": { "node": ">=20.0.0" }` | `package.json` |
| Runtime dependencies | **none** — `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` all empty | `package.json` (verified via `node -e`) |
| Lockfile | **intentionally absent** (`package-lock.json`, `npm-shrinkwrap.json` git-ignored) | `.gitignore:36-43` |
| Build system | none — run directly from source | — |
| Package manager | npm scripts only | `package.json` |
| Binary | `bin`: `{ "aflow": "./bin/aflow.js" }` | `package.json` |

**This is a genuine zero-dependency project.** The CLI uses only Node builtins
(`node:readline`, `node:fs`, `node:path`, etc.). The practical consequence: there is nothing to
audit for third-party CVEs in the CLI itself. `npm audit` **fails** on this repo with
`ENOLOCK` ("This command requires an existing lockfile") because no lockfile exists — this is
expected, not a defect:

```
npm error code ENOLOCK
npm error This command requires an existing lockfile.
```

The `open-sse/` engine, by contrast, is a larger body of imported JavaScript that may carry its
own dependencies/assumptions; it was not exhaustively dependency-audited in this pass.

The `files` allowlist for publishing is `[bin/, src/, open-sse/, LICENSE, PROJECT_ORIGIN.md,
README.md, SECURITY.md, THIRD_PARTY_NOTICES.md]` — note the published surface includes the whole
routing engine but **not** the `AUDIT/` or `test/` directories.

---

## 3. Entry points and CLI surface

**Entry point:** `bin/aflow.js` (29 lines). It imports `run` from `../src/cli/index.js`, performs a
side-effect import of `../src/commands/index.js` (which registers the commands), then calls
`run(process.argv.slice(2))` and maps the returned code to `process.exitCode`. `--verbose`/`--debug`
gate a stack dump on unexpected throws.

**Argument parser:** `src/cli/index.js` (149 lines). `GLOBAL_FLAGS` = `help, h, version, v, json,
quiet, verbose, debug, no-color, port, model, base-url`; `ALWAYS_VALUE_FLAGS` = `port, model,
base-url`. `parseArgv()` supports `--flag=value`, `--flag value`, `--` to end flags, and short
aliases (`h→help`, `v→version`, `q→quiet`, `p→port`). Unknown command → exit `127`; usage error →
exit `2`. Command registration is via `defineCommand`/`getCommand`/`commandNames` in
`src/cli/registry.js` (40 lines). `src/commands/index.js` imports **11** command modules.

**Verified command surface** (from `aflow --help` and per-command `--help`):

| Command | Purpose | Subcommands / key flags |
|---|---|---|
| `doctor` | Environment + gateway + live provider probes | `--verbose` |
| `models` | Catalogue grouped by provider | `[filter] --probe --limit N` |
| `status` | Cheap gateway health check | `--probe` |
| `config` | Resolved config + value origin | — |
| `init` | Write starter `.agentflow.json` | `[file] --force --dry-run` |
| `sessions` | Durable per-project work units | `list / new / resume / current / inspect / rename / note / done / archive / unarchive` |
| `blackboard` | Durable project workflow state | `show/list / goal / objective / task / decide / block / unblock / bug / fix / finding / review / note / test / implemented / next / link / timeline / destroy` |
| `agent` | Built-in agent fleet | `list / show <id> / run <id> "<task>"` with `--session --workspace --state-dir --blackboard-dir --project --yes --deny --json` |
| `route` | Run through fallback cascade | `<prompt> --fallback a,b,c --json --log-file` |
| `logs` | Read structured JSONL event log | `--limit --level --since --type --file` |
| `dashboard` | Interactive terminal dashboard | `--interval MS` (`r`/`p`/`q` keys) |

Exit-code contract (README `README.md:317-331`, confirmed in code): `0` healthy/completed, `1` a
check failed, `2` usage error, `127` unknown command. Every command accepts `--json`.

---

## 4. Core module inventory

All paths below are under `src/`. Line counts are from a direct line count of each file.

### 4.1 Routing engine
- **`core/routing.js`** (432 lines) — the fallback cascade. Exports `FAILURE` (failure taxonomy
  `RATE_LIMITED, NO_CREDENTIALS, EMPTY, TIMEOUT, NETWORK, SERVER, UNKNOWN`), `classifyFailure`,
  `dispositionFor`, `parseModelId`, `HealthCache`, `orderCandidates`, `Router`, `isEmptyResult`,
  `buildNoRouteError`, `tiersFromList`. Imports only the event log; it does **not** import
  `provider-health.js` (health is injected via dependency injection).
- **`core/provider-health.js`** (349 lines) — circuit-breaker/health tracking (landed via a merged
  PR, "provider-health-foundation"). This is the module that lets the router prefer providers that
  are actually up.
- **`core/gateway.js`** (185 lines) — HTTP client for the OpenAI-compatible gateway.
  `GatewayError`, `getVersion` (GET `/api/version`), `listModels` (GET `/v1/models`),
  `probeModel` (POST `/v1/chat/completions`, minimal `max_tokens`, classifies ok/empty/timeout/
  error), `ping`, and `complete(config, modelId, prompt, opts)` → `{ text, raw, finishReason,
  usage }`.

### 4.2 State
- **`core/sessions.js`** (495 lines) — the durable session store. `SESSION_VERSION=1`,
  `SESSION_STATE`, `ENTRY_KIND = { NOTE, CONVERSATION, TOOL_CALL, TOOL_RESULT, ROUTING, ERROR,
  AGENT, BLACKBOARD_REF, CHECKPOINT }`, typed error classes (`SessionError`, `SessionIdError`,
  `SessionNotFoundError`, `SessionCorruptError`, `SessionLockedError`), and class `SessionStore`.
  Writes are atomic (temp file + rename); a corrupt file is reported, never overwritten
  (`README.md:115-121`).
- **`core/blackboard.js`** (1248 lines — the largest `src/` file) — per-project workflow state:
  goal, objective, tasks, decisions, blockers, bugs, findings, reviews, tests, next action,
  timeline. Append-only `<id>.events.jsonl` timeline is kept independent of `<id>.state.json`.
  Records references (paths/shas/commands) only — never file contents.
- **`core/persist.js`** (223 lines) — generic atomic JSON persistence helper used by the stores.

### 4.3 Cross-cutting
- **`core/events.js`** (252 lines) — append-only JSONL event log; event type constants and
  `EventLog`/`defaultLogPath`.
- **`core/redact.js`** (118 lines) — credential redaction by field name (`SENSITIVE_KEYS`) and by
  pattern; `redact`, `redactDeep`, `containsSecret`, `SecretDetectedError`. Every value written to
  a session, blackboard file, log, or terminal passes through here (README `README.md:335-344`).

### 4.4 Agent subsystem (`core/agents/`)
- **`registry.js`** (510 lines) — declarative agent definitions: `CAPABILITY`, `TOOL_SCOPE`,
  `AGENT_STATE`, `LIMITS`, `defineAgent`, `AgentRegistry`.
- **`definitions.js`** (540 lines) — the **eight** built-ins: `planner, coder, reviewer, debugger,
  tester, researcher, security, release` (confirmed by `aflow agent list`). Each is a declaration
  (scopes, allowlist, gates, bounds, output contract), not a prompt.
- **`runtime.js`** (1249 lines — largest by lines) — `AgentRuntime` with `STATE`, typed errors
  (`AgentTimeoutError`, `AgentCancelledError`, `AgentBoundError`), prompt rendering, and the
  iterated model↔tool loop.
- **`tools.js`** (518) — tool registry + permission evaluation (`evaluatePermission`, `runTool`,
  `OUTCOME`, `STEP`, `ToolPermissionError`, `scrubEnv`).
- **`real-tools.js`** (43) — wires the concrete tools (`REAL_TOOLS`, `createRealTools`).
- **`tool-filesystem.js`** (487) / **`tool-shell.js`** (389) / **`tool-paths.js`** (142) /
  **`tool-bounds.js`** (156) / **`tool-errors.js`** (100) / **`workspace.js`** (187) — path
  containment, shell guardrails, bound enforcement, and the negotiable-root workspace model.
- **`context.js`** (234) — context assembly for a run.
- **`requirements.js`** (222) — model-hint inference and requirement checking
  (`inferHints`, `resolveHints`, `checkRequirements`, `resolveModelPlan`, `explainPlan`).

### 4.5 Tribunal (newest work, this branch)
- **`core/tribunal/review-schema.js`** (268) — `SELF_REVIEW_SCHEMA_VERSION=1`, `REVIEW_DECISION =
  {REVISE, REJECT, RETAIN_WITH_EVIDENCE}`, `EVIDENCE_KIND = {REPRODUCED, HYPOTHESIS}`,
  `validateSelfReview()` (fail-closed, no-throw, rejects unknown fields), `classifyFindings()`.
- **`core/tribunal/confidence.js`** (135) — `DOWNGRADE_TRIGGER`, `DOWNGRADE_VERDICT`,
  `LOW_CONFIDENCE_THRESHOLD=0.4`, `assessDowngrade()` (a failing executed test overrides
  confidence).
- **`core/tribunal/self-review.js`** (167) — identity-blind self-review: builds a prompt with the
  authorship stripped, one `complete()` call, `parseReview()` (fenced/bare JSON), `runSelfReview()`.
- **`core/tribunal/stage.js`** (130) — `runSelfAdversarialStage()`: reviews every candidate,
  re-reviews revisions, bounded by `maxRevisions`, malformed review → `INVALID_REVIEW`.

### 4.6 Config and CLI utilities
- **`config/index.js`** (194) — `CONFIG_BASENAME=".agentflow.json"`, `DEFAULTS = { baseUrl:
  "http://localhost:20127", apiKey: null, probeTimeoutMs: 15000, defaultModel: null, modelHints:
  {}, theme: "auto" }`, five-layer precedence with walk-up discovery.
- **`cli/index.js`** (149) / **`cli/registry.js`** (40) / **`cli/output.js`** (49) /
  **`cli/ui.js`** (121, ANSI colour helpers honoring `NO_COLOR`/`TERM=dumb`) — the CLI shell.

---

## 5. TUI / UI state

**There is no TUI framework.** `src/tui/dashboard.js` (161 lines) is the only "TUI" code and it is
hand-rolled ANSI plus `node:readline` — no Ink, Blessed, or any dependency:

- Alt-screen enter/leave via `\u001b[?1049h` / `\u001b[?1049l`.
- `clearScreen` via `\u001b[H\u001b[2J\u001b[3J`.
- `renderFrame(state, termWidth=100)` draws a fixed-width box (using `─`) and is a pure function of
  state — which is why it is unit-testable (see `test/dashboard.test.js`).
- Non-TTY guard: piping to a non-terminal prints a single snapshot instead of animations
  (`useColor`/`isTTY` checks).

So the dashboard is a **redrawn text screen**, not a component framework. Anyone expecting a
reactive TUI toolkit will not find one. `aflow dashboard` is functional and drives the same gateway
health/probe data as `doctor`.

---

## 6. Testing

**Runner:** `scripts/run-tests.mjs` (61 lines) auto-discovers `test/**/*.test.js` and runs them
with the Node built-in test runner. Invoke with `npm test`.

**Verified full-suite result on this branch (Node 24.19.0):**

```
ℹ tests 764
ℹ suites 0
ℹ pass 764
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7524.8333
```

**29 test files.** Coverage areas (by file): command/CLI parsing (`cli.test.js`, `config.test.js`),
event log (`events.test.js`), redaction (`redact.test.js`), persistence (`persist.test.js`),
routing (`routing.test.js`), provider health (`provider-health.test.js`,
`provider-health-routing.test.js`), sessions (`sessions.test.js`, `sessions-cli.test.js`),
blackboard (`blackboard.test.js` 890 ln, `blackboard-cli.test.js` 490 ln), the whole agent
subsystem (`agent-cli`, `agent-context`, `agent-definitions`, `agent-registry`,
`agent-requirements`, `agent-runtime` 670 ln, `agent-tools` 538 ln, `agent-wiring` 770 ln), real
tools (`real-tools.test.js` 979 ln — the single largest test file), path safety
(`tool-paths.test.js`), the dashboard (`dashboard.test.js`), and the four new tribunal files.

**Test-to-source ratio is healthy** — several test files exceed the size of the module they cover.

**What tests do NOT do:** they do not touch the network. Live provider probing is only exercised by
`aflow doctor`/`models --probe` against a running gateway (`README.md:390-393`). The tribunal tests
use a fake `complete()` function, so no live model is required.

**Missing/absent test infrastructure (explicitly):** no coverage tool configured, no test fixtures
directory convention beyond inline data, no CI-gated tests beyond the workflow described in §7.

---

## 7. Scripts and tooling

`package.json` scripts:

| Script | Command | Purpose |
|---|---|---|
| `test` | `node scripts/run-tests.mjs` | full unit suite |
| `aflow` | `node bin/aflow.js` | local invocation |
| `doctor` | `node bin/aflow.js doctor` | convenience |
| `scan-secrets` | `node scripts/scan-secrets.mjs` | committed-credential scan |

`scripts/` contents:
- **`run-tests.mjs`** (61) — test discovery + runner.
- **`scan-secrets.mjs`** (423) — scans tracked files/history for credential shapes; run in CI.
- **`check-exposure.mjs`** (175) — inspects the *known public exposures* listed in
  `config/exposure.json` by retrieving them and matching in memory; reports rule name only, never
  the matched text.

**CI** — `.github/workflows/test.yml` (5038 bytes) runs on a Node 20/22/24 matrix with
`AGENTFLOW_API_KEY=""` and `AGENTFLOW_BASE_URL="http://127.0.0.1:1"` (deliberately unreachable), plus
two security jobs: `secrets-history` (fails if a credential is found in history) and
`secrets-exposure` (hourly, fail-closed, checks the known exposures). There is **no** lint step, no
type-check step, and no formatter config (no ESLint/Prettier/`.editorconfig`).

---

## 8. Security posture

**Design.** Credentials are redacted centrally (`core/redact.js`) before any value reaches a
terminal, log, session file, or blackboard file; a credential-shaped value that survives redaction
is *refused* rather than stored (`README.md:128-129,173-174`). The model is treated as the untrusted
party; permissions are enforced by allowlist, not by prompt instruction (`README.md:204-226`).
Approvals **fail closed**: without a TTY, gated actions are refused (`README.md:228-233`).

**Known, unresolved exposure (do not weaken or suppress).** The inherited engine shipped hardcoded
third-party credentials. Two are still publicly retrievable and are tracked in
`config/exposure.json`:

| id | shape | path | GitHub alert | owner action |
|---|---|---|---|---|
| `windsurf-firebase-web-api-key` | firebase-web-api-key | `open-sse/providers/registry/windsurf.js` | **Alert #1 (open)** | decolua must restrict/rotate in Google Cloud |
| `iflow-oauth-client-secret` | inline-secret-assignment | `open-sse/providers/registry/iflow.js` | none raised | decolua must rotate the OAuth client secret |

Both were committed 2026-10-03; the repo is public, so `config/exposure.json:14-15` states the
assumption that they were harvested and rotation is urgent. **The credentials remain live and
un-rotated as of this report.** The local tree and history scans are otherwise clean. The
`SECURITY_DISCLOSURE_STATUS.md` documents the disclosure track; the reporting route was blocked
(no outside-reporter API / no upstream write access). `GHSA-35rj-mq32-7gcj` is the associated
advisory.

**Hardening already in place:** env-sourced OAuth clients for Google, Antigravity, iFlow, Windsurf
(`PROJECT_ORIGIN.md:64-81`); `scan-secrets.mjs` in CI; path containment for filesystem tools;
shell allowlist; output-contract enforcement.

**Residual risk:** the two live credentials; the 402-file inherited engine is a large unaudited
surface; `open-sse/`'s proxy/stream code patches global `fetch` (`open-sse/AGENTS.md:20`) which is a
non-trivial trust boundary.

---

## 9. Git history

- **First commit:** `0aeb360f` "Initial commit", 2026-10-03 23:10:17 +0530.
- **Last commit:** `ec7e8f8a` (2026-10-11) — the tribunal core.
- **Commit count:** 54 on `feature/tribunal-self-review`, 53 on `main`.
- **Authors:** a single committer (`anand-cpp`).
- **Merge commits visible near the tip:** `e232cac6` (Merge PR #9 provider-health-foundation),
  `f30b059d` (Merge PR #8), `5d527c33` (Merge PR #6) — so the project has used pull-request merges
  for at least three features.
- **Tags:** 90 (inherited upstream labels `v0.2.21`–`v0.5.95`; they do **not** annotate AgentFlow's
  own commit graph).
- **Unpushed work:** exactly one commit (`ec7e8f8a`) is ahead of `origin/main` on the current
  branch.

The history is honest about provenance: upstream 9Router's 1,364 commits are **not** present
(`PROJECT_ORIGIN.md:21-29`); attribution is carried by documentation instead.

---

## 10. Documentation state

| File | Bytes | Notes |
|---|---|---|
| `README.md` | 16304 | full user-facing doc: install, every command, sessions, blackboard, agents, config, exit codes, security, provenance |
| `SECURITY.md` | 13968 | disclosure policy + the credential incident |
| `SECURITY_DISCLOSURE_STATUS.md` | 8350 | live disclosure tracker |
| `PROJECT_ORIGIN.md` | 5952 | what came from 9Router, file-level modification log |
| `THIRD_PARTY_NOTICES.md` | 4893 | retained third-party obligations |
| `AUDIT/FEATURE_AUDIT.md` | 10878 | capability comparison |
| `AUDIT/ARCHITECTURE_AUDIT.md` | 15921 | kept/rewritten/dropped |
| `AUDIT/DEPENDENCY_AUDIT.md` | 6994 | dependency posture |
| `AUDIT/LICENSE_AUDIT.md` | 7472 | license provenance |
| `AUDIT/OPENCODE_STUDY.md` | 12771 | architecture study (no code copied) |
| `AUDIT/DEEPSEEK_HARNESS_STUDY.md` | 16806 | architecture study |
| `AUDIT/UPSTREAM_CODE_MAP.md` | 7612 | path-level provenance ledger |

**Documentation is unusually strong for a 0.1.0 project**, but it contains **stale figures** that
should be corrected (see §17):

- `README.md:41` claims **"558 tests passing"**.
- `README.md:387` claims **"43 tests"** under Development.
- `PROJECT_ORIGIN.md:92-98,118-122` says the agent runtime, tools, permissions, sessions, routing
  policy, and standalone gateway are **"not started"** — but the runtime, tools, permissions,
  sessions, and routing policy all exist and are tested (only the standalone gateway and plugin
  loader remain unbuilt).
- `PROJECT_ORIGIN.md:119` says "43 passing"; actual is 764.

The actual, verified count is **764 passing** on this branch.

---

## 11. What works right now (dynamically verified)

The following were executed on this machine against the checked-out tree.

**Install:** none required — zero dependencies. `node bin/aflow.js` runs from source immediately.
(No `npm install` needed; a lockfile-less `npm ci` would fail by design.)

**Version:** `aflow 0.1.0` / `terminal-first AI routing and agent platform`.

**Help:** `aflow --help` prints all 11 commands and the 7 global flags (see §3).

**Agent fleet:** `aflow agent list` prints all eight built-ins with privilege levels:

```
coder       high           Implement a change and show evidence it works.
debugger    high           Find the actual cause of a failure, then fix that and nothing else.
planner     read-only      Turn an objective into an ordered, checkable plan.
release     elevated       Prepare a release and verify it, publishing only on explicit instruction.
researcher  elevated       Answer a question from evidence, and say how confident that is.
reviewer    read-only      Judge a change against what it was supposed to do.
security    read-only      Find the vulnerability that is actually there, not the one that is easy to report.
tester      high           Prove a change works, or prove precisely that it does not.

8 built-in agent(s)
```

**Config:** `aflow config` resolves and shows origin per key:

```
KEY             VALUE                   ORIGIN
baseUrl         http://localhost:20127  default
apiKey          ***                     set
...
Layers read (low → high)
  defaults only
```

Note `apiKey ***  set` — a key is present in the environment/config and is correctly masked in both
text and `--json` output.

**Doctor:** runs and reports real status (no gateway running):

```
node               ok            24.19.0
config             ok            defaults
google-oauth       unconfigured  set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable
antigravity-oauth  unconfigured  set ANTIGRAVITY_OAUTH_CLIENT_ID and ANTIGRAVITY_OAUTH_CLIENT_SECRET…
gateway            error         http://localhost:20127 — cannot reach gateway …

x 1 problem(s) found
```

**Status:** degrades gracefully with an actionable message:
`gateway unreachable at http://localhost:20127 / start it with: node custom-server.js --port 20127 /
or point aflow elsewhere: aflow status --base-url http://host:port`.

**Logs:** reads the real JSONL log at
`C:\Users\anand\AppData\Local\agentflow\agentflow.jsonl` (3 recorded `gateway.error` events —
requested base urls `http://127.0.0.1:1` and `http://localhost:20127`).

**Sessions:** `aflow sessions list` → "no sessions yet" (store at
`C:\Users\anand\AppData\Local\agentflow\sessions`).

**Blackboard:** `aflow blackboard show` resolves the current project and prints live state — this is
the most demonstrably working subsystem:

```
blackboard bb2be8b48225
project    C:\Users\anand\9router
goal       Durable, concurrency-safe agent state with real tools that cannot esc…
objective  Deliver context packet + continuity primitives (done), then wire auto…
next       Construct ProviderHealth in AgentRuntime, pass it to the Router, and call
           continueSession on a classified transient failure (t7). (10-11 04:47)
open (1)   t7 pending Wire automatic cross-provider switching into AgentR…
```

**Tests:** `npm test` → **764 pass / 0 fail** in ~7.5 s.

**Verdict:** the CLI, config, redaction, sessions, blackboard, agent runtime, tests, and the
dashboard all run. The **only** thing that does not work standalone is anything requiring a live
gateway (`doctor`'s gateway/probe check, `models`, `route`, `status --probe`, `agent run` against a
real model) — because **no gateway is running on port 20127 and none ships with this repo yet**.

---

## 12. What is incomplete or broken

1. **Standalone gateway does not exist.** `README.md:49` says the standalone gateway "Runs via
  9Router's server; bundled gateway in progress." `PROJECT_ORIGIN.md:61` lists `custom-server.js`
  as "Not yet imported." So AgentFlow **depends on an external gateway** to do anything model-backed.
   `status` even tells you to start `custom-server.js`, a file that is **not present in this repo**.
2. **Plugin loader: not started** (`README.md:48`). No plugin directory, loader, or hook exists.
3. **Automatic cross-provider switching is not wired.** The primitives exist
   (`provider-health.js`, `routing.js`, continuity/session primitives) but `AgentRuntime` does not
   yet construct `ProviderHealth` and pass it to the `Router`, nor call `continueSession` on a
   transient failure. This is tracked as blackboard task **t7 (pending)**.
4. **The tribunal is only stage 1 of 5.** Only self-review + confidence + stage exist. External
   cross-examination, the 5-stage pipeline (Forge/Crucible/Merge/Trial/Oracle), a `--tribunal` CLI
   flag, and durable tribunal audit records are **not built**.
5. **Documentation drift** (see §10/§17): README test counts (558, 43) and PROJECT_ORIGIN "not
   started" claims are wrong against the actual code.
6. **No lint/format/type tooling** — nothing prevents style drift.
7. **`open-sse/` is only partially integrated from AgentFlow's perspective** — several upstream
   components (SQLite persistence `src/lib/db/`, OAuth flows `src/lib/oauth/`, the standalone server,
   upstream tests) are listed "Not yet imported" (`PROJECT_ORIGIN.md:59-62`).
8. **Two live credentials** remain unresolved (§8).
9. **`npm audit` cannot run** (no lockfile) — by design, but it means CVE tooling is unavailable for
   the inherited engine unless a lockfile is generated in a scratch dir.

**TODOs in source:** a repo-wide scan for `TODO|FIXME|XXX|HACK` across `src/`,`bin/`,`scripts/`,
`test/` returned **only false positives** (the string "TODO" used as test data and a variable named
`todo`). There are effectively **no developer TODO markers in the codebase** — notable and worth
flagging, since it means deferral is tracked in the Blackboard, not in code comments.

---

## 13. External integrations

| Integration | Status | Evidence |
|---|---|---|
| OpenAI-compatible gateway (HTTP) | **Required at runtime**; client implemented in `core/gateway.js` | `status`/`doctor`/`models`/`route` all call it |
| 9Router routing/translation engine | **Bundled** (`open-sse/`, 402 files, 89 providers) | `PROJECT_ORIGIN.md:52-57` |
| Google OAuth | env-gated, `unconfigured` by default | `doctor` output; env vars `GOOGLE_OAUTH_CLIENT_ID/SECRET` |
| Antigravity OAuth | env-gated, `unconfigured` | `doctor` output |
| iFlow OAuth | env-gated; associated with the live secret | `config/exposure.json` |
| Windsurf / Firebase | env-gated; associated with the live key | `config/exposure.json` |
| GitHub (`gh`) | used for disclosure workflow | `SECURITY_DISCLOSURE_STATUS.md` |
| Platform state dir (`LOCALAPPDATA`) | sessions + blackboard + logs | `sessions list` output path |

There are **no** database integrations (SQLite listed as not imported), no message queues, no
telemetry/analytics, and no model-weight downloads.

---

## 14. Runtime assumptions

- **Node ≥ 20** (verified running on 24.19.0; CI matrix also tests 20 and 22).
- **A gateway must be reachable** at the configured `baseUrl` (default
  `http://localhost:20127`) for any model-backed command. This gateway is **not** part of the repo.
- **Credentials** for gated providers come from env vars, never from committed files.
- **A TTY** is assumed for interactive approval and full-screen dashboard; without one, the system
  degrades correctly (snapshot output; gated tool actions refused).
- **State lives outside the repo**, under the platform state dir
  (`AGENTFLOW_STATE_DIR`, else `LOCALAPPDATA`/XDG equivalent) — verified at
  `C:\Users\anand\AppData\Local\agentflow\`.
- **Filesystem tools are workspace-scoped**: the run root is resolved to a physical path before
  anything executes and cannot be widened from inside a run (`README.md` agent section).
- **Zero-dependency start** means no build/install step is required to run the CLI from source.

---

## 15. Planned but not built

Confirmed non-existent (verified absent, not merely undocumented):

- **Plugin loader / plugin architecture** — no plugin directory or hooks anywhere.
- **Standalone / bundled gateway** (`custom-server.js`, `src/lib/`) — absent.
- **Tribunal stages 2–5** (external cross-examination, Merge/Trial/Oracle) — absent; only stage 1
  shipped.
- **`--tribunal` CLI flag** — absent (no tribunal command).
- **SQLite persistence layer** (`src/lib/db/`) and **OAuth provider flows** (`src/lib/oauth/`) —
  absent (listed "Not yet imported").
- **Continuity wiring into `AgentRuntime`** — primitives exist, runtime integration does not (t7).
- **Any "95% confidence gate" / consensus / multi-model debate** — the reconnaissance confirmed
  these concepts do **not** exist in the codebase.

---

## 16. Top-20 file index (by line count)

| # | File | Lines |
|---:|---|---:|
| 1 | `src/core/agents/runtime.js` | 1249 |
| 2 | `src/core/blackboard.js` | 1248 |
| 3 | `test/real-tools.test.js` | 979 |
| 4 | `test/blackboard.test.js` | 890 |
| 5 | `test/agent-wiring.test.js` | 770 |
| 6 | `test/agent-runtime.test.js` | 670 |
| 7 | `src/commands/blackboard.js` | 573 |
| 8 | `src/core/agents/definitions.js` | 540 |
| 9 | `test/agent-tools.test.js` | 538 |
| 10 | `src/core/agents/tools.js` | 518 |
| 11 | `src/commands/agent.js` | 516 |
| 12 | `src/core/agents/registry.js` | 510 |
| 13 | `src/core/sessions.js` | 495 |
| 14 | `test/blackboard-cli.test.js` | 490 |
| 15 | `src/core/agents/tool-filesystem.js` | 487 |
| 16 | `test/sessions.test.js` | 479 |
| 17 | `src/core/routing.js` | 432 |
| 18 | `src/commands/sessions.js` | 427 |
| 19 | `scripts/scan-secrets.mjs` | 423 |
| 20 | `src/core/agents/tool-shell.js` | 389 |

Totals: `src/` = 43 files / ~501 KB; `test/` = 29 test files; `open-sse/` = 402 files.

---

## 17. Honest self-assessment

**Strengths.** The engineering discipline is the standout. Zero runtime dependencies, atomic
writes, fail-closed approvals, central redaction that *refuses* un-redactable secrets, output
contracts, bound enforcement checked before and after each call, separate tracking of
completed/timedOut/cancelled, and a test suite (764) that is large relative to the code and covers
error paths (corrupt files, non-JSON model output, fail-closed permissions). Provenance is
documented rather than quietly assumed. The "advertised vs working model" framing is a real,
differentiated product idea.

**Weaknesses.** The headline capability — actual model routing — cannot be exercised without an
external gateway that this repo does not contain, so the flagship feature is unproven
end-to-end here. The "tribunal" (this branch's principal new work) is only one of five stages.
Documentation has drifted from reality in exactly the places a new collaborator reads first
(test counts; "not started" claims). Two genuine credentials remain live. There is no lint/type
gate.

**Risks for the next collaborator.** (1) Don't trust README counts — run `npm test` (764). (2) Don't
assume a gateway exists — build/point one first. (3) Don't touch the two exposures or the
`secrets-exposure` CI job; they are intentionally red until rotation is confirmed. (4) The
`open-sse/` engine is the largest and least-audited surface.

**Maturity call:** a well-built 0.1.0 with an honest, tested CLI and state layer; the model-facing
half is architecturally ready but operationally incomplete (no in-repo server, no plugins, tribunal
1/5).

---

## 18. Additional findings and recommendations

**Documentation corrections (highest-value, low-risk):**
1. Fix `README.md:41` ("558 tests") and `README.md:387` ("43 tests") → the real number (764), or
   better, make them non-brittle ("the CLI has no runtime dependencies; run `npm test`").
2. Fix `PROJECT_ORIGIN.md:92-98,118-122` — the runtime, tools, permissions, sessions, and routing
   engine are built and tested; only the gateway and plugin loader are not.
3. `PROJECT_ORIGIN.md:62` lists a `tests/` directory "Not yet imported" while `test/` exists —
   clarify the naming.

**Structural:**
4. `status` prints "start it with: `node custom-server.js --port 20127`" but `custom-server.js` is
   not in the repo — either add a stub pointer to where the gateway can be obtained or change the
   message.
5. Consider a tiny lockfile workflow for the *inherited* engine only (in a scratch dir) so `npm
   audit` can run against `open-sse/`'s effective dependency graph without polluting the
   zero-dep CLI.
6. Add ESLint (flat config) + a CI lint job; the zero-dep philosophy is compatible with a
   dev-only linter.

**Security (do not weaken the existing gates):**
7. The two live exposures remain the top open risk. Rotation is owned upstream (decolua); the
   GitHub alert (#1) and `secrets-exposure` job should stay red until both (a) owner rotation and
   (b) pre-purge object removal are confirmed, per `config/exposure.json:9-15`.

**Roadmap sequencing (aligning with the Blackboard):**
8. **t7** (wire `ProviderHealth` into `AgentRuntime` + `continueSession` on transient failure) is
   the natural next coding task and is already recorded as `next`.
9. Continue the tribunal toward stages 2–5 + the `--tribunal` flag + durable audit records (reuse
   the existing Session/Blackboard/event/redaction plumbing rather than a parallel store).
10. The standalone gateway is a prerequisite for any credible end-to-end demo; it is currently the
    single largest gap between "tested library" and "usable product."

**Verified caveats:** line counts are direct measurements; the "764 pass" and CLI outputs are real
command output from this machine (Node 24.19.0); anything not reproduced here is marked as such or
omitted. No credential values appear in this report by design.

