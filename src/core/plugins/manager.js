// Plugin manager.
//
// The one object the runtime and the chat engine deal with. Composes the
// registries (hooks, tools, providers, commands, context enrichers), runs
// discovery + sandbox loads, and exposes the runtime-facing wrappers:
//
//   - runBeforeAgentRun / runAfterAgentRun
//   - runBeforeToolExecute / runAfterToolExecute
//   - runOnInit / runOnShutdown
//   - registerToolsInto(runtime)   -- plugin tools join the map builtins use
//   - providerDispatch()           -- complete/stream wrapper for providers
//   - command(name)                -- slash dispatch consulted by the engine
//
// Every wrapper is failure-isolated by the registries underneath: the manager
// can never propagate a plugin failure into the agent loop.

import { loadPlugin } from "./loader.js";
import { discoverPlugins } from "./discovery.js";
import { PluginHookRegistry } from "./hooks.js";
import { PluginToolRegistry } from "./tools-extension.js";
import { PluginProviderRegistry, installPluginProviderDispatch } from "./providers-extension.js";
import { PluginCommandRegistry, runPluginCommand } from "./commands-extension.js";
import { PluginContextRegistry, renderPluginContext, estimateTokens } from "./context-extension.js";
import { TOOL_SCOPE } from "../agents/registry.js";
import { VERSION } from "../version.js";

export const PLUGIN_PROMPT_TOKEN_BUDGET = 1000;
const KNOWN_SCOPES = new Set(Object.values(TOOL_SCOPE));

/** Join base context text with appended texts, skipping empties. */
export function mergeExtraText(base, ...parts) {
  const joined = parts.filter((p) => typeof p === "string" && p.trim() !== "");
  if (typeof base !== "string") {
    return joined.length === 0 ? null : joined.join("\n\n");
  }
  return joined.length === 0 ? base : [base, ...joined].join("\n\n");
}

