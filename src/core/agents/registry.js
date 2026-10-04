// Agent registry.
//
// An agent is a declaration, not a prompt file. The declaration says what the
// agent is for, what the model must be able to do, which tools it may touch, and
// what happens when it fails. The runtime reads those fields and makes every
// decision; it never asks "which agent is this?" with a hardcoded switch.
//
// Two rules shape this module.
//
// Explicit validation, field by field. The Blackboard does the same thing and for
// the same reason: spreading a caller payload into a record is how a typo becomes
// a permanent field, and how provider output ends up nested inside state that is
// supposed to be trustworthy. Unknown keys are dropped rather than merged.
//
// Capabilities are a closed vocabulary. `capabilities: ["coding"]` is checkable;
// `capabilities: ["code"]` is a typo that silently never matches, and the failure
// shows up three layers away as "this agent behaves like it can't write code".
// So an unknown capability is rejected at registration, where the mistake is.

import { containsSecret } from "../redact.js";

/**
 * What a model must be able to do for an agent to work.
 *
 * These are requirements, not implementations. Nothing here names a provider or
 * a model -- that is the whole point. An agent says "I need tool calling" and the
 * requirement resolver finds whichever configured model can do it.
 */
export const CAPABILITY = {
  REASONING: "reasoning",
  CODING: "coding",
  TOOL_CALLING: "tool_calling",
  STRUCTURED_OUTPUT: "structured_output",
  LONG_CONTEXT: "long_context",
  RESEARCH: "research",
  SECURITY: "security",
  PLANNING: "planning",
};

const CAPABILITIES = new Set(Object.values(CAPABILITY));

/**
 * Tool permission scopes.
 *
 * `read` and `search` are safe enough to grant without thought. Everything that
 * can change the world or reach a network is named separately, because
 * "Coder can write files" and "Coder can run arbitrary shell" are different
 * decisions with different consequences and should not be one flag.
 */
export const TOOL_SCOPE = {
  READ: "read",
  SEARCH: "search",
  WRITE: "write",
  SHELL: "shell",
  NETWORK: "network",
  TEST: "test",
  PACKAGE: "package",
  RELEASE: "release",
};

const TOOL_SCOPES = new Set(Object.values(TOOL_SCOPE));

/** Lifecycle phases an execution passes through. Ordered; used for transitions. */
export const AGENT_STATE = {
  CREATED: "created",
  CONTEXT_LOADING: "context_loading",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed_out",
};

export class AgentError extends Error {
  constructor(message, code = "agent_error") {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

export class AgentDefinitionError extends AgentError {
  constructor(message, field = null) {
    super(message, "invalid_agent_definition");
    this.name = "AgentDefinitionError";
    this.field = field;
  }
}

export class AgentNotFoundError extends AgentError {
  constructor(id, known = []) {
    const hint = known.length ? `; known agents: ${known.join(", ")}` : "";
    super(`no such agent: ${id}${hint}`, "agent_not_found");
    this.name = "AgentNotFoundError";
    this.id = id;
  }
}

export class AgentConflictError extends AgentError {
  constructor(id) {
    super(`agent already registered: ${id}`, "agent_conflict");
    this.name = "AgentConflictError";
    this.id = id;
  }
}

const AGENT_ID_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const MAX_NAME = 80;
const MAX_PURPOSE = 400;
const MAX_INSTRUCTIONS = 20_000;

// Sensible ceilings. These exist so a bad agent definition cannot remove the
// runtime's ability to bound work: an agent that declares "unlimited iterations"
// would otherwise turn a loop bug into an infinite loop.
export const LIMITS = {
  maxIterations: 12,
  maxToolCalls: 40,
  timeoutMs: 120_000,
  maxRetries: 2,
  maxDepth: 3,
  maxContextChars: 24_000,
};

function asString(value, field, { max, required = true } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new AgentDefinitionError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== "string") throw new AgentDefinitionError(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new AgentDefinitionError(`${field} must not be empty`, field);
    return null;
  }
  if (max && trimmed.length > max) {
    throw new AgentDefinitionError(`${field} exceeds ${max} characters (got ${trimmed.length})`, field);
  }
  return trimmed;
}

function asStringArray(value, field, { allowed = null, max = 32 } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new AgentDefinitionError(`${field} must be an array`, field);
  if (value.length > max) throw new AgentDefinitionError(`${field} has more than ${max} entries`, field);
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new AgentDefinitionError(`${field} entries must be non-empty strings`, field);
    }
    const item = entry.trim();
    if (allowed && !allowed.has(item)) {
      throw new AgentDefinitionError(
        `${field} contains an unknown value: ${item} (allowed: ${[...allowed].join(", ")})`,
        field
      );
    }
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function asPositiveInt(value, fallback, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AgentDefinitionError(`${field} must be an integer`, field);
  }
  if (n < min) throw new AgentDefinitionError(`${field} must be >= ${min}`, field);
  if (n > max) throw new AgentDefinitionError(`${field} must be <= ${max}`, field);
  return n;
}

