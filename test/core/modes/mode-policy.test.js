// Mode policy tests — validates ModePolicy definitions and behavior.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MODE,
  MODE_PRIVILEGE,
  MODE_CYCLE,
  getModePolicy,
  getDefaultMode,
  nextMode,
  PLAN_POLICY,
  BUILD_POLICY,
  ORCHESTRATE_POLICY,
  AUTO_POLICY,
} from "../../../src/core/modes/index.js";

test("mode-policy: getDefaultMode returns PLAN", () => {
  assert.strictEqual(getDefaultMode(), MODE.PLAN);
});

test("mode-policy: MODE_CYCLE order is Plan → Build → Orchestrate → Auto", () => {
  assert.deepStrictEqual(MODE_CYCLE, [MODE.PLAN, MODE.BUILD, MODE.ORCHESTRATE, MODE.AUTO]);
});

test("mode-policy: nextMode cycles correctly", () => {
  assert.strictEqual(nextMode(MODE.PLAN), MODE.BUILD);
  assert.strictEqual(nextMode(MODE.BUILD), MODE.ORCHESTRATE);
  assert.strictEqual(nextMode(MODE.ORCHESTRATE), MODE.AUTO);
  assert.strictEqual(nextMode(MODE.AUTO), MODE.PLAN);
  assert.strictEqual(nextMode("invalid"), MODE.PLAN);
});

test("mode-policy: getModePolicy returns policies for all modes", () => {
  assert.strictEqual(getModePolicy(MODE.PLAN), PLAN_POLICY);
  assert.strictEqual(getModePolicy(MODE.BUILD), BUILD_POLICY);
  assert.strictEqual(getModePolicy(MODE.ORCHESTRATE), ORCHESTRATE_POLICY);
  assert.strictEqual(getModePolicy(MODE.AUTO), AUTO_POLICY);
});

test("mode-policy: unknown mode throws", () => {
  assert.throws(() => getModePolicy("invalid"), /unknown mode/);
});

test("mode-policy: PLAN is read-only", () => {
  const p = getModePolicy(MODE.PLAN);
  assert.ok(!p.canWrite);
  assert.ok(!p.canShell);
  assert.ok(!p.canNetwork);
  assert.ok(!p.canSubagent);
  assert.strictEqual(p.maxSubagents, 0);
  assert.strictEqual(p.securityGateRequired, false);
  assert.ok(p.scopes.includes("read"));
  assert.ok(p.scopes.includes("search"));
  assert.strictEqual(p.maxIterations, 4);
  assert.strictEqual(p.maxToolCalls, 8);
});

test("mode-policy: BUILD allows write and test shell", () => {
  const p = getModePolicy(MODE.BUILD);
  assert.ok(p.canWrite);
  assert.ok(p.canShell);
  assert.ok(!p.canNetwork);
  assert.ok(!p.canSubagent);
  assert.strictEqual(p.maxSubagents, 0);
  assert.strictEqual(p.securityGateRequired, false);
  assert.ok(p.scopes.includes("write"));
  assert.ok(p.scopes.includes("test"));
  assert.ok(p.scopes.includes("shell"));
  assert.strictEqual(p.maxIterations, 16);
  assert.strictEqual(p.maxToolCalls, 60);
});

test("mode-policy: ORCHESTRATE allows subagent delegation", () => {
  const p = getModePolicy(MODE.ORCHESTRATE);
  assert.ok(p.canWrite);
  assert.ok(p.canShell);
  assert.ok(p.canSubagent);
  assert.strictEqual(p.maxSubagents, 3);
  assert.strictEqual(p.securityGateRequired, false);
  assert.ok(p.allowedAgentIds.includes("coder"));
  assert.ok(p.allowedAgentIds.includes("tester"));
  assert.ok(p.allowedAgentIds.includes("reviewer"));
  assert.ok(p.allowedAgentIds.includes("planner"));
});

test("mode-policy: AUTO requires security gate", () => {
  const p = getModePolicy(MODE.AUTO);
  assert.ok(p.canWrite);
  assert.ok(p.canShell);
  assert.ok(!p.canNetwork);
  assert.ok(p.canSubagent); // AUTO can delegate subagents (maxSubagents: 2)
  assert.strictEqual(p.maxSubagents, 2);
  assert.strictEqual(p.securityGateRequired, true);
  assert.strictEqual(p.maxIterations, 24);
  assert.strictEqual(p.maxToolCalls, 100);
});

test("mode-policy: privilege levels are ordered", () => {
  assert.strictEqual(MODE_PRIVILEGE[MODE.PLAN], 1);
  assert.strictEqual(MODE_PRIVILEGE[MODE.BUILD], 2);
  assert.strictEqual(MODE_PRIVILEGE[MODE.ORCHESTRATE], 2);
  assert.strictEqual(MODE_PRIVILEGE[MODE.AUTO], 3);
});

test("mode-policy: isEscalation detects privilege escalation", () => {
  const plan = getModePolicy(MODE.PLAN);
  const build = getModePolicy(MODE.BUILD);
  const auto = getModePolicy(MODE.AUTO);

  assert.ok(!plan.isEscalation(MODE.PLAN));
  assert.ok(build.isEscalation(MODE.PLAN));
  assert.ok(auto.isEscalation(MODE.PLAN));
  assert.ok(auto.isEscalation(MODE.BUILD));
  assert.ok(!plan.isEscalation(MODE.BUILD)); // downgrade
  assert.ok(!build.isEscalation(MODE.AUTO)); // downgrade
});

test("mode-policy: isBlockedBySecurityGate", () => {
  const auto = getModePolicy(MODE.AUTO);
  const plan = getModePolicy(MODE.PLAN);

  assert.ok(auto.isBlockedBySecurityGate(false));
  assert.ok(!auto.isBlockedBySecurityGate(true));
  assert.ok(!plan.isBlockedBySecurityGate(false));
  assert.ok(!plan.isBlockedBySecurityGate(true));
});

test("mode-policy: policy toJSON includes all fields", () => {
  const p = getModePolicy(MODE.PLAN);
  const json = p.toJSON();
  assert.strictEqual(json.mode, MODE.PLAN);
  assert.ok(Array.isArray(json.scopes));
  assert.ok(Array.isArray(json.allow));
  assert.ok(Array.isArray(json.ask));
  assert.ok(Array.isArray(json.deny));
  assert.ok(Array.isArray(json.requireApproval));
  assert.ok(Array.isArray(json.allowedAgentIds));
  assert.strictEqual(typeof json.maxSubagents, "number");
  assert.strictEqual(typeof json.securityGateRequired, "boolean");
  assert.ok(Array.isArray(json.modelRequirements));
  assert.strictEqual(typeof json.maxIterations, "number");
  assert.strictEqual(typeof json.maxToolCalls, "number");
  assert.strictEqual(typeof json.timeoutMs, "number");
  assert.strictEqual(typeof json.maxContextChars, "number");
  assert.strictEqual(typeof json.canWrite, "boolean");
  assert.strictEqual(typeof json.canShell, "boolean");
  assert.strictEqual(typeof json.canNetwork, "boolean");
  assert.strictEqual(typeof json.canSubagent, "boolean");
});
