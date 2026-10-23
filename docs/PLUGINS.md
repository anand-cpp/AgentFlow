# Plugin system

AgentFlow loads plugins. A plugin is a directory with a manifest and an entry
file; it can observe and veto agent runs, add tools, add model providers, add
slash commands, and contribute context. Everything runs under a sandbox and a
fail-isolated boundary: **a broken plugin costs itself, never the session.**

This document is the reference for what a plugin can do, where plugins are
found, and which guarantees actually hold. The implementation lives in
[`src/core/plugins/`](../src/core/plugins/); the CLI surface is
[`src/commands/plugin.js`](../src/commands/plugin.js).

## Design rules

- **Zero runtime dependencies.** `src/core/plugins/*` uses only `node:fs`,
  `node:path`, `node:events`, `node:vm` and `node:url`. The sandbox `require`
  handed to a plugin allows exactly one module: `node:events`, rebuilt as a
  hardened factory so a plugin cannot patch a shared prototype and leak into a
  neighbour.
- **Discovery never evaluates code.** It reads JSON manifests only. The
  dangerous step — running a plugin's entry — is isolated in the loader and
  happens once, later, and only for plugins that are enabled.
- **Namespacing over trust.** Nothing a plugin registers can shadow a builtin.
- **Declarative, not permissive.** A plugin may not reach outside its own
  directory, and no hook, tool, or provider can throw its way into the agent
  loop.

## Anatomy

```text
.agentflow/plugins/notetaker/
  agentflow.plugin.json     the manifest
  index.js                  the entry (or index.mjs for ESM)
```

A plugin may also ship as an npm package named `agentflow-plugin-<name>` (or
`@scope/agentflow-plugin-<name>`) carrying an `agentflowPlugin` key in its
`package.json` — same fields, same rules.

### Manifest

```json
{
  "id": "notetaker",
  "name": "Note Taker",
  "version": "1.0.0",
  "description": "Remembers decisions across a session.",
  "main": "index.js",
  "author": "you@example.com",
  "minAgentFlowVersion": "0.3.0",
  "permissions": { "hooks": true, "tools": true }
}
```

| Field | Rules |
| --- | --- |
| `id` | Required. `[a-z0-9][a-z0-9._-]{0,63}` (case-insensitive match, preserved for display). |
| `version`, `minAgentFlowVersion` | Semver `1.2.3`, optionally `-prerelease`. |
| `main` | Relative path inside the plugin. `../../elsewhere.js` is refused as a containment bypass. Default `index.js`. |
| `permissions` | Keys `tools`, `providers`, `hooks`, `commands`. Each `boolean` or an array of strings. Unknown keys are rejected. |

`minAgentFlowVersion` is compared against the running AgentFlow version; a
plugin that requires a newer one is discovered but marked `invalid` and never
loaded.

> **`permissions` are declarations, not gates.** They are validated for shape,
> shown by `aflow plugin inspect`, and readable from your code as
> `context.permissions` — so a reviewer can see what a plugin says it needs.
> The enforced boundary is the sandbox plus namespacing, not this field. Treat
> it as an honesty aid, and do not rely on `permissions: { tools: false }` to
> prevent a plugin from registering tools.

## Where plugins are found

Discovery scans three locations and merges the results. The first plugin to
claim an id wins:

1. `<workspace>/.agentflow/plugins/*` — project-local, highest trust
2. `<global-config>/plugins/*` — user-wide (override with `AGENTFLOW_CONFIG_DIR`)
3. `<workspace>/node_modules/` matching `agentflow-plugin-*` or
   `@*/agentflow-plugin-*` — npm-installed

Enable/disable state lives in `<workspace>/.agentflow/plugins.json` and is safe
to hand-edit. An id absent from the file defaults to enabled.

## The entry file

The entry exports an `activate` function. Any of these shapes work:

```js
module.exports = function activate(context) { /* ... */ };   // CommonJS
exports.activate = function (context) { /* ... */ };
export default function activate(context) { /* ... */ };     // ESM (index.mjs)
```

`activate` receives a frozen `context`:

