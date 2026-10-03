# Reference Study — OpenCode

**Study date:** 2026-10-03
**Repository:** https://github.com/anomalyco/opencode
**License (verified at file level):** MIT — `LICENSE`, `Copyright (c) 2025 opencode`
**API metadata:** `fork=false`, `parent=null`, public, default branch `dev`, TypeScript, 211,608 stars
**Clone used:** `git clone --depth 1 --branch dev` → temp, read-only. 6,646 files.
**Code incorporated into AgentFlow: NONE.** Architectural study only.

---

## 1. Why this repo matters as a reference

OpenCode is the closest existing prior art to the target: a **terminal-first coding agent** with a
provider-agnostic model layer, a tool registry, a permission system, plugins, and skills. Every
capability the directive requires in AgentFlow already exists here, at production scale, MIT-licensed.

That makes it the single highest-value study target — and the single largest temptation to
shortcut by copying. Both facts should be stated plainly.

---

## 2. Monorepo layout

`turbo` + `bun` workspaces, 29 packages under `packages/`.

| Package | Role |
|---|---|
| `opencode` | The main application: session, agent, tool, permission, plugin, config, provider, MCP, LSP, skill |
| `core` | Shared primitives: database, event, permission v1, filesystem, oauth, credential, config, pty, ripgrep, policy |
| `server` | HTTP surface: `routes.ts`, `handlers/`, `middleware/`, `auth.ts`, `cors.ts` |
| `llm` | Model abstraction: `protocols/`, `providers/`, `route/`, `schema/` |
| `plugin` | Plugin API surface (`v2/`) |
| `sdk`, `sdk-next` | Client SDKs |
| `tui`, `cli`, `console` | Terminal / command / console front-ends |
| `desktop`, `app`, `web` | Non-terminal surfaces |
| `session-ui`, `ui`, `pierre` | UI primitives |
| `http-recorder`, `codemode`, `codegen`, `effect-drizzle-sqlite`, `effect-sqlite-node` | Infrastructure |

Two notable structural signals:

1. **Effect is load-bearing.** `Layer`, `Context.Service`, `Deferred`, `Effect.gen`, `addFinalizer`.
   Services are declared as classes (`export class Service extends Context.Service<...>()`) and
   dependencies are wired as layers. This is not incidental — error handling, resource cleanup,
   and testability all fall out of it.
2. **`core/` is being extracted from `opencode/`** while `opencode/` still holds the originals.
   Both `permission` and `config` exist in `packages/opencode/src/` *and*
   `packages/core/src/v1/`. This is a live migration with a `v2-schema.ts` / `v2-compat.ts`
   bridge. Useful signal: *expect your own core/engine boundary to churn.*

---

## 3. The four subsystems AgentFlow needs most

### 3.1 Permission model — `permission/`

Three files: `index.ts`, `evaluate.ts`, `arity.ts`. The design is small and worth copying
*conceptually*:

```ts
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return rulesets.flat()
    .findLast(rule => Wildcard.match(permission, rule.permission)
                 && Wildcard.match(pattern, rule.pattern))
    ?? { action: "ask", permission, pattern: "*" }
}
```

Properties that matter:

- **Rules are `(permission, pattern)` pairs.** Two-dimensional: *what* is being done, and *to what*.
- **Wildcard matching** on both axes via a shared `Wildcard` util.
- **`findLast`, not `find`** — last matching rule wins. Later, more specific config overrides
  earlier general config.
- **Fail-safe default is `ask`**, never `allow`. An unmatched request prompts.
- **Blocking is via `Deferred`** — `ask()` suspends the calling Effect until `reply()` resolves it
  with approve/reject/correct. Pending requests live in a `Map<Permission.ID, PendingEntry>`.
- **Cleanup on finalizer** — `Effect.addFinalizer` fails every pending Deferred with
  `RejectedError` and clears the map. Session teardown cannot leave a dangling promise. This is a
  real bug class that a naive `Promise`-based implementation leaks.
- **TUI awareness** — `config/tui-host-attention.ts`, `tui-cwd.ts`, `tui-migrate.ts` exist so the
  terminal knows to surface a pending approval.

Also present: `permission.ts` in `core/`, `v1/permission` + `ConfigPermissionV1`, `policy.ts`, and
`agent/subagent-permissions.ts` — i.e. **subagents have their own permission layer**, distinct from
the parent's. Directly relevant to AgentFlow's orchestration requirement.

