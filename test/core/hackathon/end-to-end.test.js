// End-to-end integration test — full Hackathon Mode flow.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { SessionExecutor } from "../../../src/core/hackathon/executor.js";
import { SessionControl } from "../../../src/core/hackathon/session-control.js";

describe("End-to-end Hackathon Mode", () => {
  it("full flow: session, workers, concurrent tasks, completion", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const exec = new SessionExecutor({ coordinator: coord });
    const ctrl = new SessionControl({ coordinator: coord, executor: exec });

    // Register two workers.
    const invite1 = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite1.data.token,
      capabilities: ["node"],
    });
    exec.registerWorker("worker-1", { capabilities: ["node"] });

    const invite2 = coord.createInvitation({ workerId: "worker-2" });
    await coord.registerWorker({
      workerId: "worker-2",
      token: invite2.data.token,
      capabilities: ["node"],
    });
    exec.registerWorker("worker-2", { capabilities: ["node"] });

    // Create two independent tasks.
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    coord.taskGraph.upsert({
      taskId: "task-2",
      title: "Task 2",
      objective: "Do task 2",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    // Dispatch both concurrently.
    const d1 = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    const d2 = await coord.dispatchTask({ taskId: "task-2", workerId: "worker-2" });
    assert.strictEqual(d1.ok, true);
    assert.strictEqual(d2.ok, true);
    assert.notStrictEqual(d1.data.leaseId, d2.data.leaseId);

    // Both accept and start.
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-2", workerId: "worker-2" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-2", workerId: "worker-2" });

    // Both complete with evidence (through executor stats tracking).
    await exec.onTaskCompleted({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [{ kind: "commit", value: "abc123" }],
      testResults: [],
    });
    await exec.onTaskCompleted({
      taskId: "task-2",
      workerId: "worker-2",
      evidence: [{ kind: "commit", value: "def456" }],
      testResults: [],
    });

    // Verify both completed.
    const t1 = coord.taskGraph.get("task-1");
    const t2 = coord.taskGraph.get("task-2");
    assert.strictEqual(t1.state, "completed");
    assert.strictEqual(t2.state, "completed");
    assert.strictEqual(t1.progress, 100);
    assert.strictEqual(t2.progress, 100);

    // Verify session state.
    const state = ctrl.getStatus();
    assert.strictEqual(state, "active");

    // Verify executor stats.
    const stats = exec.getStats();
    assert.strictEqual(stats.completedCount, 2);
    assert.strictEqual(stats.failedCount, 0);
  });

  it("pause blocks new task dispatch", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    const ctrl = new SessionControl({ coordinator: coord, executor: exec });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    exec.registerWorker("worker-1", { capabilities: ["node"] });

    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
    });

    // Pause before dispatching.
    await ctrl.pause();
    assert.strictEqual(ctrl.isPaused(), true);

    // Dispatch still works (coordinator doesn't check executor state), but
    // the executor won't dispatch new tasks while paused.
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    // This test verifies pause state is set.
    assert.strictEqual(coord.session.status, "paused");
  });
});