| Member | Purpose |
| --- | --- |
| `context.id` | Your plugin id. |
| `context.permissions`, `context.manifest` | Frozen manifest data. |
| `context.log.info/warn/error(...)` | Per-plugin log ring (last 200 lines). `context.log.lines` is readable. |
| `context.on(hook, fn)` | Subscribe to a lifecycle hook. |
| `context.registerTool(def)` | Add a tool. |
| `context.registerProvider(def)` | Add a model provider. |
| `context.registerSlashCommand(def)` | Add a chat command. |
| `context.registerContextProvider(def)` | Add a context block. |

Every registrar returns `context`, so calls can be chained.

## Extension points

### Hooks

Hooks run **serially**, each subscriber under its own **3000 ms** timeout. A
subscriber that throws or hangs is recorded and skipped; the run continues.

| Hook | Payload | Return |
| --- | --- | --- |
| `onInit` | `{ workspaceRoot }` | — |
| `beforeAgentRun` | `{ agentId, task, sessionId, extra }` | `{ extra }` to append context, or `{ deny: true, reason }` to refuse the run |
| `afterAgentRun` | `{ agentId, completed, state, iterations, toolCalls, model, output, error }` | — (observe only) |
| `beforeToolExecute` | `{ tool, args, agentId }` | `{ deny: true, reason }` to refuse the call |
| `afterToolExecute` | `{ tool, args, agentId, output }` | `{ output }` to replace what the model sees |
| `onShutdown` | `{}` | — |

```js
context.on("beforeAgentRun", ({ task }) => {
  if (String(task).includes("production")) {
    return { deny: true, reason: "notetaker: refusing production work" };
  }
  return { extra: "Earlier decisions: prefer small commits." };
});
```

A `beforeAgentRun` veto fails the run before the model is ever called. A
`beforeToolExecute` refusal is a first-class denial: it records the same
events, stops the loop the same way a permission failure does, and reports the
distinct error code `plugin_denied` so a consumer can tell the two apart
without pattern-matching message text.

`afterToolExecute` substitutes **what the model sees next**, not what was
recorded — the right primitive for redaction.

### Tools

```js
context.registerTool({
  name: "remember",
  description: "Remember a short note and read it back.",
  scope: "read",
  schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  execute: async (args, callContext) => ({ remembered: args.note }),
});
```

Registered as `plugin__<pluginId>__<name>`. The tool then flows through the
ordinary runtime tool map, so it is subject to the same permission waterfall,
approval, and workspace-root requirements as a builtin. `scope` defaults to
`read`, the most conservative choice; declaring `write` does not grant it — the
agent's policy still has to allow the call.

Schema is validated (shapes, nesting depth); a malformed schema is refused at
registration, not at call time. **Up to 32 tools per plugin.**

### Model providers

```js
context.registerProvider({
  id: "local",
  name: "Local LLM",
  models: ["llama3", "mistral"],
  complete: async (modelId, { system, messages }) => ({ text: "..." }),
  streamComplete: async (modelId, { system, messages }, opts) => ({ text: "..." }),
});
```

Routed as `plugin__<pluginId>__<id>/<model>`. `complete` receives
`{ system, messages }` and returns `{ text, usage?, finishReason? }`. Only the
`plugin__` prefix is intercepted: every builtin model keeps its original route,
and plugin providers run under a timeout. **Up to 8 providers per plugin.**

`streamComplete` is optional. If omitted, the stream path emits `complete`'s
answer as a single chunk.

### Slash commands

```js
context.registerSlashCommand({
  name: "notes",
  description: "Show remembered notes.",
  handler: async (arg, session) => "no notes yet",
});
```

Called as `/notes <arg>`. The name is lowercased and must match
`[a-z0-9]{1,24}`. **A plugin may not shadow a builtin** — `/quit`, `/model`,
`/mcp`, `/plugin` and the rest are refused at registration. **Up to 16 commands
per plugin.** A handler that throws becomes rendered error text, never a crash.

### Context providers

```js
context.registerContextProvider({
  name: "notes",
  description: "Standing notes.",
  getContext: async ({ task }) => "Remembered decisions: ...",
});
```

