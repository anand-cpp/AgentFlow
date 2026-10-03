# Architecture Audit — 9Router (upstream baseline)

**Audit date:** 2026-10-03
**Audited revision:** `a99cf572` (tag `v0.5.95`)
**Upstream:** https://github.com/decolua/9router
**Method:** direct reading of tracked source at the audited revision. No assumptions carried over from documentation.

---

## 1. Scale (measured, not estimated)

| Metric | Value |
|---|---|
| Tracked files | 1716 |
| JavaScript / MJS / JSX files | 1334 |
| JavaScript lines (tracked) | ~170,957 |
| Providers in registry | ~125 entries |
| Models exposed via `/v1/models` (runtime, authenticated-free probe) | 790 |
| Commits in history | 1364 |
| Commits authored by `decolua` (3 emails) | 638 |
| Commits authored by `anand-cpp` | **0** |

### Tracked files by top-level directory

| Count | Path | Role |
|---|---|---|
| 546 | `src/` | Next.js app: dashboard UI, REST APIs, SQLite persistence |
| 402 | `open-sse/` | Provider-agnostic routing + translation engine ("open-sse") |
| 351 | `tests/` | Vitest suite (independent package, not wired to root `npm test`) |
| 201 | `public/` | Static dashboard assets |
| 120 | `gitbook/` | Legacy documentation site |
| 35 | `cli/` | npm launcher package (`9router`) — server launcher + tray |
| 10 | `i18n/` | Localized READMEs |
| 10 | `skills/` | Bundled agent skill definitions |
| 7 | `docs/` | ARCHITECTURE.md + images |
| 6 | `.github/` | CI workflows |
| 5 | `scripts/` | Registry codegen + build asset copy |

---

## 2. Actual runtime architecture

Verified against `package.json`, `custom-server.js`, `next.config.mjs`, and the upstream `CLAUDE.md`.

```
Client (Claude Code / Cursor / Cline / opencode / SDK)
  │
  │  http://localhost:20127/v1        (OpenAI + Anthropic compatible)
  ▼
Next.js middleware (src/dashboardGuard.js, src/proxy.js)
  │
  ▼
src/app/api/v1/*            rewrite target for /v1/*  (next.config.mjs)
  │
  ▼
src/sse/handlers/chat.js    parse · combo expansion · account-selection loop · auth
  │
  ▼
open-sse/handlers/chatCore.js   source-format detection · request translation
  │                              dispatch · retry · token refresh · stream setup
  ▼
open-sse/executors/*.js     one per non-OpenAI-compatible upstream
  │                         (kiro.js, codex.js, cursor.js, commandcode.js, ...)
  │                         default.js serves every OpenAI-compatible upstream
  ▼
open-sse/translator/*       client format ↔ provider format, pivoting via OpenAI
  ▼
Upstream provider (Anthropic, OpenAI, AWS CodeWhisperer, …)
```

### The central design decision

All request/response translation pivots through **OpenAI as the intermediate format**, except where a
translator is registered on an exact `source:target` pair (a "direct route", e.g. `claude:kiro`) which
skips the lossy double-hop.

**Audited risk:** the pivot-through-OpenAI default is lossy for fragile payloads — thinking blocks,
tool-call IDs, non-base64 images, `is_error` flags. Upstream acknowledges this in its own
`CLAUDE.md`. Several commits in the log are direct fixes for exactly this class of bug
(`fix(claude): preserve intentional prefill from non-messages[] source formats`,
`fix(capabilities): publish real GPT-6/GPT-5.4+ context windows`). This is structural debt, not
incidental.

---

## 3. Provider system

- One file per provider: `open-sse/providers/registry/<id>.js`.
- `registry/index.js` is **auto-generated** static imports (regenerate via
  `scripts/migrate-registry.mjs`; do not hand-edit).
- Registry entries co-locate `transport` (baseUrl, format, headers, retry, auth) with `models`.
- `open-sse/providers/index.js` builds `PROVIDERS`, `PROVIDER_MODELS`, `PROVIDER_OAUTH`,
  `PROVIDER_MEDIA` from the registry barrel.
