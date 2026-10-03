# Dependency Audit

**Audit date:** 2026-10-03
**Audited revision:** `a99cf572` (tag `v0.5.95`)
**Method:** read from `package.json`, `cli/package.json`, `tests/package.json`; installed tree
measured on Windows after `npm install` (590 packages added, 470 top-level dirs, ~605 packages
including transitive).

---

## 1. Declared dependency surface

| Manifest | Runtime deps | Dev deps | Optional |
|---|---|---|---|
| root (`9router-app`) | 33 | 5 | 1 (`better-sqlite3`) |
| `cli/` (`9router`) | 6 | 2 | 0 |
| `tests/` | — | vitest + others | — |

Lockfile: **only** `package-lock.json` at root. No `cli/package-lock.json`, no
`tests/package-lock.json`.

### Root runtime dependencies (33)

```
@dnd-kit/core              @dnd-kit/modifiers        @dnd-kit/sortable
@dnd-kit/utilities         @monaco-editor/react      @next/third-parties
@node-saml/node-saml       @xyflow/react             bcryptjs
chalk                      confbox                   express
http-proxy-middleware      jose                      marked
material-symbols           monaco-editor             next
node-forge                 node-machine-id           open
ora                        prop-types                react
react-dom                  react-is                  recharts
selfsigned                 socks-proxy-agent         sql.js
undici                     uuid                      zustand
```

### Root dev dependencies (5)

```
@tailwindcss/postcss  eslint  eslint-config-next  postcss  tailwindcss
```

### `cli/` runtime dependencies (6)

```
enquirer  node-forge  node-machine-id  react  react-dom  confbox
```

`react` + `react-dom` are declared as **runtime** dependencies of a terminal CLI, used only by
`systray2`-adjacent tray rendering. Significant install weight for a command-line tool.

---

## 2. Classification against the target architecture

A terminal-first CLI + agent runtime needs a small fraction of this.

### Retain (routing engine + persistence)

| Package | Why |
|---|---|
| `undici` | HTTP client used across executors; battle-tested, already load-bearing |
| `uuid` | Request/session id generation |
| `jose` | JWT session cookies; already used, well-audited |
| `bcryptjs` | Dashboard password hashing |
| `node-forge` | OAuth PKCE flows |
| `socks-proxy-agent` | Proxy support for provider calls |
| `sql.js` | Guaranteed-present pure-JS SQLite fallback |
| `better-sqlite3` (optional) | Fast path when native build succeeds |
| `confbox` | Config file read/write |
| `chalk`, `ora` | Terminal output — directly useful for the new CLI |
| `express` | If a local server surface is retained |

### Re-evaluate (useful in a terminal product, but verify the choice)

| Package | Note |
|---|---|
| `marked` | Markdown rendering — needed only if the CLI renders markdown output |
| `open` | Opens a URL in the default browser. **Security-relevant in an agent context**: an agent-reachable "open this URL" tool is a real attack surface. Gate behind explicit approval or drop |
| `selfsigned` | TLS cert generation for tunnel/proxy features |

### Drop — dashboard-only (Next.js / React / charting / editor / DnD)

```
next  react  react-dom  react-is  zustand  recharts  @xyflow/react
@monaco-editor/react  monaco-editor  material-symbols
@dnd-kit/core  @dnd-kit/modifiers  @dnd-kit/sortable  @dnd-kit/utilities
@next/third-parties  prop-types
@tailwindcss/postcss  tailwindcss  postcss  eslint-config-next
```

This is **19 of 33** runtime deps plus **4 of 5** dev deps. Removing the dashboard removes the
single largest dependency cluster in the project — and with it the entire Next.js build, the
`custom-server.js` X-Forwarded-For surface, and the `ARCHITECTURE.md` staleness problem.

**Caveat:** this is only correct if the web dashboard is genuinely dropped. If it is retained, these
stay. This is the same unresolved decision flagged in `ARCHITECTURE_AUDIT.md` §13.

### Special attention

| Package | Finding |
|---|---|
| `http-proxy-middleware` | Present specifically to support `src/mitm/` — the interception-proxy feature. `FEATURE_AUDIT.md` recommends removing MITM; if removed, this dep goes too |
| `@node-saml/node-saml` | Enterprise SSO. Only needed for dashboard SAML login |
| `node-machine-id` | Hardware fingerprinting, used for API-key machine binding. Raises a privacy consideration worth documenting in `SECURITY.md` |

---

## 3. Licensing posture

Upstream ships **no `THIRD_PARTY_NOTICES` file at all**. For a real standalone OSS project this is a
gap. Action: generate transitive notices for the retained dependency set.

No copyleft dependency was identified among the runtime deps above (all permissively licensed:
MIT/ISC/Apache-2.0 family). `better-sqlite3` is MIT. No blocking license risk identified.

---

## 4. Install and portability findings (measured)

| Finding | Evidence |
|---|---|
| `npm install` succeeds on Windows | 590 packages added in 1m |
| `better-sqlite3` build **not executed** | npm reported `allow-scripts 2 packages have install scripts not yet covered by allowScripts: better-sqlite3, unrs-resolver`. Falls back to `sql.js` at runtime — this is the designed behaviour |
| `npm run build` succeeds on Windows | Next 16.3.8 standalone build + asset copy completed |
| `npm run start` serves correctly | HTTP 200 on `/api/version`, PID confirmed |
| `DATA_DIR` not cross-platform | Runtime log: `[DATA_DIR] '/var/lib/9router' is a Unix path on Windows → fallback to default` |
| Port config broken | `package.json` hardcodes `--port 20127`; `.env.example` documents `PORT=20128`; setting `PORT` has no effect |
| Tests not runnable as-is | `tests/node_modules` absent; `tests/package.json` `test` script hardcodes Unix `NODE_PATH=/tmp/node_modules` |

**Note on `better-sqlite3` install scripts:** modern npm (this version) blocks lifecycle scripts by
default pending approval. Any project depending on `better-sqlite3` will silently degrade to
`sql.js` on a fresh clone unless the user runs `npm approve-scripts`. This must be documented in
install instructions, not left as a surprise.

---

## 5. Recommendations

1. **Decide the dashboard question first.** It determines whether 19 runtime deps live or die.
2. **Generate `THIRD_PARTY_NOTICES.md`** for whatever survives.
3. **Adopt one lockfile strategy.** Currently root-only; `cli/` and `tests/` unpinned.
4. **Wire `npm test` at root.** It does not exist. A real product needs `npm test` to work.
5. **Add a `typecheck` script.** None exists — the codebase is plain JS with `jsconfig.json`.
   Either introduce checking or state its absence honestly rather than implying it.
6. **Document the `better-sqlite3` approval step** in install docs.
7. **Drop `open` from any agent-reachable tool path**, or gate it behind explicit approval.
8. **Fix the port contradiction** — one source of truth.