/**
 * Tool grants: which scopes are pre-granted, and which need approval.
 *
 * Modelled as an explicit allowlist rather than a denylist. A denylist means a
 * newly added tool is allowed by default, which is exactly the wrong default for
 * something that can run shell commands.
 */
function normaliseToolPolicy(value, field = "tools") {
  const policy = {
    scopes: [],
    allow: [],
    deny: [],
    requireApproval: [],
    maxCalls: LIMITS.maxToolCalls,
  };
  if (value === null || value === undefined) return policy;

  if (Array.isArray(value)) {
    // Shorthand: a bare array is a list of granted scopes.
    policy.scopes = asStringArray(value, `${field}.scopes`, { allowed: TOOL_SCOPES });
    return policy;
  }
  if (typeof value !== "object") {
    throw new AgentDefinitionError(`${field} must be an array or an object`, field);
  }

  policy.scopes = asStringArray(value.scopes, `${field}.scopes`, { allowed: TOOL_SCOPES });
  policy.allow = asStringArray(value.allow, `${field}.allow`, { max: 128 });
  policy.deny = asStringArray(value.deny, `${field}.deny`, { max: 128 });
  policy.requireApproval = asStringArray(value.requireApproval, `${field}.requireApproval`, { max: 128 });
  policy.maxCalls = asPositiveInt(value.maxCalls, LIMITS.maxToolCalls, `${field}.maxCalls`, { max: 10_000 });
  return policy;
}

/**
 * Model policy: requirements plus hard preferences.
 *
 * `prefer` and `requireCapabilities` are different things and conflating them is
 * how an agent ends up unusable. A preference is tried first and abandoned on
 * failure. A requirement is what makes a model a candidate at all.
 */
function normaliseModelPolicy(value, field = "model") {
  const policy = {
    requireCapabilities: [],
    prefer: [],
    maxTokens: 4096,
    temperature: null,
    pinModel: null,
  };
  if (value === null || value === undefined) return policy;

  if (typeof value === "string") {
    // Shorthand: `model: "provider/id"` pins one model.
    policy.pinModel = asString(value, `${field}.pinModel`, { max: 200 });
    return policy;
  }
  if (typeof value !== "object") {
    throw new AgentDefinitionError(`${field} must be a string or an object`, field);
  }

  policy.requireCapabilities = asStringArray(
    value.requireCapabilities,
    `${field}.requireCapabilities`,
    { allowed: CAPABILITIES }
  );
  policy.prefer = asStringArray(value.prefer, `${field}.prefer`, { max: 64 });
  policy.maxTokens = asPositiveInt(value.maxTokens, 4096, `${field}.maxTokens`, { min: 16, max: 200_000 });
  if (value.temperature !== null && value.temperature !== undefined) {
    const t = Number(value.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      throw new AgentDefinitionError(`${field}.temperature must be between 0 and 2`, `${field}.temperature`);
    }
    policy.temperature = t;
  }
  policy.pinModel = value.pinModel ? asString(value.pinModel, `${field}.pinModel`, { max: 200 }) : null;

  if (policy.pinModel && policy.requireCapabilities.length) {
    throw new AgentDefinitionError(
      `${field}: pinModel and requireCapabilities are mutually exclusive -- a pinned model is not filtered`,
      field
    );
  }
  return policy;
}