### 3.2 Tool registry — `tool/`

33 files. Built-ins: `apply_patch`, `edit`, `write`, `read`, `grep`, `glob`, `shell`, `lsp`,
`webfetch`, `websearch`, `mcp-websearch`, `task`, `todowrite`, `plan` (with `plan-enter`/`plan-exit`),
`question`, `skill`, `code-mode`, `invalid`, plus `registry.ts`, `tool.ts`, `schema.ts`,
`json-schema.ts`, `truncate.ts`, `truncation-dir.ts`.

Observations:

- **A `.txt` companion per tool.** `read.txt`, `edit.txt`, `grep.txt`, `glob.txt`, `shell.txt`,
  `write.txt`, `task.txt`, `todo.txt`, `webfetch.txt`, `websearch.txt`, `lsp.txt`, `plan-enter.txt`,
  `plan-exit.txt`, `question.txt`, `skill.txt`, `agent/generate.txt`, `agent/compaction.txt`,
  `agent/summary.txt`, `agent/title.txt`, `agent/explore.txt`.
  Prompts live in separate text files, not inline in the tool implementation. Clean separation, and
  it makes prompt iteration possible without touching logic.
- **`tool.ts` defines `Tool.Def` with schema inference.** `Tool.InferDef<typeof ReadTool>` extracts
  the parameter type from the tool's own schema, so `TaskDef`/`ReadDef` are derived, not declared.
  Parameters are `JSONSchema7` from `@ai-sdk/provider`, validated with Zod via `effect`'s `Schema`.
  **The schema is the single source of truth** — no drift between what the model is told and what
  is validated.
- **`registry.ts` composes builtin + custom (plugin) tools**, and filters by
  `{ providerID, modelID, agent, permission }`. Tool availability is **per-agent and per-model**,
  not global. `webSearchEnabled(providerID, flags)` shows provider-conditional gating.
- **Output truncation is first-class**: `truncate.ts` + `truncation-dir.ts`. Large tool output is
  truncated and spilled to disk with a pointer back. This is the same problem 9Router's `open-sse/rtk/`
  solves for `tool_result` compression — **two independent implementations of one idea**, useful
  cross-validation.
- **`invalid.ts`** — a tool that always errors. Used to mask a removed tool from the model while
  still returning a well-formed tool result. Nice detail.

### 3.3 Agents — `agent/`

`agent.ts` plus `subagent-permissions.ts` and prompt `.txt` files. Notably
`agent/explore.txt` exists as a first-class *explore* subagent — parallel to the directive's
`researcher` role. `generate.txt` is the base/main-loop prompt; `compaction.txt`, `summary.txt`,
`title.txt` handle context management. `config/agent.ts` means agents are **user-definable in
config**, not hardcoded — directly relevant to the directive's 8 built-in agents, which should be
config entries, not switch statements.

### 3.4 Plugins — `plugin/`

`packages/plugin/src` exposes `v2/` plus `example.ts`, `example-workspace.ts`, `shell.ts`,
`tool.ts`, `tui.ts`. Plugins can contribute **tools**, and the boundary is a typed
`ToolContext`/`ToolDefinition` contract. `core/plugin.ts` and `config/plugin.ts` handle loading.
`skill/` is separate from `plugin/` — skills are prompt/content bundles, plugins are code.

---

## 4. Config layering — `config/`

18 files. `paths.ts` reveals the precedence model:

- Project config: walk **up** from the worktree directory looking for `<name>.jsonc` /
  `<name>.json`, `.toReversed()` so nearer files come later.
- Directories, in order: `Global.Path.config` → project `.opencode` (suppressible via
  `Flag.OPENCODE_DISABLE_PROJECT_CONFIG`) → home `.opencode` → `Flag.OPENCODE_CONFIG_DIR`.
- `v2-compat.ts`, `managed.ts`, `variable.ts`, `markdown.ts`, `entry-name.ts` handle migration,
  enterprise-managed config, `${VAR}` interpolation, markdown-file config, and config entry naming.
- **JSONC support** — comments allowed. Good call for a human-edited config.

**Takeaway for AgentFlow:** walk-up discovery + later-wins + explicit disable flag + env override +
variable interpolation. The directive's required precedence (global → project → env → flags) is a
subset; adopt the walk-up and the disable flag too.