- Per-provider non-OpenAI executors live in `open-sse/executors/`.
- Binary/protobuf upstreams (Kiro EventStream, Cursor protobuf, CommandCode NDJSON) are parsed
  **inside their own executor**, explicitly not in the translator layer.

**Audited assessment:** the provider *data* is cleanly separated. The provider *behaviour* is not —
format translation is a central switch with per-pair registration, so provider quirks leak into a
shared namespace. This is the single biggest refactor target for a provider-adapter interface.

---

## 4. Model handling

- Model catalogues are **static, per-provider arrays** in registry files (e.g. Kiro declares ~50
  Claude/GPT/GLM/MiniMax idents inline).
- Optional live catalogues via `modelsFetcher: { url, type }` (OpenRouter, OpenCode Zen/Go).
- Runtime `/v1/models` served **790** models with no credentials configured.
- Model-intent modifiers are faked suffixes parsed out before dispatch: `-thinking`, `-agentic`,
  `-level<effort>`, `-budget<n>` (see `open-sse/config/kiroConstants.js`, `parseSuffix`).
  `kiroConstants.js` states plainly: *"Kiro upstream does not advertise `-agentic` model IDs; they
  are a 9router fiction. The suffix is stripped before the request leaves this process."*
- `passthroughModels: true` on several providers forwards unknown ids upstream unvalidated.

**Audited assessment:** there is **no provider-neutral model registry**. Capabilities are scattered
across `open-sse/providers/capabilities.js`, per-registry `supportedFormats`, and hardcoded
conditionals. Adding a provider requires touching shared code. Confirmed target for a real
`ModelRegistry`.

---

## 5. Authentication and secrets

| Concern | Implementation |
|---|---|
| Dashboard login | `src/app/api/auth/login` — bcrypt hash, else `INITIAL_PASSWORD` env, else literal `123456` |
| Sessions | JWT in `auth_token` cookie (`src/lib/auth/dashboardSession.js`) |
| Login rate limit | `src/lib/auth/loginLimiter.js`, IP-derived |
| Tunnel gating | Login blocked over tunnel/tailscale host unless `tunnelDashboardAccess` |
| API keys | `apiKeys` table; `settings.requireApiKey` defaults **true** |
| Client IP | `custom-server.js` derives from TCP socket, strips attacker-controlled `X-Forwarded-For` |

**Verified defaults requiring change before any exposure:**

- `settingsRepo.js:26-27` — `requireLogin: true`, `requireApiKey: true`.
- `.env.example` ships `INITIAL_PASSWORD=change-me`, `JWT_SECRET=change-me-to-a-long-random-secret`,
  `API_KEY_SECRET=endpoint-proxy-api-key-secret`.
- Upstream `CLAUDE.md` states plainly: *"`INITIAL_PASSWORD` (default `123456` — must override)"*.

