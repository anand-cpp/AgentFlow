// Coordinator edge case tests — failure paths and boundary conditions.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { TASK_STATUS } from "../../../src/core/hackathon/session.js";

describe("Coordinator edge cases", () => {
  it("rejects dispatch to unknown task", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.dispatchTask({ taskId: "nonexistent", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects dispatch to unknown worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
    });
    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "unknown-worker" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects accept with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects taskStarted with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects complete with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.completeTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects fail with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.failTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects cancel with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects renewLease with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.renewLease({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects cancel of already completed task", async () => {
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
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [],
      testResults: [],
    });

    const result = await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects dispatch when no workers registered", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
    });

    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("worker can complete then task cannot be dispatched again", async () => {
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
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [],
      testResults: [],
    });

    // Task is COMPLETED — cannot dispatch again.
    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("getTasks returns empty before any tasks", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    assert.deepStrictEqual(coord.getTasks(), []);
  });

  it("getWorkers returns empty before any workers", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    assert.deepStrictEqual(coord.getWorkers(), []);
  });

  it("shutdown stops all heartbeat timers", async () => {
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
    assert.strictEqual(coord._heartbeatTimers.size, 1);
    await coord.shutdown();
    assert.strictEqual(coord._heartbeatTimers.size, 0);
  });

  it("TASK_STATUS values are all strings", () => {
    for (const [_key, value] of Object.entries(TASK_STATUS)) {
      assert.strictEqual(typeof value, "string");
      assert.ok(value.length > 0);
    }
  });
});
