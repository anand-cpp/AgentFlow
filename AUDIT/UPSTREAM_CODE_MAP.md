# Upstream Code Map

**Audit date:** 2026-10-03
**Audited revision:** `a99cf572` (tag `v0.5.95`)
**Upstream:** https://github.com/decolua/9router — MIT, `Copyright (c) 2024-2026 decolua and contributors`

Purpose: an itemised, path-level record of what is inherited, so that provenance can be stated
honestly in `PROJECT_ORIGIN.md` and so no subsystem's origin is ever ambiguous.

---

## 1. Provenance legend

| Marker | Meaning |
|---|---|
| **INHERITED** | Upstream code, unmodified. Retains upstream copyright. |
| **MODIFIED** | Upstream code, changed by us. Changes itemised in §4. |
| **REPLACE** | Upstream subsystem discarded; new implementation supersedes it. |
| **REMOVE** | Upstream subsystem dropped from the derived product with no replacement. |
| **NEW** | No upstream equivalent. Written from scratch. |

---

## 2. Directory-level map

| Path | Files | Marker | Disposition |
|---|---|---|---|
| `open-sse/` | 402 | INHERITED | **Core foundation.** Retain. Largest genuine asset. |
| `src/app/` | — | INHERITED → REPLACE | Next.js dashboard + REST APIs. Governed by the dashboard decision. |
| `src/sse/` | — | INHERITED | App-side entry glue into `open-sse`. Retain if server retained. |
| `src/shared/` | — | INHERITED | UI components. Dashboard-only. |
| `src/lib/db/` | — | INHERITED | SQLite layer + adapter chain. **Retain.** |
| `src/lib/oauth/` | — | INHERITED | OAuth flows incl. Kiro/Xiaomi. Retain. |
| `src/mitm/` | — | INHERITED → REMOVE | Interception proxy. Recommend removal. |
| `src/models/`, `src/store/`, `src/i18n/` | — | INHERITED → REMOVE | Dashboard-only. |
| `cli/` | 35 | INHERITED → REPLACE/REMOVE | Launcher + tray. Tray/mitm removed; real CLI is NEW. |
| `tests/` | 351 | INHERITED | Keep as regression baseline; extend heavily. |
| `public/` | 201 | INHERITED → REMOVE | Dashboard static assets. |
| `gitbook/` | 120 | INHERITED → REMOVE | Legacy docs. |
| `i18n/` | 10 | INHERITED → REMOVE | Localized READMEs. |
| `skills/` | 10 | INHERITED | Skill *content*, not a loader. Not an executable plugin system. |
| `docs/` | 7 | INHERITED | `ARCHITECTURE.md` is stale (describes retired `db.json`). Rewrite. |
| `scripts/` | 5 | INHERITED | Registry codegen, asset copy. Retain as needed. |
| `custom-server.js` | 1 | INHERITED | Standalone server wrapper + X-Forwarded-For stripping. **Retain the security behaviour.** |
| `AUDIT/` | 7 | **NEW** | This audit. |

---

## 3. Substantive subsystems

### 3.1 Routing engine — `open-sse/` — INHERITED (the foundation)

| Path | Role | Marker |
|---|---|---|
| `open-sse/handlers/chatCore.js` | Format detection, translation dispatch, retry, token refresh, stream setup | INHERITED |
| `open-sse/executors/` | Per-provider upstream calls (`default.js` = any OpenAI-compatible) | INHERITED |
| `open-sse/translator/` | `source:target` format conversion, pivoting via OpenAI | INHERITED |
| `open-sse/providers/registry/` | ~125 provider declarations (transport + models co-located) | INHERITED |
| `open-sse/providers/index.js` | Builds `PROVIDERS`/`PROVIDER_MODELS`/`PROVIDER_OAUTH`/`PROVIDER_MEDIA` | INHERITED |
| `open-sse/providers/capabilities.js` | Model capability lookup | INHERITED |
| `open-sse/config/` | Provider constants, model helpers, runtime config | INHERITED |
| `open-sse/rtk/` | `tool_result` token compression, fail-open | INHERITED |
| `open-sse/utils/` | `proxyFetch.js`, SSE constants | INHERITED |
| `open-sse/services/usage/` | Per-provider quota/usage fetchers | INHERITED |
| `open-sse/services/tokenRefresh.js` | OAuth refresh | INHERITED |
| `open-sse/AGENTS.md` | Upstream's own engine conventions | INHERITED |

