// ModeRuntime tests — validates mode-scoped tool policy enforcement.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModeRegistry, ModeRuntime } from "../../../src/core/modes/index.js";

/** Minimal complete function that returns a canned response. */
function makeComplete(responseText) {
  return async (_config, _modelId, _prompt, _opts) => ({ text: responseText });
}

/** Minimal approver that always approves. */
const alwaysApprove = async () => true;

test("mode-runtime: Plan mode restricts write tool calls", async () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "plan" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("plan output"),
    approver: alwaysApprove,
  });

  assert.strictEqual(runtime.mode, "plan");
  assert.ok(!runtime.policy.canWrite);

  // The policy should deny write scope
  const policy = runtime.policy;
  assert.ok(!policy.scopes.includes("write"));
});

test("mode-runtime: Build mode allows write tool calls", async () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "build" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("build output"),
    approver: alwaysApprove,
  });

  assert.strictEqual(runtime.mode, "build");
  assert.ok(runtime.policy.canWrite);
  assert.ok(runtime.policy.scopes.includes("write"));
});

test("mode-runtime: Auto mode requires security gate", async () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "auto" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("auto output"),
    approver: alwaysApprove,
  });

  assert.strictEqual(runtime.mode, "auto");
  assert.ok(runtime.policy.securityGateRequired);
});

test("mode-runtime: switchMode changes policy", async () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "plan" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    approver: alwaysApprove,
  });

  assert.strictEqual(runtime.mode, "plan");

  await runtime.switchMode("build");
  assert.strictEqual(runtime.mode, "build");
  assert.ok(runtime.policy.canWrite);
});

test("mode-runtime: cycleMode advances modes", async () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "plan" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    approver: alwaysApprove,
  });

  await runtime.cycleMode();
  assert.strictEqual(runtime.mode, "build");

  await runtime.cycleMode();
  assert.strictEqual(runtime.mode, "orchestrate");

  await runtime.cycleMode();
  assert.strictEqual(runtime.mode, "auto");

  await runtime.cycleMode();
  assert.strictEqual(runtime.mode, "plan");
});

test("mode-runtime: isEscalation reports correctly", () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "plan" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    approver: alwaysApprove,
  });

  assert.ok(runtime.isEscalation("build"));
  assert.ok(runtime.isEscalation("auto"));
  assert.ok(!runtime.isEscalation("plan"));
});

test("mode-runtime: agent registry is mode-filtered", () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "plan" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    approver: alwaysApprove,
  });

  const ids = runtime.agentRegistry.ids();
  // Plan mode allows: planner, researcher, reviewer, security
  assert.ok(ids.includes("planner"));
  assert.ok(ids.includes("researcher"));
  assert.ok(ids.includes("reviewer"));
  assert.ok(ids.includes("security"));
  // Plan mode does NOT allow: coder, debugger, tester
  assert.ok(!ids.includes("coder"));
  assert.ok(!ids.includes("debugger"));
  assert.ok(!ids.includes("tester"));
});

test("mode-runtime: build mode agent registry includes coder", () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "build" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    approver: alwaysApprove,
  });

  const ids = runtime.agentRegistry.ids();
  assert.ok(ids.includes("coder"));
  assert.ok(ids.includes("debugger"));
  assert.ok(ids.includes("tester"));
});
