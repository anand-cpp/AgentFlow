// ModeOrchestrator tests — validates multi-agent orchestration.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModeRegistry, ModeRuntime, ModeOrchestrator } from "../../../src/core/modes/index.js";
import { MODE } from "../../../src/core/modes/index.js";
import { SubtaskResult, OrchestrationResult } from "../../../src/core/modes/index.js";

function makeComplete(planText) {
  let callCount = 0;
  return async (_config, _modelId, _prompt, _opts) => {
    callCount += 1;
    if (callCount === 1) {
      // First call: return decomposition plan (matching planner output contract)
      return {
        text: JSON.stringify({
          summary: "Plan to implement the feature",
          steps: [
            { id: "subtask-1", title: "Inspect code", description: "Read and understand" },
            { id: "subtask-2", title: "Implement fix", description: "Write the code" },
          ],
          risks: [],
        }),
      };
    }
    // Subsequent calls: return implementation output
    return { text: "Implemented successfully" };
  };
}

test("mode-orchestrator: requires subagent-capable mode", async () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "plan" }); // Plan mode doesn't allow subagents

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    catalogue: ["openai/gpt-4o"],
    hints: {
      "openai/gpt-4o": { capabilities: ["reasoning", "planning"] },
    },
    approver: async () => true,
  });

  const orch = new ModeOrchestrator({ modeRuntime: runtime });
  const result = await orch.orchestrate({ task: "do something" });

  assert.strictEqual(result.state, "failed");
  assert.ok(result.error);
});

test("mode-orchestrator: orchestrates subtasks in build mode", async () => {
  // Build a mock mode runtime that returns canned results
  const mockRuntime = {
    mode: "build",
    policy: { canSubagent: true, allowedAgentIds: ["coder", "tester", "planner"] },
    async run(opts) {
      if (opts.extra?._phase === "decomposition") {
        return {
          state: "completed",
          output: {
            summary: "Decomposed into subtasks",
            steps: [
              { id: "subtask-1", title: "Inspect code", description: "Read and understand" },
              { id: "subtask-2", title: "Implement fix", description: "Write the code" },
            ],
            risks: [],
          },
        };
      }
      return {
        state: "completed",
        output: { summary: "Subtask completed", files: [], testsRun: [], openQuestions: [] },
      };
    },
  };

  const orch = new ModeOrchestrator({ modeRuntime: mockRuntime, maxSubagents: 2 });
  const result = await orch.orchestrate({ task: "implement a feature" });

  assert.ok(result);
  assert.strictEqual(result.mode, "build");
  assert.ok(result.subtasks.length > 0, `Expected subtasks, got ${result.subtasks.length}`);
  assert.ok(result.totalToolCalls >= 0);
  assert.ok(result.state === "completed" || result.state === "failed");
});

test("mode-orchestrator: orchestrator result toJSON", () => {
  const sr = new SubtaskResult({
    subtaskId: "st-1",
    agentId: "coder",
    task: "write code",
    state: "completed",
    output: { summary: "done" },
    toolCalls: 3,
    iterations: 2,
    durationMs: 100,
  });
  assert.strictEqual(sr.succeeded, true);
  const srJson = sr.toJSON();
  assert.strictEqual(srJson.subtaskId, "st-1");
  assert.strictEqual(srJson.agentId, "coder");
  assert.strictEqual(srJson.state, "completed");

  const failedSr = new SubtaskResult({
    subtaskId: "st-2",
    agentId: "coder",
    task: "fail",
    state: "failed",
    error: new Error("boom"),
  });
  assert.strictEqual(failedSr.succeeded, false);

  const or = new OrchestrationResult({
    task: "main task",
    mode: "orchestrate",
    subtasks: [sr, failedSr],
    state: "failed",
    totalToolCalls: 3,
    durationMs: 100,
  });
  assert.strictEqual(or.succeeded, false);
  assert.strictEqual(or.failedSubtasks.length, 1);
  const orJson = or.toJSON();
  assert.strictEqual(orJson.task, "main task");
  assert.strictEqual(orJson.mode, "orchestrate");
  assert.strictEqual(orJson.state, "failed");
  assert.strictEqual(orJson.failedSubtaskCount, 1);
});

test("mode-orchestrator: selectWorkerAgent picks tester for test-related tasks", () => {
  const modeReg = new ModeRegistry();
  modeReg.initialize({ mode: "orchestrate" });

  const runtime = new ModeRuntime({
    modeRegistry: modeReg,
    complete: makeComplete("output"),
    approver: async () => true,
  });

  const orch = new ModeOrchestrator({ modeRuntime: runtime });

  // Access private method through the object for testing
  const selectWorkerAgent = orch._selectWorkerAgent.bind(orch);
  const policy = runtime.policy;

  assert.strictEqual(selectWorkerAgent("run the tests", policy), "tester");
  assert.strictEqual(selectWorkerAgent({ title: "verify fix", description: "check assertions" }, policy), "tester");
  assert.strictEqual(selectWorkerAgent("fix the bug", policy), "debugger");
  assert.strictEqual(selectWorkerAgent("review the code", policy), "reviewer");
  assert.strictEqual(selectWorkerAgent("plan the work", policy), "planner");
  assert.strictEqual(selectWorkerAgent("implement feature", policy), "coder");
});