Blocks are named `plugin__<pluginId>__<name>` and injected into the agent's
context packet before each LLM call. Admission is **budget-aware**: the plugin
budget is 1000 tokens (roughly `length / 4`), providers run in registration
order, and a block that exceeds the *remaining* budget is **skipped, never
truncated** — a silently chopped block reads as valid text to the model, which
is how wrong decisions get defended. Each provider runs under a 2000 ms
timeout.

## Failure isolation

Every boundary is wrapped:

- A plugin whose `activate` throws is recorded with a diagnostic and skipped.
  Every other plugin still loads.
- A hook, tool, provider, or command that throws or times out is captured and
  reported. None of them can reject into the agent loop.
- The plugin log ring is capped at 200 lines; a runaway `console.log` cannot
  grow without bound.
- An entry larger than 1 MiB is refused rather than evaluated.
- `console` inside the sandbox is redirected to your own log ring, so a plugin
  cannot pollute the host's output.

Check `aflow plugin inspect <id>` and `aflow doctor` for diagnostics.

## The CLI

```sh
aflow plugin list                     # what discovery found and what each adds
aflow plugin inspect <id>             # load it; show real registrations + log
aflow plugin enable <id>              # write .agentflow/plugins.json
aflow plugin disable <id>
aflow plugin create <id>              # scaffold under .agentflow/plugins/<id>
```

`list` and `inspect` **load** plugins rather than only reading manifests, so
the report describes what a session actually gets, and a plugin that fails to
activate shows its diagnostic instead of quietly vanishing. `create` evaluates
nothing.

`--project PATH` resolves the workspace elsewhere; `--json` gives
machine-readable output. Exit codes: `0` ok, `1` a plugin problem, `2` usage.

Inside a chat, the same dispatcher is `/plugin <subcommand>`. `/plugin` is a
reserved builtin name, so no plugin can intercept it.

### Doctor

`aflow doctor` reports a `plugins` row. Plugins are third-party code, so the
check has three honest answers and never an error:

- **unconfigured** — none discovered
- **ok** — all active, with a registration count
- **warn** — some would not activate, named with their first diagnostic

Doctor still exits `0` either way: a broken plugin costs the session that
plugin's additions, not the session.

## A complete plugin

```js
// .agentflow/plugins/todos/index.js
module.exports = function activate(context) {
  const notes = [];

  context.on("beforeAgentRun", ({ task }) => ({
    extra: notes.length ? `Open todos:\n${notes.join("\n")}` : "",
  }));

  context.on("afterAgentRun", ({ completed }) => {
    if (completed) context.log.info("run finished");
  });

  context.registerTool({
    name: "todo",
    description: "Add a todo the next run will see.",
    scope: "write",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async ({ text }) => {
      notes.push(`- ${text}`);
      return { added: text, open: notes.length };
    },
  });

  context.registerSlashCommand({
    name: "todo",
    description: "List open todos.",
    handler: async () => (notes.length ? notes.join("\n") : "no todos"),
  });
};
```

Scaffold something similar with `aflow plugin create todos`.

## Limits at a glance

| Limit | Value |
| --- | --- |
| Activation timeout | 3000 ms |
| Hook subscriber timeout | 3000 ms |
| Plugin provider timeout | 2000 ms |
| Context provider timeout | 2000 ms |
| Plugin context budget | 1000 tokens |
| Tools / providers / commands per plugin | 32 / 8 / 16 |
| Log ring | 200 lines |
| Entry size | 1 MiB |
| `require` allowlist | `node:events` only |

## Testing a plugin

Stage it in a scratch workspace and drive it the way the integration tests do:

```js
const { PluginManager } = await import("./src/core/plugins/manager.js");
const mgr = new PluginManager({ workspaceRoot: scratchDir, currentVersion: VERSION });
await mgr.init();
```

`mgr.loaded`, `mgr.stats()`, and `mgr.discovered` show exactly what happened;
`mgr.problems` carries the diagnostics. See
[`test/plugins/cli-integration.test.js`](../test/plugins/cli-integration.test.js)
and the fixtures under [`test/plugins/fixtures/`](../test/plugins/fixtures/) for
a working sample, a deliberately broken plugin, and an ESM plugin.