/** Routing policy: how hard to try before giving up, and whether to fall back. */
function normaliseRoutingPolicy(value, field = "routing") {
  const policy = {
    allowFallback: true,
    maxAttempts: 0,
    tierSize: 2,
    skipUnconfigured: true,
  };
  if (value === null || value === undefined) return policy;
  if (typeof value !== "object") throw new AgentDefinitionError(`${field} must be an object`, field);

  policy.allowFallback = value.allowFallback !== false;
  // 0 means "one attempt per candidate", which is the router's own behaviour.
  policy.maxAttempts = asPositiveInt(value.maxAttempts, 0, `${field}.maxAttempts`, { min: 0, max: 64 });
  policy.tierSize = asPositiveInt(value.tierSize, 2, `${field}.tierSize`, { min: 1, max: 64 });
  policy.skipUnconfigured = value.skipUnconfigured !== false;
  return policy;
}

/** Failure policy: what the runtime does when the model or a tool fails. */
function normaliseFailurePolicy(value, field = "failure") {
  const policy = {
    maxRetries: LIMITS.maxRetries,
    retryOn: ["timeout", "server", "network", "rate_limited", "unknown"],
    escalateAfterRetries: true,
    giveUpOnPermissionDenied: true,
  };
  if (value === null || value === undefined) return policy;
  if (typeof value !== "object") throw new AgentDefinitionError(`${field} must be an object`, field);

  policy.maxRetries = asPositiveInt(value.maxRetries, LIMITS.maxRetries, `${field}.maxRetries`, {
    min: 0,
    max: 10,
  });
  policy.retryOn = asStringArray(value.retryOn, `${field}.retryOn`, { max: 16 });
  policy.escalateAfterRetries = value.escalateAfterRetries !== false;
  policy.giveUpOnPermissionDenied = value.giveUpOnPermissionDenied !== false;
  return policy;
}

/** Bounded execution limits, clamped so an agent cannot defeat the runtime. */
function normaliseBounds(value, field = "bounds") {
  const bounds = {
    maxIterations: LIMITS.maxIterations,
    maxToolCalls: LIMITS.maxToolCalls,
    timeoutMs: LIMITS.timeoutMs,
    maxDepth: LIMITS.maxDepth,
    maxContextChars: LIMITS.maxContextChars,
  };
  if (value === null || value === undefined) return bounds;
  if (typeof value !== "object") throw new AgentDefinitionError(`${field} must be an object`, field);

  // Upper caps are the runtime's, not the agent's. An agent may ask for less
  // work than the default; it may not ask for unbounded work.
  bounds.maxIterations = asPositiveInt(value.maxIterations, bounds.maxIterations, `${field}.maxIterations`, {
    min: 1,
    max: 100,
  });
  bounds.maxToolCalls = asPositiveInt(value.maxToolCalls, bounds.maxToolCalls, `${field}.maxToolCalls`, {
    min: 0,
    max: 1000,
  });
  bounds.timeoutMs = asPositiveInt(value.timeoutMs, bounds.timeoutMs, `${field}.timeoutMs`, {
    min: 100,
    max: 30 * 60_000,
  });
  bounds.maxDepth = asPositiveInt(value.maxDepth, bounds.maxDepth, `${field}.maxDepth`, { min: 0, max: 10 });
  bounds.maxContextChars = asPositiveInt(
    value.maxContextChars,
    bounds.maxContextChars,
    `${field}.maxContextChars`,
    { min: 1000, max: 1_000_000 }
  );
  return bounds;
}

