// Mode policies — the execution rules for each operating mode.
//
// Policies are enforced in the execution layer (AgentRuntime wrapper, tool
// pipeline, security gate), not merely in prompts. Each mode defines:
//   - which tool scopes are granted
//   - which tool entries are allowed silently vs. require approval vs. denied
//   - which built-in agents may be invoked
//   - model capability requirements
//   - execution bounds
//   - security gate requirements (Auto only)

import { MODE, MODE_PRIVILEGE, ModePolicy, MODE_CYCLE } from "./mode-types.js";

const T = {
  READ: "read",
  SEARCH: "search",
  WRITE: "write",
  SHELL: "shell",
  NETWORK: "network",
  TEST: "test",
  PACKAGE: "package",
  RELEASE: "release",
};

// ---------------------------------------------------------------------------
// Plan Mode — read-only planning and analysis
// ---------------------------------------------------------------------------
// Grants read and search only. No write, no shell writes, no network.
// Cannot modify files, launch subagents, or run destructive commands.
// Output is a plan: summary, steps with checkable outcomes, risks.
const PLAN_POLICY = new ModePolicy({
  mode: MODE.PLAN,
  scopes: [T.READ, T.SEARCH],
  allow: ["read:*", "search:*"],
  ask: [],
  deny: [],
  requireApproval: [],
  allowedAgentIds: ["planner", "researcher", "reviewer", "security"],
  maxSubagents: 0,
  securityGateRequired: false,
  modelRequirements: ["reasoning"],
  maxIterations: 4,
  maxToolCalls: 8,
  timeoutMs: 180_000,
  maxContextChars: 32_000,
  preferredModelCapabilities: ["reasoning"],
  allowShellWrites: false,
  allowNetwork: false,
  allowPackage: false,
  allowRelease: false,
});

// ---------------------------------------------------------------------------
// Build Mode — controlled implementation
// ---------------------------------------------------------------------------
// Grants read, search, write, and test shell commands.
// Can modify files, run tests, debug, refactor.
// Cannot push, publish, or run arbitrary shell without approval.
// Output: implementation summary, files changed, tests run, open questions.
const BUILD_POLICY = new ModePolicy({
  mode: MODE.BUILD,
  scopes: [T.READ, T.SEARCH, T.WRITE, T.TEST, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "write:*",
    "test:*",
    "shell:git status",
    "shell:git diff",
    "shell:git log",
    "shell:npm test",
    "shell:npm run test",
  ],
  ask: ["shell:*"],
  deny: [],
  requireApproval: [T.SHELL],
  allowedAgentIds: ["coder", "debugger", "tester", "reviewer", "planner"],
  maxSubagents: 0,
  securityGateRequired: false,
  modelRequirements: ["tool_calling", "coding"],
  maxIterations: 16,
  maxToolCalls: 60,
  timeoutMs: 600_000,
  maxContextChars: 64_000,
  preferredModelCapabilities: ["tool_calling", "coding"],
  allowShellWrites: true,
  allowNetwork: false,
  allowPackage: false,
  allowRelease: false,
});

// ---------------------------------------------------------------------------
// Orchestrate Mode — multi-agent coordination
// ---------------------------------------------------------------------------
// Grants read, search, write, test shell, and subagent delegation.
// Can launch subagents (each with restricted permissions), coordinate work,
// aggregate results, handle conflicts.
// Subagents do NOT inherit unrestricted permissions.
// Output: aggregated results, conflict resolution, verification status.
const ORCHESTRATE_POLICY = new ModePolicy({
  mode: MODE.ORCHESTRATE,
  scopes: [T.READ, T.SEARCH, T.WRITE, T.TEST, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "write:*",
    "test:*",
    "shell:git status",
    "shell:git diff",
    "shell:git log",
    "shell:npm test",
  ],
  ask: ["shell:*"],
  deny: [],
  requireApproval: [T.SHELL],
  allowedAgentIds: ["coder", "debugger", "tester", "reviewer", "planner"],
  maxSubagents: 3,
  securityGateRequired: false,
  modelRequirements: ["reasoning", "tool_calling"],
  maxIterations: 12,
  maxToolCalls: 40,
  timeoutMs: 300_000,
  maxContextChars: 48_000,
  preferredModelCapabilities: ["reasoning", "tool_calling"],
  allowShellWrites: true,
  allowNetwork: false,
  allowPackage: false,
  allowRelease: false,
});

// ---------------------------------------------------------------------------
// Auto Mode — autonomous end-to-end workflow
// ---------------------------------------------------------------------------
// Same tool access as Build Mode, but gated by the security delivery gate.
// Intelligently cycles: investigate → plan → build → test → verify.
// Cannot bypass SkillSpector gate, delivery gate, or approval controls.
// Requires security gate eligible before proceeding to delivery.
// Output: final result with verification evidence.
const AUTO_POLICY = new ModePolicy({
  mode: MODE.AUTO,
  scopes: [T.READ, T.SEARCH, T.WRITE, T.TEST, T.SHELL],
  allow: [
    "read:*",
    "search:*",
    "write:*",
    "test:*",
    "shell:git status",
    "shell:git diff",
    "shell:git log",
    "shell:npm test",
    "shell:npm run test",
  ],
  ask: ["shell:*"],
  deny: [],
  requireApproval: [T.SHELL],
  allowedAgentIds: ["coder", "debugger", "tester", "reviewer", "planner", "security"],
  maxSubagents: 2,
  securityGateRequired: true,
  modelRequirements: ["reasoning", "tool_calling"],
  maxIterations: 24,
  maxToolCalls: 100,
  timeoutMs: 900_000,
  maxContextChars: 96_000,
  preferredModelCapabilities: ["reasoning", "tool_calling"],
  allowShellWrites: true,
  allowNetwork: false,
  allowPackage: false,
  allowRelease: false,
});

/** All mode policies keyed by mode id. */
export const MODE_POLICIES = {
  [MODE.PLAN]: PLAN_POLICY,
  [MODE.BUILD]: BUILD_POLICY,
  [MODE.ORCHESTRATE]: ORCHESTRATE_POLICY,
  [MODE.AUTO]: AUTO_POLICY,
};

/** Get the policy for a mode. */
export function getModePolicy(mode) {
  const policy = MODE_POLICIES[mode];
  if (!policy) {
    throw new Error(`unknown mode: ${mode}`);
  }
  return policy;
}

/** Get the default mode (Plan — read-only, safest). */
export function getDefaultMode() {
  return MODE.PLAN;
}

/** Get the next mode in the Tab cycle. */
export function nextMode(mode) {
  const idx = MODE_CYCLE.indexOf(mode);
  if (idx === -1) return MODE.PLAN;
  return MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
}

export { PLAN_POLICY, BUILD_POLICY, ORCHESTRATE_POLICY, AUTO_POLICY };
export default {
  MODE,
  MODE_PRIVILEGE,
  MODE_POLICIES,
  getModePolicy,
  getDefaultMode,
  nextMode,
  PLAN_POLICY,
  BUILD_POLICY,
  ORCHESTRATE_POLICY,
  AUTO_POLICY,
};