---

## 5. Adjacent subsystems worth knowing about

| Subsystem | Location | Relevance |
|---|---|---|
| Event system | `packages/opencode/src/bus/`, `core/event/`, `event-v2-bridge.ts`, `event-manifest.ts`, `public-event-manifest.ts` | Typed event bus + a **declared public event manifest**. Exactly the structured-observability substrate the directive asks for |
| Background jobs | `background/job.ts` | Long-running work off the request path |
| Sessions | `session/` — 40 files | Largest subsystem in the app |
| Snapshots | `snapshot/` | Filesystem state capture/restore |
| Worktrees | `worktree/` | Git worktree isolation |
| MCP | `mcp/`, `core/mcp` + `McpCatalog` | Model Context Protocol client |
| LSP | `lsp/`, `core/lsp` | Language-server integration as a tool |
| Storage | `storage/`, `core/database/` | Persistence |
| Observability | `core/observability.ts` | First-class |
| Policy | `core/policy.ts` | Policy primitives |
| Credential | `core/credential.ts` | Credential handling |
| Snapshots/sessions share | `share/` | Session sharing |
| `http-recorder` | own package | Records/replays HTTP for debugging |

Also notable: `AGENTS.md`, `CONTEXT.md`, `SECURITY.md`, `CONTRIBUTING.md`, `STATS.md`, `.gitleaksignore`,
`.oxlintrc.json`, `perf/`, `benchmarks`-style `script/`, `.husky/`, `sst.config.ts`, `flake.nix`.
`SECURITY.md` and `CONTRIBUTING.md` are files AgentFlow will need and upstream 9Router lacks.

---

## 6. What to take — and what must not be taken

### Adopt as design inspiration (write your own implementation)

| Idea | Why |
|---|---|
| `(permission, pattern)` two-axis wildcard ruleset, last-match-wins, default `ask` | Small, auditable, fail-safe |
| `Deferred`-based approval with finalizer cleanup | Prevents dangling-promise leaks on teardown |
| Separate subagent permission layer | Subagents must not inherit parent authority blindly |
| Tool schema as single source of truth, type inferred from schema | Eliminates prompt/validation drift |
| Per-agent, per-model tool availability | Enables least-privilege by construction |
| Prompts in `.txt` companions to tool logic | Iterate prompts without touching code |
| Truncation + spill-to-disk for oversized tool output | Necessary for real terminal sessions |
| Typed event bus + public event manifest | The observability backbone |
| Config walk-up layering, later-wins, disable flag, var interpolation | Proven precedence model |
| Agents as config entries, not switch statements | Extensibility without code changes |
| `invalid.ts` masking pattern | Graceful tool removal |
| Ship `SECURITY.md` / `CONTRIBUTING.md` from day one | Agent projects need them immediately |

### Do NOT take

- **No source copying.** MIT permits it, but copying an Effect-based TypeScript architecture into a
  plain-JS project would be incoherent and would import an enormous dependency surface (`effect`,
  `@ai-sdk/*`, `remeda`, `zod`, drizzle) into a project whose stated goal is a lean terminal binary.
- **Do not adopt Effect.** 9Router is plain JS. Introducing Effect is a rewrite of the entire
  codebase, not a feature.
- **Do not assume the AI SDK.** 9Router's `open-sse/` already implements provider translation
  against raw HTTP. Re-implementing that with `@ai-sdk/provider` would duplicate existing working code.
- **Ignore the `core/` extraction churn.** It is a snapshot of a live migration, not a template.
- **Ignore star count / velocity as design guidance.** 211k stars is popularity, not architecture.

---

## 7. Net assessment

OpenCode answers, at production scale, every question the directive raises about agents, tools,
permissions, plugins, and config layering. Its architectural vocabulary — ruleset, registry,
manifest, layer — is the right vocabulary for AgentFlow.

Its implementation choices (TypeScript, Effect, Bun, Turborepo, AI SDK) do not transfer to a
plain-JavaScript project inheriting 9Router's `open-sse/` engine. **Take the model, write the code.**

This study closes open item 1 in `LICENSE_AUDIT.md` §6: OpenCode's license is verified MIT at file
level, with no CLA, no additional restriction, and no trademark rider found in `LICENSE`. Code-level
engagement would therefore be legally permitted — and is still declined on engineering grounds.