/**
 * The task input/output contracts.
 *
 * Declared as a field list rather than a JSON Schema object on purpose: the
 * runtime only ever needs "which fields, which required, which type", and
 * inventing a schema validator here would be a worse version of the one already
 * in the repository. A caller supplies these, so they are validated.
 */
function normaliseContract(value, field) {
  const contract = { fields: [], unknownFields: "reject" };
  if (value === null || value === undefined) return contract;
  if (typeof value !== "object") throw new AgentDefinitionError(`${field} must be an object`, field);

  const entries = Array.isArray(value) ? value.map((f) => [f?.name, f]) : Object.entries(value);
  for (const [name, spec] of entries) {
    if (typeof name !== "string" || !/^[a-z][a-zA-Z0-9_]*$/.test(name)) {
      throw new AgentDefinitionError(`${field}: invalid field name ${JSON.stringify(name)}`, field);
    }
    const type = asString(spec?.type ?? "string", `${field}.${name}.type`, { max: 20 });
    if (!["string", "number", "boolean", "array", "object"].includes(type)) {
      throw new AgentDefinitionError(`${field}.${name}: unknown type ${type}`, field);
    }
    contract.fields.push({
      name,
      type,
      required: spec?.required === true,
      description: spec?.description ? asString(spec.description, `${field}.${name}.description`, { max: 400 }) : null,
      maxLength: spec?.maxLength ? asPositiveInt(spec.maxLength, null, `${field}.${name}.maxLength`, { min: 1 }) : null,
    });
  }
  if (value && typeof value === "object" && !Array.isArray(value) && value.unknownFields) {
    const mode = asString(value.unknownFields, `${field}.unknownFields`, { max: 10 });
    if (!["reject", "ignore"].includes(mode)) {
      throw new AgentDefinitionError(`${field}.unknownFields must be "reject" or "ignore"`, field);
    }
    contract.unknownFields = mode;
  }
  return contract;
}

/**
 * Validate and freeze one agent declaration.
 *
 * Returns a plain object with a fixed shape. Not the caller's object: a
 * definition held by reference can be mutated after registration, which means the
 * registry and the runtime can disagree about what an agent is.
 */
export function defineAgent(spec) {
  if (!spec || typeof spec !== "object") {
    throw new AgentDefinitionError("agent definition must be an object", null);
  }

  const id = asString(spec.id, "id", { max: 60 });
  if (!AGENT_ID_RE.test(id)) {
    throw new AgentDefinitionError(
      `id must be lowercase alphanumeric with - or _ separators (got ${JSON.stringify(id)})`,
      "id"
    );
  }

  const definition = {
    id,
    name: asString(spec.name ?? id, "name", { max: MAX_NAME }),
    purpose: asString(spec.purpose, "purpose", { max: MAX_PURPOSE }),
    instructions: asString(spec.instructions, "instructions", { max: MAX_INSTRUCTIONS }),
    capabilities: asStringArray(spec.capabilities, "capabilities", { allowed: CAPABILITIES }),
    model: normaliseModelPolicy(spec.model),
    routing: normaliseRoutingPolicy(spec.routing),
    tools: normaliseToolPolicy(spec.tools),
    lifecycle: normaliseLifecycle(spec.lifecycle),
    input: normaliseContract(spec.input, "input"),
    output: normaliseContract(spec.output, "output"),
    failure: normaliseFailurePolicy(spec.failure),
    bounds: normaliseBounds(spec.bounds),
  };

  // Instructions are model input: they are shipped to a provider on every single
  // execution. Refuse to register rather than mask -- a definition with `***`
  // where a credential used to be is a silently broken agent, and that surfaces
  // as unexplained bad model behaviour rather than as a load error.
  if (containsSecret(definition)) {
    throw new AgentDefinitionError(
      `agent ${id} contains a credential-shaped value; an agent declaration is sent to a provider on ` +
        `every execution, so this is refused rather than masked`,
      "instructions"
    );
  }

  return Object.freeze({
    ...definition,
    input: Object.freeze(definition.input),
    output: Object.freeze(definition.output),
    tools: Object.freeze(definition.tools),
    model: Object.freeze(definition.model),
    routing: Object.freeze(definition.routing),
    failure: Object.freeze(definition.failure),
    bounds: Object.freeze(definition.bounds),
    capabilities: Object.freeze([...definition.capabilities]),
  });
}

