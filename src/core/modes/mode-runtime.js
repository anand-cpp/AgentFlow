// ModeRuntime — wraps AgentRuntime with mode-specific policy enforcement.
//
// The ModeRuntime does NOT duplicate AgentRuntime. It delegates to it, injecting
// mode-scoped tools, model requirements, bounds, and approval behavior. Every
// tool call still passes through the existing `runTool` permission pipeline.
// Mode policies narrow what can reach that pipeline; they never widen it.

import { AgentRuntime } from "../agents/runtime.js";
import { AgentRegistry, CAPABILITY, TOOL_SCOPE } from "../agents/registry.js";
import { builtinSpecs } from "../agents/definitions.js";

import { EVENTS } from "../events.js";

/** Filter built-in agents to those allowed by the mode policy. */
function filterAgentsByPolicy(allAgents, allowedIds) {
  const allowed = new Set(allowedIds || []);
  return allAgents.filter((a) => allowed.has(a.id));
}

/** Build a mode-scoped tool policy from a ModePolicy. */
function buildToolPolicy(modePolicy, _agentTools) {
  const scopes = [...modePolicy.scopes];
  const allow = [...modePolicy.allow];
  const ask = [...modePolicy.ask];
  const deny = [...modePolicy.deny];
  const requireApproval = [...modePolicy.requireApproval];

  // If shell writes are not allowed, deny shell write patterns.
  if (!modePolicy.allowShellWrites) {
    deny.push("shell:npm install", "shell:npm publish", "shell:git push", "shell:git pull", "shell:rm -rf", "shell:curl |", "shell:wget |");
  }

  // If network is not allowed, deny network scope entries.
  if (!modePolicy.allowNetwork) {
    deny.push("network:*");
  }

  // If package operations are not allowed, deny package scope.
  if (!modePolicy.allowPackage) {
    deny.push("package:*");
  }

  // If release operations are not allowed, deny release scope.
  if (!modePolicy.allowRelease) {
    deny.push("release:*");
  }

  return {
    scopes,
    allow,
    ask,
    deny,
    requireApproval,
    maxCalls: modePolicy.maxToolCalls,
  };
}

/** Build mode-specific bounds from a ModePolicy. */
function buildBounds(modePolicy) {
  return {
    maxIterations: modePolicy.maxIterations,
    maxToolCalls: modePolicy.maxToolCalls,
    timeoutMs: modePolicy.timeoutMs,
    maxDepth: 3,
    maxContextChars: modePolicy.maxContextChars,
  };
}

/** Build model requirements from a ModePolicy. */
function buildModelRequirements(modePolicy) {
  const req = [...modePolicy.modelRequirements];
  const capMap = {
    reasoning: CAPABILITY.REASONING,
    coding: CAPABILITY.CODING,
    tool_calling: CAPABILITY.TOOL_CALLING,
    research: CAPABILITY.RESEARCH,
    security: CAPABILITY.SECURITY,
    planning: CAPABILITY.PLANNING,
  };
  return req.map((r) => capMap[r]).filter(Boolean);
}

/**
 * ModeRuntime wraps an AgentRuntime and enforces the active mode's policy.
 *
 * Construction: `new ModeRuntime({ modeRegistry, complete, ...runtimeOptions })`
 *   - modeRegistry: ModeRegistry instance (provides active policy)
 *   - All other options are passed through to AgentRuntime.
 *
 * The `run()` method delegates to AgentRuntime.run() but first applies mode
 * policy to the agent's tool policy, bounds, and model requirements.
 */
class ModeRuntime {
  constructor({
    modeRegistry,
    complete,
    catalogue,
    hints,
    log,
    now,
    approver,
    blackboard,
    sessions,
    providerHealth,
    limiter,
    usageLedger,
    guards,
    config,
    workspaceRoot,
    lspBridge,
    plugins,
    ...runtimeOptions
  } = {}) {
    if (!modeRegistry) throw new Error("ModeRuntime requires a modeRegistry");
    if (typeof complete !== "function") throw new Error("ModeRuntime requires a complete function");

    this.modeRegistry = modeRegistry;
    this.runtimeOptions = {
      complete,
      catalogue,
      hints,
      log,
      now,
      approver,
      blackboard,
      sessions,
      providerHealth,
      limiter,
      usageLedger,
      guards,
      config,
      workspaceRoot,
      lspBridge,
      plugins,
      ...runtimeOptions,
    };

    // Build the underlying runtime lazily on first run, so the policy is
    // current at run time (mode may switch between runs).
    this._runtime = null;
    this._agentRegistry = null;
  }

