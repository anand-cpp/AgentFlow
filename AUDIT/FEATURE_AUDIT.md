# Feature Audit — what 9Router actually does

**Audit date:** 2026-10-03
**Audited revision:** `a99cf572` (tag `v0.5.95`)
**Method:** read from source. Where this document disagrees with the upstream README, the source
was treated as authoritative and the discrepancy is noted.

---

## 1. Capability inventory

Legend: **WORKS** = verified this audit · **PRESENT** = read in source, not exercised ·
**ABSENT** = does not exist.

### 1.1 Routing and provider layer

| Capability | Status | Evidence |
|---|---|---|
| OpenAI-compatible `/v1/chat/completions` | **WORKS** | Live completion returned `PONG`, HTTP 200 |
| Anthropic-compatible `/v1/messages` | **WORKS** | HTTP 200, correct `text/event-stream`, valid `message_start`/`message_delta`/`message_stop` frames |
| `/v1/models` catalogue | **WORKS** | 790 models served, no credentials configured |
| Cross-format translation (OpenAI ↔ Anthropic ↔ provider) | **PRESENT** | `open-sse/translator/`, pivots via OpenAI |
| Direct-translation fast paths | **PRESENT** | `register(from,to,…)`; e.g. `claude:kiro` |
| Per-provider executors | **PRESENT** | `open-sse/executors/` incl. `default.js` |
| Retry | **PRESENT** | `chatCore.js`; per-provider policy e.g. Kiro `retry: {"429": 0}` |
| Multi-account round-robin | **PRESENT** | account-selection loop, `handlers/chat.js` |
| Model **combos** (ordered fallback chain) | **PRESENT** | dashboard Combos, `cli/src/cli/menus/combos.js` |
| Token refresh | **PRESENT** | `open-sse/services/tokenRefresh.js` |
| Streaming (SSE) | **WORKS** | verified |
| Provider health tracking | **PARTIAL** | implicit via retry/backoff; no first-class health model |
| Observable structured routing events | **ABSENT** | no structured event bus; routing decisions not machine-readable |
| Routing policy engine | **ABSENT** | fallback is combo-list + retry logic, not a policy abstraction |

### 1.2 Quota and usage

| Capability | Status | Evidence |
|---|---|---|
| Per-provider quota fetchers | **PRESENT** | `open-sse/services/usage/` (~14 providers) |
| Quota dashboard UI | **PRESENT** | `dashboard/usage/components/ProviderLimits/` |
| Quota auto-ping to warm reset windows | **PRESENT** | `src/shared/services/quotaAutoPing.js` |
| "Unlimited" tier | **ABSENT — see §2** | display flag only |

### 1.3 RTK token saver

| Capability | Status | Evidence |
|---|---|---|
| `tool_result` compression | **PRESENT** | `open-sse/rtk/`, fail-open by design |
| 20-40% savings claim | **UNVERIFIED** | README claim only. Not measured in this audit. Must not be restated as fact. |

### 1.4 Authentication and dashboard

| Capability | Status | Evidence |
|---|---|---|
| Dashboard web UI | **WORKS** | `/dashboard` HTTP 200 |
| Password login (bcrypt) | **WORKS** | logged in successfully |
| Login rate limiting | **PRESENT** | `src/lib/auth/loginLimiter.js` |
| JWT session cookie | **WORKS** | `auth_token` issued |
| API keys (CRUD) | **WORKS** | created one (`sk-<redacted>` - local only, never committed) |
| API key enforcement | **WORKS** | 401 "Missing API key" when `requireApiKey=true` and no key |
| Tunnel/tailscale access gating | **PRESENT** | `settingsRepo.js`, login route |
| Multi-provider OAuth (Kiro, Codex, Claude, GLM, Cursor, …) | **PRESENT** | `src/lib/oauth/providers/`, `open-sse/providers/registry/*` |
| X-Forwarded-For spoofing defence | **WORKS** | `custom-server.js` derives client IP from TCP socket |
| SSO (SAML / OIDC) | **PRESENT** | `@node-saml/node-saml`, `src/lib/auth/oidc.js` |

### 1.5 CLI (`cli/`)

| Capability | Status |
|---|---|
| Start/stop server | **WORKS** |
| System tray (macOS/Linux systray2, Windows PowerShell NotifyIcon) | **PRESENT** |
| Autostart registration | **PRESENT** |
| Cloudflared tunnel management | **PRESENT** |
| Interactive menus (providers, API keys, combos, settings, CLI tools) | **PRESENT** |
| `9router connect` | **PRESENT** (`31704db7`) |
| `9router xai video` | **PRESENT** |
| `--help` / `-h` | **PRESENT** |
| `--version` | **ABSENT** |
| `--json` / `--quiet` / `--verbose` / `--debug` / `--no-color` | **ABSENT** |
| Non-interactive / scriptable operation | **ABSENT** — menus are interactive-first |

### 1.6 Required by the directive — the full gap

