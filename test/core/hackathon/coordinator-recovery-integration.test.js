// Coordinator recovery integration tests — full save/recover cycle.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { recoverCoordinator, validateRecovery } from "../../../src/core/hackathon/coordinator-recovery.js";
import { TaskGraph } from "../../../src/core/hackathon/task-graph.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-recovery-integration-"));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

function makeSession() {
  return {
    id: "sess-1",
    leaderId: "leader-1",
    projectIdea: "x",
    projectRoot: "/tmp",
    status: "active",
    workers: {},
    tasks: {},
  };
}

describe("Coordinator recovery integration", () => {
  it("full save and recovery cycle", async () => {
    // Phase 1: Create a session with workers and tasks.
    const coord1 = new CoordinatorRuntime({ stateDir: dir });
    await coord1.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const invite = coord1.createInvitation({ workerId: "worker-1" });
    await coord1.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    coord1.taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord1.dispatchTask({ taskId: "task-1", workerId: "worker-1" });

    const sessionId = coord1.session.id;

    // Phase 2: Simulate leader restart - recover from disk.
    const result = await recoverCoordinator({
      stateDir: dir,
      sessionId,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.id, sessionId);
    assert.strictEqual(result.session.status, "active");
    assert.strictEqual(result.report.workerCount, 1);
    assert.strictEqual(result.report.taskCount, 1);

    // Worker should be disconnected after restart.
    const worker = result.workers.get("worker-1");
    assert.strictEqual(worker.status, "disconnected");

    // Task should still be assigned.
    const task = result.taskGraph.get("task-1");
    assert.strictEqual(task.state, "assigned");
    assert.strictEqual(task.assignedWorkerId, "worker-1");
  });

  it("recovery validates task graph consistency", () => {
    const taskGraph = new TaskGraph();
    taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      dependencies: [],
    });
    taskGraph.upsert({
      taskId: "task-2",
      title: "Task 2",
      objective: "Do task 2",
      dependencies: ["task-1"],
    });

    const result = validateRecovery({ taskGraph, session: makeSession() });
    assert.strictEqual(result.valid, true);
  });

  it("recovery detects dependency cycles", () => {
    const taskGraph = new TaskGraph();
    taskGraph.upsert({
      taskId: "a", title: "A", objective: "a", dependencies: ["b"],
    });
    taskGraph.upsert({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
    });

    const result = validateRecovery({ taskGraph, session: makeSession() });
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some((i) => i.type === "dependency_cycle"));
  });
});