export class PluginManager {
  constructor({
    workspaceRoot = process.cwd(),
    currentVersion = VERSION,
    builtinCommands = [],
    promptTokenBudget = PLUGIN_PROMPT_TOKEN_BUDGET,
  } = {}) {
    this.workspaceRoot = workspaceRoot;
    this.currentVersion = currentVersion;
    this.promptTokenBudget = promptTokenBudget;
    this.#builtinCommands = builtinCommands;

    this.hooks = new PluginHookRegistry();
    this.tools = new PluginToolRegistry();
    this.providers = new PluginProviderRegistry();
    this.commands = new PluginCommandRegistry();
    this.contexts = new PluginContextRegistry();

    /** @type {Map<string, object>} plugin id -> loaded plugin */
    this.loaded = new Map();
    /** @type {Map<string, string[]>} attribution -> registration/load problems */
    this.problems = new Map();
    this.discovered = [];
    this.initialised = false;

    // The registrar strip the sandboxed PluginContext hands out. Every arrival
    // is validated by a registry; refusals become per-plugin problems rather
    // than errors the loader has to see.
    const refuse = (pluginId, line) => {
      const list = this.problems.get(pluginId) ?? [];
      list.push(line);
      this.problems.set(pluginId, list);
    };
    this.#loaderDeps = {
      onHook: (pluginId, hookName, fn) => {
        const res = this.hooks.add(pluginId, hookName, fn);
        if (!res.ok) refuse(pluginId, `hook "${hookName}" refused: ${res.error}`);
      },
      onRegisterTool: (pluginId, def) => {
        const res = this.tools.register(pluginId, def);
        if (!res.ok) refuse(pluginId, `tool "${def?.name ?? "?"}" refused: ${res.error}`);
      },
      onRegisterProvider: (pluginId, def) => {
        const res = this.providers.register(pluginId, def);
        if (!res.ok) refuse(pluginId, `provider "${def?.id ?? "?"}" refused: ${res.error}`);
      },
      onRegisterSlashCommand: (pluginId, def) => {
        const res = this.commands.register(pluginId, def, { builtinNames: this.#builtinCommands });
        if (!res.ok) refuse(pluginId, `command "/${def?.name ?? "?"}" refused: ${res.error}`);
      },
      onRegisterContextProvider: (pluginId, def) => {
        const res = this.contexts.register(pluginId, def);
        if (!res.ok) refuse(pluginId, `context provider "${def?.name ?? "?"}" refused: ${res.error}`);
      },
    };
  }

  // Reserved builtin names are provided after construction, so capture order matters.
  #builtinCommands;
  #loaderDeps;

  /**
   * Discover and load every enabled plugin, then fire onInit. Never throws;
   * problems are recorded as diagnostics the doctor can quote.
   */
  async init() {
    const { plugins, diagnostics } = discoverPlugins({
      workspaceRoot: this.workspaceRoot,
      currentVersion: this.currentVersion,
    });
    this.discovered = plugins;
    if (diagnostics.length > 0) {
      const list = this.problems.get("discovery") ?? [];
      list.push(...diagnostics);
      this.problems.set("discovery", list);
    }
    for (const spec of plugins) {
      if (spec.status !== "enabled") {
        if (spec.status === "invalid" && spec.errors.length > 0) {
          const list = this.problems.get(spec.id) ?? [];
          list.push(...spec.errors.map((e) => `invalid manifest: ${e}`));
          this.problems.set(spec.id, list);
        }
        continue;
      }
      const result = await loadPlugin(spec, this.#loaderDeps);
      if (result.ok) {
        this.loaded.set(spec.id, result.plugin);
      } else {
        const list = this.problems.get(spec.id) ?? [];
        list.push(...result.diagnostics);
        this.problems.set(spec.id, list);
      }
    }
    if (this.hooks.count("onInit") > 0) {
      await this.hooks.invoke("onInit", {});
    }
    this.initialised = true;
    return this;
  }

  /** Register every plugin tool into a runtime's tool map. */
  registerToolsInto(runtime) {
    if (!runtime?.tools?.set) return 0;
    let count = 0;
    for (const entry of this.tools.entries()) {
      runtime.tools.set(entry.def.name, this.#runtimeToolDef(entry));
      count += 1;
    }
    return count;
  }

  /**
   * The runtime tool definition for a plugin tool. The scope belongs to the
   * permission waterfall: any declared scope is honored, and the default is
   * READ, the most conservative tool scope. A plugin can never grant itself an
   * escape from the same policy every builtin tool is gated by.
   */
  #runtimeToolDef(entry) {
    const declared = entry.def.scope;
    const scope = KNOWN_SCOPES.has(declared) ? declared : TOOL_SCOPE.READ;
    return {
      name: entry.def.name,
      scope,
      description: entry.def.description,
      inputSchema: entry.def.schema,
      execute: async (args, ctx = {}) => {
        // ctx flows in already sanitised by the tool framework (scrubEnv and
        // friends run before this is called); only a minimal projection is
        // passed on, so a plugin can never see the approval pipeline, agent
        // state, or signal bookkeeping.
        return entry.def.execute(args, {
          workspaceRoot: ctx.workspaceRoot ?? null,
          agentId: ctx.agent?.id ?? null,
          scope,
        });
      },
    };
  }

  /**
   * beforeAgentRun: every hook's `{extra}` plus the context enrichers'
   * budgeted blocks become one merged extra string. A plugin that returns
   * `{deny}` vetoes the run with a reason.
   */
  async runBeforeAgentRun({ agentId, task, sessionId, extra }) {
    if (this.loaded.size === 0) {
      return { ok: true, extra: typeof extra === "string" ? extra : null };
    }
    const outcome = await this.hooks.invoke("beforeAgentRun", {
      agentId,
      task: task ?? null,
      sessionId: sessionId ?? null,
      extra: typeof extra === "string" ? extra : null,
    });

    let deny = null;
    let denyBy = null;
    const extras = [];
    for (const sub of outcome.values) {
      const value = sub.value;
      if (!value || typeof value !== "object") continue;
      if (typeof value.extra === "string" && value.extra.trim() !== "") {
        extras.push(value.extra.trim());
      }
      if (value.deny === true && deny === null) {
        deny = typeof value.reason === "string" && value.reason.trim() ? value.reason : "denied by plugin";
        denyBy = sub.pluginId;
      }
    }
    if (deny !== null) {
      const list = this.problems.get(denyBy) ?? [];
      list.push(`beforeAgentRun vetoed run: ${deny}`);
      this.problems.set(denyBy, list);
      return { ok: false, deny: true, reason: deny };
    }

    // Enrichers ride along in the same step, under the remaining budget after
    // the hooks' own extra text is accounted for.
    const used = extras.reduce((n, txt) => n + estimateTokens(txt), 0);
    const budget = Math.max(0, this.promptTokenBudget - used);
    const enrichment = await this.contexts.enrich(
      { agentId, task: task ?? null, sessionId: sessionId ?? null },
      { tokenBudget: budget }
    );
    const enrichedText = renderPluginContext(enrichment);
    return {
      ok: true,
      extra: mergeExtraText(typeof extra === "string" ? extra : null, ...extras, enrichedText || null),
      enrichment,
    };
  }

  /** afterAgentRun: observe-only. Errors are registry-captured; no rejection. */
  async runAfterAgentRun(result) {
    if (this.loaded.size === 0 || !result) return;
    await this.hooks.invoke("afterAgentRun", {
      agentId: result.agentId,
      completed: Boolean(result.completed),
      state: result.state,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      model: result.model ?? null,
      output:
        typeof result.output === "string" ? result.output : result.output?.summary ?? null,
      error: result.error ?? null,
    });
  }

  /** beforeToolExecute: a plugin may refuse a call before approval runs. */
  async runBeforeToolExecute({ tool, args, agentId }) {
    if (this.loaded.size === 0) return {};
    const outcome = await this.hooks.invoke("beforeToolExecute", {
      tool,
      args: args ?? {},
      agentId: agentId ?? null,
    });
    for (const sub of outcome.values) {
      const value = sub.value;
      if (value && typeof value === "object" && value.deny === true) {
        return {
          deny: true,
          reason:
            typeof value.reason === "string" && value.reason.trim()
              ? value.reason
              : "denied by plugin",
          pluginId: sub.pluginId,
        };
      }
    }
    return { deny: false };
  }

  /** afterToolExecute: may supply a replacement output the model sees. */
  async runAfterToolExecute({ tool, output, agentId }) {
    if (this.loaded.size === 0) return {};
    const outcome = await this.hooks.invoke("afterToolExecute", {
      tool,
      output: typeof output === "string" ? output : null,
      agentId: agentId ?? null,
    });
    for (const sub of outcome.values) {
      const value = sub.value;
      if (value && typeof value === "object" && typeof value.output === "string") {
        return { output: value.output, pluginId: sub.pluginId };
      }
    }
    return {};
  }

  /**
   * onShutdown, then every plugin's deactivate. Used by ChatSession teardown
   * and the doctor; both routes must never reject.
   */
  async shutdown() {
    try {
      if (this.hooks.count("onShutdown") > 0) {
        await this.hooks.invoke("onShutdown", {});
      }
    } catch {
      /* a shutdown hook that threw is swallowed on purpose: the agent still exits */
    }
    for (const plugin of this.loaded.values()) {
      if (plugin?.deactivate) await plugin.deactivate();
    }
    this.loaded.clear();
  }

  /** Command lookup the engine consults before "unknown command". */
  command(name) {
    return this.commands.get(name);
  }

  /** Sorted command listing for /help. */
  listCommands() {
    return this.commands.list();
  }

  /** Execute one plugin command, fail-isolated. */
  runCommand(name, arg, session) {
    return runPluginCommand(this.commands, name, arg, session);
  }

  /**
   * A {complete, streamComplete} dispatch wrapper, or null when no plugin
   * provider is registered. The caller inlines it in front of the base
   * gateway pair; non-plugin providers pass through untouched.
   */
  providerDispatch(base) {
    if (this.providers.size === 0) return null;
    return installPluginProviderDispatch({ base, registry: this.providers });
  }

  /** CLI/doctor snapshot. */
  stats() {
    const loaded = [...this.loaded.values()].map((p) => ({
      id: p.spec.id,
      source: p.spec.source,
      format: p.format,
      initMs: p.initMs,
      version: p.spec.version ?? null,
      permissions: p.spec.permissions,
      tools: this.tools.forPlugin(p.spec.id).map((t) => t.fullName),
      providers: this.providers.byPluginProviders(p.spec.id).map((x) => x.providerId),
      commands: (this.commands.commandsForPlugin(p.spec.id) ?? []).map((c) => c.def.name),
      contexts: this.contexts.providersForPlugin(p.spec.id).map((c) => c.def.name),
      hooks: this.hooks.hookNamesFor(p.spec.id),
      diagnostics: this.problems.get(p.spec.id) ?? [],
    }));
    return {
      initialised: this.initialised,
      loaded,
      problems: [...this.problems.entries()].map(([id, lines]) => ({ id, lines })),
    };
  }
}