**Compatibility note:** `open-sse/AGENTS.md` documents upstream conventions and states the registry
`index.js` is auto-generated. Any modification there must respect that.

### 3.2 Persistence — `src/lib/db/` — INHERITED

Adapter chain `bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js` (`driver.js`).
Repos per entity under `repos/`, migrations under `migrations/`, path resolution in `paths.js`.
`src/lib/localDb.js` is a backward-compat shim slated for removal.

### 3.3 Providers with bespoke executors — INHERITED

`kiro.js` (AWS EventStream + CRC32 + 8 MiB repair buffer), `codex.js`, `cursor.js` (protobuf),
`commandcode.js` (NDJSON), and others. These are the hardest-won upstream code and the strongest
argument for retention.

### 3.4 CLI — `cli/` — INHERITED, largely REPLACED

Retained concepts: process lifecycle, autostart, tray abstraction, config location convention
(`~/.9router/`).

Removed: tray binaries, cloudflared tunnel management, PowerShell/WMI process enumeration,
interactive-only `enquirer` menus.

Replaced: ad-hoc `process.argv` scanning → real command router (NEW).

---

## 4. Modification log

No modifications to upstream source have been made. This audit phase is read-only apart from adding
`AUDIT/` and the local untracked `.env` (gitignored).

Recorded local-only changes:

| Path | Change | Tracked? |
|---|---|---|
| `.env` | Copied from `.env.example`; real `JWT_SECRET`, `API_KEY_SECRET`, a locally-set `INITIAL_PASSWORD` (value deliberately not recorded here), `DATA_DIR` set to a Windows path, `PORT=20127` | **No** — `.gitignore:37` |
| `AUDIT/*.md` | 5 new audit documents | Yes (to be added) |
| `start.log`, `start.err.log` | Runtime logs from local verification | No — must be cleaned or ignored |
| `node_modules/`, `.next/` | Installed + built | No — gitignored |
| `~/.config/opencode/opencode.jsonc` | Added a `9router` provider block pointing at the local instance | Outside repo. **Contains a live local API key — never commit.** |

To be updated as implementation proceeds.

---

## 5. Files with NO upstream equivalent (all NEW work)

Everything in the directive's Phase 3+ scope:

- CLI command router and command surface
- Agent runtime and built-in agents
- Agent orchestration
- Tool registry and permission/approval system
- Plugin architecture (manifests, lifecycle, compatibility)
- Session manager and history
- Provider adapter interface
- Provider-neutral model registry
- Routing policy engine with observable structured events
- `doctor` diagnostics
- Structured/JSON observability output
- Secret redaction
- Root-wired test suite, CI
- `PROJECT_ORIGIN.md`, `THIRD_PARTY_NOTICES.md`, `UPSTREAM_INSPIRATION.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `RELEASE_AUDIT.md`

---

## 6. Attribution requirements triggered by this map

Because `open-sse/`, `src/lib/db/`, `custom-server.js`, and the provider executors are **retained
MIT-licensed upstream code**, the derived repository must:

1. Retain `Copyright (c) 2024-2026 decolua and contributors` in the root `LICENSE`.
2. Reproduce the MIT permission text and warranty disclaimer in full.
3. Provide `THIRD_PARTY_NOTICES.md` naming decolua and the retained component paths.
4. Mark material changes in `CHANGELOG.md` v0.1.0 and `PROJECT_ORIGIN.md`.
5. Not present the retained subsystems as original work.

Any file substantially derived from an upstream path should carry a short header pointing at the
origin path and upstream commit. Suggested form:

```js
// Derived from 9Router open-sse/handlers/chatCore.js @ a99cf572 (MIT).
// Copyright (c) 2024-2026 decolua and contributors. See THIRD_PARTY_NOTICES.md.
// Modifications: <describe>.
```

Applied file-by-file, this makes provenance auditable rather than merely asserted.