**Positive finding:** `src/app/api/cli-tools/resolveApiKey.js` documents and fixes a real prior bug
where the literal placeholder `"sk_9router"` was written into CLI configs, producing 401s under
`requireApiKey=true` (#4399). Good defensive-comment culture.

---

## 6. Persistence

- **Not** `db.json`. SQLite via `src/lib/db/` with an adapter fallback chain
  (`src/lib/db/driver.js`): `bun:sqlite` → `better-sqlite3` → `node:sqlite` (Node ≥22.5) → `sql.js`.
- `better-sqlite3` is in `optionalDependencies` on purpose so install never hard-fails without build
  tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code
  should import from `@/lib/db/index.js`.
- DB path from `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage logs (`src/lib/usageDb.js` → `usage.json`, `log.txt`) still under `~/.9router` and do **not**
  honour `DATA_DIR`.

**Audited finding:** `ARCHITECTURE.md` is **stale** — upstream's own `CLAUDE.md` says so explicitly
("ARCHITECTURE.md is stale here"). Confirmed: the doc describes the retired `db.json` model.

- **Observed at runtime:** `[DATA_DIR] '/var/lib/9router' is a Unix path on Windows → fallback to
  default`. Path resolution is not cross-platform-hardened.

---

## 7. CLI — what actually exists

`cli/` is a **separate npm package** (`name: "9router"`, `bin: {"9router": "./cli.js"}`,
versioned independently at 0.5.95). It is **not** an AI agent CLI. It is a **server launcher and
tray manager**.

Verified contents of `cli/cli.js` (790 lines):

- Starts/stops the Next.js server; spawns via shell.
- System tray: `tray/tray.js` (systray2), `tray/trayWin.js` (PowerShell `NotifyIcon`),
  `tray/tray.ps1`, tray icons, `scripts/buildTrayArm64.js`.
- Autostart registration (`tray/autostart.js`).
- Cloudflared tunnel management — spawns `cloudflared.exe`, enumerates processes via
  `Get-WmiObject Win32_Process` (Windows) and `ps -eo pid,command` (POSIX).
- Interactive `enquirer` menus: `menus/apiKeys.js`, `menus/cliTools.js`, `menus/combos.js`,
  `menus/providers.js`, `menus/settings.js`.
- Exactly **two** subcommands: `9router xai video` (`commands/xaiVideo.js`) and
  `9router connect` (`commands/connect.js`, added in `31704db7`).
- `--help` / `-h` only. No `--version`, no `--json`, no `--quiet`, no `--debug`, no `--no-color`.

**Audited conclusion — the central gap:**

| Directive requirement | Present in `cli/`? |
|---|---|
| `init` | No |
| `run` / `chat` | No |
| `agent` / `agents` | No |
| `models` / `providers` / `routes` | No |
| `config` | No |
| `doctor` | No |
| `plugins` | No |
| `status` | No |
| `logs` | No |
| `history` | No |
| `version` | No |

There is **no agent runtime, no tool registry, no session manager, no permission system, and no
plugin system** anywhere in the repository. `skills/` (10 files) is documentation-style content, not
an executable plugin loader. Sessions exist only as provider-usage/quota rows, not as conversational
transcripts.

---

## 8. Streaming, retry, fallback

- Streaming: SSE throughout; per-provider executors own their framing. Kiro uses AWS EventStream
  (`vnd.amazon.eventstream`) with a CRC32 validator and an 8 MiB repair buffer
  (`open-sse/executors/kiro.js`).
- Retry/fallback lives in `chatCore.js` (retry, token refresh) and `handlers/chat.js`
  (account-selection loop, combo expansion).
- Per-provider retry policy is declared in the registry, e.g. Kiro sets `retry: { "429": 0 }`.
- Model **combos** are a first-class upstream concept (dashboard → Combos, `menus/combos.js`):
  an ordered model list per entry that fails over down the chain.

**Audited assessment:** combo-based fallback is genuinely the strongest routing idea in the
codebase and is worth keeping and generalising into an explicit, observable policy engine.

---

## 9. RTK token saver

`open-sse/rtk/` — pre-translate hooks that compress `tool_result` content in place.
**Fail-open by design:** any error returns `null` and leaves the body untouched; never throws.
Skips `is_error` / `status:"error"` results to preserve failure traces.

Upstream README claims **20-40% token savings**. This was **not** measured during this audit and
must not be restated as a verified figure in derived documentation without re-measurement.

---

## 10. Testing state

- Suite: `tests/`, **351 tracked files**, Vitest.
- **No root `npm test` script.** `tests/` is an independent ESM package.
- `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — broken
  on Windows by upstream's own admission.
- `tests/node_modules` **not installed** in this clone; suite not yet executed.
- `tests/__baseline__/known-fails.txt` exists; upstream states the suite is **not** expected to be
  all-green (~938 pass / ~64 fail on a plain checkout), with 26 catalogued known failures.

---

## 11. Build system

- Next.js 16 with `output: "standalone"`, built with `--webpack`.
- `custom-server.js` wraps the standalone server (client-IP derivation, X-Forwarded-For stripping).
- `npm run build` **verified working** on Windows in this clone; standalone assets copied by
  `scripts/copy-standalone-assets.mjs`.
- Runtime warns: `"next start" does not work with "output: standalone"`. The `start` script
  (`node custom-server.js --port 20127`) does work — verified serving HTTP 200 on `/api/version`.
- Port discrepancy: `package.json` scripts hardcode `--port 20127` while `.env.example` documents
  `PORT=20128` and upstream `CLAUDE.md` claims "Default runtime port is **20128**". Setting `PORT`
  has **no effect**. Documentation and code disagree.

---

## 12. Classification summary

### KEEP (strong, worth building on)

| Subsystem | Why |
|---|---|
| `open-sse/` translator + executor split | Correct seam between provider data and provider behaviour |
| Combo fallback concept | Best routing idea present; needs promotion to first-class policy engine |
| RTK fail-open design | Correct safety posture for lossy optimisation |
| `custom-server.js` X-Forwarded-For stripping | Deliberate, documented anti-spoofing measure |
| SQLite adapter fallback chain | Pragmatic cross-platform persistence |
| `resolveApiKey.js` placeholder-guard | Evidence of a security-aware maintainer |
| Per-provider registry-as-data | Clean separation of provider *declarations* |

### REFACTOR

| Subsystem | Target |
|---|---|
| `open-sse/translator/` central switch | Replace pair-registration switch with an explicit adapter interface |
| Model catalogue | Extract into a provider-neutral `ModelRegistry` with capability metadata |
| `src/lib/localDb.js` shim | Remove; force `@/lib/db/index.js` |
| Combo fallback | Promote to observable, policy-driven router with structured events |
| `cli/` argument handling | Replace ad-hoc `process.argv` scan with a real command router |
| Port config | Single source of truth; remove the 20127/20128 contradiction |
| `ARCHITECTURE.md` | Rewrite; it currently documents a retired persistence model |

### REPLACE

| Subsystem | Reason |
|---|---|
| `cli/` launcher-only scope | Provides no agent surface; needs a genuine CLI built alongside/below it |
| Interactive-only menus | Directive requires scriptable, non-interactive-safe operation |
| Implicit provider behaviour in shared namespaces | Provider quirks must live in provider adapters |

### REMOVE (from the derived product)

| Item | Reason |
|---|---|
| System tray + autostart + cloudflared tunnel | Desktop-GUI concerns, out of scope for a terminal-first product. Not deleted from this clone — just excluded from the new product surface. |
| `gitbook/` (120 files) | Superseded legacy docs |
| `i18n/` localized READMEs (10) | Not relevant to a single new product identity |
| `mitm/` | Interception-proxy feature; large surface, unrelated to routing/agents, carries legal risk. Recommend dropping. |
| Duplicated `LICENSE` (`cli/LICENSE`, MIT "9Router Contributors") | Consolidate into one root license + `THIRD_PARTY_NOTICES.md` |

### NEW (none of these exist upstream)

`cli` command router · agent runtime · built-in agents · orchestration · tool registry ·
permission/approval system · plugin architecture with manifests and lifecycle · session manager ·
provider-neutral model registry · provider adapter interface · routing policy engine with
observable events · structured logging/`--json` output · `doctor` diagnostics · secret redaction ·
comprehensive test suite wired to root scripts · CI.

---

## 13. Central architectural tension (must be decided before implementation)

The upstream product is a **Next.js web dashboard + routing gateway**, launched by a small
tray-app CLI.

The target product is a **terminal-first AI routing and agent platform**.

These are different shapes. The routing/provider engine (`open-sse/`, 402 files) transfers well. The
Next.js dashboard (546 files in `src/`) does **not** — a terminal-first CLI has no use for most of
it, and it is the majority of the codebase.

This decision (how much of `src/` to retain, and whether the web dashboard survives at all) governs
the entire implementation phase and is **not** resolvable from the source alone. See the preflight
report.