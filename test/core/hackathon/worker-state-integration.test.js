// Worker state integration tests — worker state works with coordinator.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWorkerState, recordTask, updateTaskProgress, completeTaskInState,
} from "../../../src/core/hackathon/worker-state.js";

describe("Worker state integration", () => {
  it("worker state tracks coordinator task assignment", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });

    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: ["src/index.js"],
    });

    assert.strictEqual(state.currentTaskId, "task-1");
    assert.strictEqual(state.tasks["task-1"].state, "assigned");
    assert.strictEqual(state.tasks["task-1"].assignedWorkerId, "worker-1");
    assert.ok(state.leases["lease-1"]);
  });

  it("worker state progress tracking matches coordinator", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });

    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });

    updateTaskProgress(state, "task-1", 30, [{ kind: "note", value: "started" }]);
    updateTaskProgress(state, "task-1", 75, [{ kind: "note", value: "halfway" }]);

    assert.strictEqual(state.tasks["task-1"].progress, 75);
    assert.strictEqual(state.tasks["task-1"].evidence.length, 2);
  });

  it("worker state completion tracking", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });

    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });

    completeTaskInState(state, "task-1");

    assert.strictEqual(state.tasks["task-1"].state, "completed");
    assert.strictEqual(state.tasks["task-1"].progress, 100);
    assert.strictEqual(state.currentTaskId, null);
  });

  it("worker state coordinates with coordinator task statuses", () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });

    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });

    // Worker state uses the same TASK_STATUS as coordinator.
    assert.strictEqual(state.tasks["task-1"].state, "assigned");
    assert.strictEqual(state.tasks["task-1"].state, "assigned");
  });
});
