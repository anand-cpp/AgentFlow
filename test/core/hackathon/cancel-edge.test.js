// Task cancellation edge case tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";

describe("Task cancellation edge cases", () => {
  it("cancel unknown task returns error", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.cancelTask({ taskId: "nonexistent" });
    assert.strictEqual(result.ok, false);
  });

  it("cancel pending task transitions to CANCELLED then PENDING", async () => {
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

    // Cancel a pending task (not yet dispatched).
    const result = await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.state, "cancelled");

    // After cancel, state is CANCELLED (lifecycle allows CANCELLED->PENDING).
    const task = coord.taskGraph.get("task-1");
    assert.strictEqual(task.state, "cancelled");
  });

  it("cancel running task releases its lease", async () => {
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
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    assert.ok(coord.scheduler.getLease("task-1"));

    const result = await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(coord.scheduler.getLease("task-1"), null);
  });

  it("cancel worker's current task clears worker's currentTaskId", async () => {
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

    const record = coord.workers.get("worker-1");
    assert.strictEqual(record.currentTaskId, "task-1");

    await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(record.currentTaskId, null);
  });

  it("cancel task with no active session returns error", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, false);
  });

  it("cancel from PENDING state transitions to CANCELLED", async () => {
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

    const result = await coord.cancelTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(coord.taskGraph.get("task-1").state, "cancelled");
    // After cancel, state is CANCELLED (lifecycle allows CANCELLED->PENDING
    // via coordinator-led reassignment).
    assert.strictEqual(coord.taskGraph.get("task-1").state, "cancelled");
  });
});