/** Lifecycle declaration: hooks the runtime calls at defined points. */
function normaliseLifecycle(value, field = "lifecycle") {
  const lifecycle = {
    prepare: null,
    finalise: null,
    onToolResult: null,
  };
  if (value === null || value === undefined) return lifecycle;
  if (typeof value !== "object") throw new AgentDefinitionError(`${field} must be an object`, field);

  for (const hook of ["prepare", "finalise", "onToolResult"]) {
    if (value[hook] === undefined || value[hook] === null) continue;
    if (typeof value[hook] !== "function") {
      throw new AgentDefinitionError(`${field}.${hook} must be a function`, `${field}.${hook}`);
    }
    lifecycle[hook] = value[hook];
  }
  return lifecycle;
}

/**
 * The registry.
 *
 * Deliberately not a module-level singleton. A singleton would make agents
 * unremovable, untestable in isolation, and impossible to scope per invocation.
 * The CLI builds one per process; tests build their own.
 */
export class AgentRegistry {
  /**
   * Accepts either an array of declarations or `{ agents: [...] }`.
   *
   * The array form is what you actually want to write, and the options form
   * matches the other stores in this codebase. Supporting both costs three lines
   * and removes a genuine footgun: destructuring an array as an options object
   * yields an empty registry rather than an error, so `new AgentRegistry([spec])`
   * would silently register nothing and every lookup would fail later with a
   * confusing "no such agent".
   */
  constructor(options = {}) {
    this.agents = new Map();
    const list = Array.isArray(options) ? options : options.agents || [];
    if (!Array.isArray(list)) {
      throw new AgentDefinitionError("agents must be an array of declarations", "agents");
    }
    for (const spec of list) this.register(spec);
  }

  /**
   * Register a declaration.
   *
   * Duplicate ids are an error rather than a silent replace: two agents claiming
   * `coder` means one of them was misnamed, and quietly picking a winner is how
   * you debug the wrong agent for an afternoon.
   */
  register(spec) {
    const definition = defineAgent(spec);
    if (this.agents.has(definition.id)) throw new AgentConflictError(definition.id);
    this.agents.set(definition.id, definition);
    return definition;
  }

  /** Register many, in order. All-or-nothing is not attempted: see register(). */
  registerAll(specs) {
    return (specs || []).map((s) => this.register(s));
  }

  has(id) {
    return this.agents.has(String(id || "").trim());
  }

  /** Look up an agent, or throw with the known list attached. */
  get(id) {
    const key = String(id || "").trim();
    const found = this.agents.get(key);
    if (!found) throw new AgentNotFoundError(key, this.ids());
    return found;
  }

  find(id) {
    return this.agents.get(String(id || "").trim()) || null;
  }

  ids() {
    return [...this.agents.keys()].sort();
  }

  /** Sorted, for `aflow agent list`. */
  list() {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Agents that declare a capability. Used by requirement resolution. */
  byCapability(capability) {
    const want = String(capability || "").trim();
    return this.list().filter((a) => a.capabilities.includes(want));
  }

  unregister(id) {
    return this.agents.delete(String(id || "").trim());
  }

  get size() {
    return this.agents.size;
  }
}

export default { AgentRegistry, defineAgent, AGENT_STATE, CAPABILITY, TOOL_SCOPE, LIMITS };