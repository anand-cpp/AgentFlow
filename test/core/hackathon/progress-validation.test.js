// Progress validation tests — evidence required for completion, progress bounds.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";

describe("Progress validation", () => {
  it("rejects completion without required test evidence", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: ["unit-test", "integration-test"],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    // Missing one required test.
    const r1 = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [],
      testResults: ["unit-test"], // missing integration-test
    });
    assert.strictEqual(r1.ok, false);
    assert.ok(String(r1.error).includes("missing required test evidence"));

    // Missing all required tests.
    const r2 = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [],
      testResults: [],
    });
    assert.strictEqual(r2.ok, false);

    // All required tests provided.
    const r3 = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [{ kind: "commit", value: "abc123" }],
      testResults: ["unit-test", "integration-test"],
    });
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.data.state, "completed");
  });

  it("progress is clamped to 0-100", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    // Progress > 100 should be clamped.
    await coord.taskProgress({
      taskId: "task-1",
      workerId: "worker-1",
      progress: 150,
    });
    assert.strictEqual(coord.taskGraph.get("task-1").progress, 100);

    // Progress < 0 should be clamped.
    await coord.taskProgress({
      taskId: "task-1",
      workerId: "worker-1",
      progress: -10,
    });
    assert.strictEqual(coord.taskGraph.get("task-1").progress, 0);
  });

  it("progress reporting requires assigned worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.taskProgress({
      taskId: "task-1",
      workerId: "worker-2", // not the assigned worker
      progress: 50,
    });
    assert.strictEqual(result.ok, false);
  });

  it("completion requires evidence", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    // No evidence at all.
    const result = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [],
      testResults: [],
    });
    // With no requiredTests, empty evidence is allowed (but verification is false).
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.verified, false);
  });
});
