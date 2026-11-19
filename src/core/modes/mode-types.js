// Operating-mode types for AgentFlow.
//
// Four first-class operating modes: Plan, Build, Orchestrate, Auto.
// Each mode has a policy that governs tool permissions, model configuration,
// execution bounds, and security requirements. The policy is enforced in the
// execution layer, not merely in prompts or UI.
//
// Mode lifecycle: selected → active → (user transitions) → active ...
// Context (session, blackboard, plan) is preserved across transitions.

/** The four operating modes. */
export const MODE = {
  PLAN: "plan",
  BUILD: "build",
  ORCHESTRATE: "orchestrate",
  AUTO: "auto",
};

export const MODE_NAMES = {
  [MODE.PLAN]: "Plan",
  [MODE.BUILD]: "Build",
  [MODE.ORCHESTRATE]: "Orchestrate",
  [MODE.AUTO]: "Auto",
};

export const MODE_DESCRIPTIONS = {
  [MODE.PLAN]: "Investigate and design — read-only planning and analysis",
  [MODE.BUILD]: "Implement and test — controlled code modification",
  [MODE.ORCHESTRATE]: "Coordinate agents — delegate work across workers",
  [MODE.AUTO]: "Autonomous workflow — investigate, plan, build, verify",
};

/** The ordering for Tab cycling: Plan → Build → Orchestrate → Auto → Plan. */
export const MODE_CYCLE = [MODE.PLAN, MODE.BUILD, MODE.ORCHESTRATE, MODE.AUTO];

/** Privilege level of each mode, used to detect escalation on transition. */
export const MODE_PRIVILEGE = {
  [MODE.PLAN]: 1,      // read-only
  [MODE.BUILD]: 2,     // write + test shell
  [MODE.ORCHESTRATE]: 2, // write + subagent delegation
  [MODE.AUTO]: 3,      // write + autonomous cycles + security gate
};

/** A mode-specific execution policy. */
export class ModePolicy {
  constructor({
    mode,
    scopes = [],
    allow = [],
    ask = [],
    deny = [],
    requireApproval = [],
    allowedAgentIds = [],
    maxSubagents = 0,
    securityGateRequired = false,
    modelRequirements = [],
    maxIterations,
    maxToolCalls,
    timeoutMs,
    maxContextChars,
    preferredModelCapabilities = [],
    allowShellWrites = false,
    allowNetwork = false,
    allowPackage = false,
    allowRelease = false,
  } = {}) {
    this.mode = mode;
    this.scopes = scopes;
    this.allow = allow;
    this.ask = ask;
    this.deny = deny;
    this.requireApproval = requireApproval;
    this.allowedAgentIds = allowedAgentIds;
    this.maxSubagents = maxSubagents;
    this.securityGateRequired = securityGateRequired;
    this.modelRequirements = modelRequirements;
    this.maxIterations = maxIterations;
    this.maxToolCalls = maxToolCalls;
    this.timeoutMs = timeoutMs;
    this.maxContextChars = maxContextChars;
    this.preferredModelCapabilities = preferredModelCapabilities;
    this.allowShellWrites = allowShellWrites;
    this.allowNetwork = allowNetwork;
    this.allowPackage = allowPackage;
    this.allowRelease = allowRelease;
  }

  /** Whether this mode can write files. */
  get canWrite() {
    return this.scopes.includes("write");
  }

  /** Whether this mode can run shell commands. */
  get canShell() {
    return this.scopes.includes("shell");
  }

  /** Whether this mode can access the network. */
  get canNetwork() {
    return this.scopes.includes("network");
  }

  /** Whether this mode can launch subagents. */
  get canSubagent() {
    return this.scopes.includes("subagent") || this.maxSubagents > 0;
  }

  /** Whether transitioning from `from` to this mode is a privilege escalation. */
  isEscalation(from) {
    return (MODE_PRIVILEGE[this.mode] || 0) > (MODE_PRIVILEGE[from] || 0);
  }

  /** Whether this mode is blocked by a missing security gate (Auto only). */
  isBlockedBySecurityGate(gateEligible) {
    return this.securityGateRequired && !gateEligible;
  }

  toJSON() {
    return {
      mode: this.mode,
      scopes: this.scopes,
      allow: this.allow,
      ask: this.ask,
      deny: this.deny,
      requireApproval: this.requireApproval,
      allowedAgentIds: this.allowedAgentIds,
      maxSubagents: this.maxSubagents,
      securityGateRequired: this.securityGateRequired,
      modelRequirements: this.modelRequirements,
      maxIterations: this.maxIterations,
      maxToolCalls: this.maxToolCalls,
      timeoutMs: this.timeoutMs,
      maxContextChars: this.maxContextChars,
      preferredModelCapabilities: this.preferredModelCapabilities,
      canWrite: this.canWrite,
      canShell: this.canShell,
      canNetwork: this.canNetwork,
      canSubagent: this.canSubagent,
    };
  }
}

/** The currently active mode state, persisted across a session. */
export class ModeState {
  constructor({ mode = MODE.PLAN, sessionId = null, previousMode = null, switchedAt = null, switchCount = 0 } = {}) {
    this.mode = mode;
    this.sessionId = sessionId;
    this.previousMode = previousMode;
    this.switchedAt = switchedAt || new Date().toISOString();
    this.switchCount = switchCount;
  }

  /** Switch to a new mode, recording the previous mode. */
  switchTo(newMode, { sessionId = this.sessionId } = {}) {
    if (newMode === this.mode) return false;
    this.previousMode = this.mode;
    this.mode = newMode;
    this.sessionId = sessionId;
    this.switchedAt = new Date().toISOString();
    this.switchCount += 1;
    return true;
  }

  toJSON() {
    return {
      mode: this.mode,
      sessionId: this.sessionId,
      previousMode: this.previousMode,
      switchedAt: this.switchedAt,
      switchCount: this.switchCount,
    };
  }
}

export default { MODE, MODE_NAMES, MODE_DESCRIPTIONS, MODE_CYCLE, MODE_PRIVILEGE, ModePolicy, ModeState };