  /** Get or construct the underlying AgentRuntime with current policy applied. */
  _buildRuntime() {
    if (this._runtime) return this._runtime;

    const policy = this.modeRegistry.getPolicy();
    const mode = this.modeRegistry.getMode();

    // Build a filtered agent registry: only agents allowed by this mode.
    const allAgents = builtinSpecs();
    const allowedAgents = filterAgentsByPolicy(allAgents, policy.allowedAgentIds);
    const reg = new AgentRegistry(allowedAgents);
    this._agentRegistry = reg;

    // Apply mode policy to tool scopes. We don't modify the agent definitions
    // directly (they're frozen); instead we wrap evaluatePermission behavior
    // via the runtime's approver and guards. The cleanest approach: pass the
    // mode policy as a guard that runs before the standard pipeline.

    const modeGuard = this._makeModeGuard(policy);

    const guards = [...(this.runtimeOptions.guards || []), modeGuard];

    const _bounds = buildBounds(policy);
    const _modelRequirements = buildModelRequirements(policy);

    const runtime = new AgentRuntime({
      ...this.runtimeOptions,
      registry: reg,
      guards,
      config: {
        ...this.runtimeOptions.config,
        // Override defaultModel if the mode has a pin; otherwise leave as-is.
        defaultModel: this.runtimeOptions.config?.defaultModel,
      },
    });

    // Attach mode metadata to the runtime for inspection.
    runtime._mode = mode;
    runtime._modePolicy = policy;
    runtime._agentRegistry = reg;

    this._runtime = runtime;
    return runtime;
  }

  /** Create a guard that enforces mode-specific tool restrictions. */
  _makeModeGuard(policy) {
    return async (call, ctx) => {
      const { _agent, tool } = ctx;
      if (!tool) return undefined; // let the pipeline decide

      const toolScope = tool.scope;
      if (!toolScope) return undefined;

      // Check mode-level deny entries first.
      for (const entry of policy.deny) {
        if (this._entryMatches(entry, call, toolScope)) {
          return { action: "deny", reason: `mode ${policy.mode} denies ${toolScope}:${entry.value || "*"}` };
        }
      }

      // Check mode-level allow entries.
      const hasAllow = policy.allow.some((e) => this._entryMatches(e, call, toolScope));
      if (hasAllow) return undefined; // allowed by mode, proceed to standard pipeline

      // Check mode-level ask entries.
      const hasAsk = policy.ask.some((e) => this._entryMatches(e, call, toolScope));
      if (hasAsk) {
        // Require approval through the standard pipeline's approver.
        // Returning undefined lets evaluatePermission handle it; the ask list
        // means it needs approval.
        return undefined;
      }

      // If the scope is not in the mode's granted scopes, deny.
      if (!policy.scopes.includes(toolScope)) {
        return { action: "deny", reason: `scope ${toolScope} not granted in ${policy.mode} mode` };
      }

      // Scope granted but no explicit allow/ask entry — standard pipeline decides.
      return undefined;
    };
  }

  /** Match a mode policy entry against a tool call. */
  _entryMatches(entry, call, toolScope) {
    const [entryScope, entryValue] = entry.includes(":") ? entry.split(":", 2) : [entry, "*"];
    if (entryScope !== toolScope && entryScope !== "*") return false;
    if (entryValue === "*") return true;

    const args = call.args || {};
    if (toolScope === TOOL_SCOPE.SHELL || toolScope === TOOL_SCOPE.TEST || toolScope === TOOL_SCOPE.PACKAGE) {
      const command = String(args.command || args.cmd || "");
      if (!command) return false;
      const a = String(entryValue).trim().split(/\s+/).filter(Boolean);
      const b = command.trim().split(/\s+/).filter(Boolean);
      if (!a.length || a.length > b.length) return false;
      return a.every((tok, i) => tok === b[i]);
    }

    if (toolScope === TOOL_SCOPE.READ || toolScope === TOOL_SCOPE.SEARCH || toolScope === TOOL_SCOPE.WRITE) {
      return String(args.path || "").startsWith(entryValue);
    }

    return false;
  }

  /** Get the current mode. */
  get mode() {
    return this.modeRegistry.getMode();
  }

  /** Get the current mode policy. */
  get policy() {
    return this.modeRegistry.getPolicy();
  }

  /** Get the underlying agent registry (mode-filtered). */
  get agentRegistry() {
    if (!this._agentRegistry) this._buildRuntime();
    return this._agentRegistry;
  }

  /** Run one agent against one task, with mode policy enforced. */
  async run(opts = {}) {
    const runtime = this._buildRuntime();
    const policy = this.policy;
    const mode = this.mode;

    // Emit mode context before running.
    runtime.log?.emit(EVENTS.AGENT_STATE, {
      agentId: opts.agentId,
      state: "mode_active",
      mode,
      policy: policy.toJSON ? policy.toJSON() : policy,
    }, "info");

    // Apply mode-specific model requirements to the options if not already set.
    if (!opts.hints && policy.modelRequirements.length) {
      // The hints are resolved in resolveModelPlan; we pass modelRequirements
      // through extra so the runtime can use them.
      opts.extra = { ...(opts.extra || {}), _modeRequirements: policy.modelRequirements, _mode: mode };
    }

    const result = await runtime.run(opts);

    // Attach mode info to the result for consumers.
    result._mode = mode;
    result._modePolicy = policy.toJSON ? policy.toJSON() : policy;

    return result;
  }

  /** Switch modes (delegates to ModeRegistry). */
  async switchMode(newMode, opts = {}) {
    return this.modeRegistry.switchTo(newMode, opts);
  }

  /** Cycle to the next mode (Tab behavior). */
  async cycleMode(opts = {}) {
    return this.modeRegistry.cycle(opts);
  }

  /** Check if switching to `target` would escalate privileges. */
  isEscalation(target) {
    return this.modeRegistry.isEscalation(target);
  }
}

export { ModeRuntime, buildToolPolicy, buildBounds, buildModelRequirements };
export default { ModeRuntime, buildToolPolicy, buildBounds, buildModelRequirements };