| Directive requirement | Status in upstream |
|---|---|
| Agent runtime | **ABSENT** |
| Built-in agents (planner/coder/reviewer/debugger/tester/researcher/security/release) | **ABSENT** |
| Agent orchestration | **ABSENT** |
| Tool registry | **ABSENT** |
| Permission prompts / command approval | **ABSENT** |
| Filesystem boundary enforcement | **ABSENT** |
| Secret redaction in logs | **ABSENT** (a `log.maskKey` helper exists for API keys — the only redaction) |
| Plugin system with manifests + lifecycle | **ABSENT** (`skills/` is content, not a loader) |
| Session manager / conversational transcripts | **ABSENT** (only usage/quota rows persist) |
| `chat` / `run` / `agent` / `doctor` / `history` / `logs` / `status` / `models` / `providers` / `routes` / `plugins` / `config` commands | **ABSENT** |
| Config hierarchy (global/project/env/flags) with documented precedence | **ABSENT** (single SQLite settings table + `.env`) |
| `init` | **ABSENT** |
| Structured event log | **ABSENT** |
| Root `npm test` | **ABSENT** |
| Type checking | **ABSENT** (plain JS, `jsconfig.json` only) |
| `SECURITY.md`, `CONTRIBUTING.md` | **ABSENT** |

**Conclusion:** upstream delivers a strong **routing and provider gateway** plus a **web dashboard**
and a **server launcher**. It contains **no agent runtime, no tools, no sessions, no plugins, and no
permission model.** The agent platform is entirely new construction.

---

## 2. The "unlimited" claim — corrected finding

The directive's framing ("the unlimited thing") does not correspond to any implemented feature.
Verified by exhaustive search:

- `quota.unlimited` is a **display flag**, read in
  `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js:153` and
  `ProviderLimitCard.js:158`, rendering the literal string `"<N> used — Unlimited"`.
- **Every** provider sets it to `false`: `open-sse/services/usage/claude.js:99`,
  `open-sse/services/usage/codex.js:49`, `open-sse/services/usage/kiro.js:31` and `:45`.
- `QuotaProgressBar.js:102` merely hides the progress bar when the flag is set.

No code path grants, extends, or bypasses a quota. What actually exists is **quota-aware fallback**:
when a provider's quota is exhausted, routing moves down a combo chain to the next model/provider.
`quotaAutoPing.js` even sends tiny warm-up requests just after a reset window opens to avoid losing
a freshly reset window.

**Honest characterisation for derived documentation:** *free-tier cascade with automatic
fallback and quota-aware routing.* Not "unlimited". Provider quotas, rate limits, auth requirements
and billing rules continue to apply — a point the directive itself requires (§26).

### Related marketing/reality gaps found in the audit

| Claim | Reality |
|---|---|
| README: "Kiro AI (~50 credits/month free)" | `registry/kiro.js` sets `deprecated: true` and `deprecationNotice: "RISK_NOTICE"` on the Kiro provider. Upstream flags its own headline free provider as risky |
| README/blog thumbnails: "FREE Unlimited", "Claude Code FREE Forever" | No unlimited mechanism exists. Marketing framing only |
| `CLAUDE.md`: "Default runtime port is **20128**" | `package.json` hardcodes `--port 20127`. Setting `PORT` has no effect |
| `docs/ARCHITECTURE.md` describes persistence | Stale — describes retired `db.json`. Upstream `CLAUDE.md` flags it |
| `oc/union-alpha-free` | Upstream rejected it: `Model union-alpha-free is not supported` (observed this audit) |
| `oc/muse-spark-1.3-contributor-free` on `/v1/messages` | Emits valid SSE frames with **empty content** — a real translation gap for Anthropic-format clients |

---

## 3. Verified-working baseline (regression reference)

Recorded so future refactors can prove they did not break what already works.

```
GET  /api/version                     -> 200 {"currentVersion":"0.5.95",…}
GET  /dashboard                       -> 200
GET  /login                           -> 200
GET  /v1/models                       -> 200, 790 models
POST /api/auth/login {password}       -> 200 {"success":true,"mustChangePassword":false}
                                         + Set-Cookie auth_token
POST /api/keys {name}                 -> 201 {"key":"sk-…","id":"…","machineId":"…"}
POST /v1/chat/completions
     (no Authorization)               -> 401 {"error":{"code":"invalid_api_key",
                                          "message":"Missing API key"}}
POST /v1/chat/completions
     Bearer <key>, model=oc/muse-spark-1.3-contributor-free
                                     -> 200, content "PONG"
POST /v1/messages
     x-api-key <key>, stream=true     -> 200 text/event-stream,
                                         message_start / message_delta / message_stop,
                                         content empty
```

Runtime: Node on Windows, `node custom-server.js --port 20127`, Next.js 16.3.8, standalone output.

---

## 4. Feature disposition summary

### KEEP — verified valuable

OpenAI + Anthropic compatible API · `/v1/models` catalogue · cross-format translation ·
per-provider executors · retry · multi-account round-robin · **combo fallback** · token refresh ·
quota tracking + auto-ping · RTK fail-open compression · SQLite adapter chain · OAuth flows ·
API-key auth + enforcement · X-Forwarded-For defence · `custom-server.js` · provider registry
as data.

### REFACTOR

Translator switch → adapter interface · model catalogues → neutral registry · combo fallback →
policy engine with events · CLI argv handling → command router · config → layered hierarchy ·
port config → single source of truth · stale `ARCHITECTURE.md` → rewrite.

### REPLACE

`cli/` launcher-only scope · interactive-only menus · provider quirks leaking into shared
namespaces.

### REMOVE (from the derived product; not deleted from this clone)

System tray + tray binaries · autostart · cloudflared tunnel · `src/mitm/` interception proxy ·
`public/` · `gitbook/` · `i18n/` · duplicate `cli/LICENSE` (after capture in notices).

### NEW — nothing upstream exists

CLI command router · agent runtime · 8 built-in agents · orchestration · tool registry ·
permission/approval · plugin architecture · session manager · provider adapter interface ·
provider-neutral model registry · routing policy engine · structured events · `doctor` ·
secret redaction · root-wired tests · CI · full OSS documentation set.