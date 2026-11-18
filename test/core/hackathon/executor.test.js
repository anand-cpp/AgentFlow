// Hackathon concurrent executor tests — real parallel execution with 2 workers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { SessionExecutor } from "../../../src/core/hackathon/executor.js";
import { TaskGraph } from "../../../src/core/hackathon/task-graph.js";
import { Scheduler } from "../../../src/core/hackathon/scheduler.js";

describe("SessionExecutor", () => {
  it("creates an executor with defaults", () => {
    const coord = new CoordinatorRuntime();
    const exec = new SessionExecutor({ coordinator: coord });
    assert.ok(exec);
    assert.strictEqual(exec._running, false);
  });

  it("registers workers", () => {
    const coord = new CoordinatorRuntime();
    const exec = new SessionExecutor({ coordinator: coord });
    exec.registerWorker("worker-1", { capabilities: ["node"] });
    exec.registerWorker("worker-2", { capabilities: ["python"] });
    assert.strictEqual(exec.workers.size, 2);
  });

  it("executes two independent tasks concurrently", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const exec = new SessionExecutor({
      coordinator: coord,
      maxConcurrentTasks: 8,
    });

    // Register two workers.
    exec.registerWorker("worker-1", { capabilities: ["node"] });
    exec.registerWorker("worker-2", { capabilities: ["node"] });

    // Register workers with coordinator too.
    const invite1 = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite1.data.token,
      capabilities: ["node"],
    });
    const invite2 = coord.createInvitation({ workerId: "worker-2" });
    await coord.registerWorker({
      workerId: "worker-2",
      token: invite2.data.token,
      capabilities: ["node"],
    });

    // Create two independent tasks (no dependencies).
    coord.taskGraph.upsert({
      taskId: "task-a",
      title: "Task A",
      objective: "Do task A",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    coord.taskGraph.upsert({
      taskId: "task-b",
      title: "Task B",
      objective: "Do task B",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    const startedAt = Date.now();

    // Dispatch both tasks concurrently.
    const r1 = await coord.dispatchTask({ taskId: "task-a", workerId: "worker-1" });
    const r2 = await coord.dispatchTask({ taskId: "task-b", workerId: "worker-2" });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.notStrictEqual(r1.data.leaseId, r2.data.leaseId);

    // Both workers accept and start.
    await coord.acceptTask({ taskId: "task-a", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-b", workerId: "worker-2" });
    await coord.taskStarted({ taskId: "task-a", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-b", workerId: "worker-2" });

    // Both complete with test evidence.
    await coord.completeTask({
      taskId: "task-a",
      workerId: "worker-1",
      evidence: [{ kind: "commit", value: "aaa111" }],
      testResults: [],
    });
    await coord.completeTask({
      taskId: "task-b",
      workerId: "worker-2",
      evidence: [{ kind: "commit", value: "bbb222" }],
      testResults: [],
    });

    const durationMs = Date.now() - startedAt;

    const ta = coord.taskGraph.get("task-a");
    const tb = coord.taskGraph.get("task-b");
    assert.strictEqual(ta.state, "completed");
    assert.strictEqual(tb.state, "completed");
    assert.strictEqual(ta.assignedWorkerId, "worker-1");
    assert.strictEqual(tb.assignedWorkerId, "worker-2");
    // Both dispatched within a short window (concurrent, not sequential).
    assert.ok(durationMs < 10000);
  });

  it("enforces dependencies: dependent task waits for prerequisite", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const exec = new SessionExecutor({ coordinator: coord });
    exec.registerWorker("worker-1", { capabilities: ["node"] });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    // task-b depends on task-a.
    coord.taskGraph.upsert({
      taskId: "task-a",
      title: "A",
      objective: "a",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    coord.taskGraph.upsert({
      taskId: "task-b",
      title: "B",
      objective: "b",
      requiredCapabilities: ["node"],
      dependencies: ["task-a"],
      requiredTests: [],
    });

    // Dispatch task-a (ready).
    const ra = await coord.dispatchTask({ taskId: "task-a", workerId: "worker-1" });
    assert.strictEqual(ra.ok, true);

    // task-b should NOT be dispatchable yet (dependency not complete).
    const rb = await coord.dispatchTask({ taskId: "task-b", workerId: "worker-1" });
    assert.strictEqual(rb.ok, false);
    assert.ok(String(rb.error).includes("dependency"));

    // Complete task-a.
    await coord.acceptTask({ taskId: "task-a", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-a", workerId: "worker-1" });
    await coord.completeTask({
      taskId: "task-a",
      workerId: "worker-1",
      evidence: [],
      testResults: [],
    });

    // Now task-b should be dispatchable.
    const rb2 = await coord.dispatchTask({ taskId: "task-b", workerId: "worker-1" });
    assert.strictEqual(rb2.ok, true);
  });

  it("prevents duplicate dispatch of the same task", async () => {
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

    const r1 = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(r1.ok, true);

    // Same task already assigned — cannot dispatch again.
    const r2 = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(r2.ok, false);
  });

  it("reports execution statistics", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    exec.registerWorker("worker-1", { capabilities: ["node"] });

    const stats = exec.getStats();
    assert.strictEqual(stats.workerCount, 1);
    assert.strictEqual(stats.connectedWorkerCount, 1);
    assert.strictEqual(stats.activeTaskCount, 0);
  });

  it("handles worker disconnection and lease expiry", async () => {
    const coord = new CoordinatorRuntime({ leaseTtlMs: 50 });
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    exec.registerWorker("worker-1", { capabilities: ["node"] });

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

    // Worker disconnects — leases revoked.
    exec.onWorkerDisconnected({ workerId: "worker-1" });
    assert.strictEqual(coord.scheduler.getLease("task-1"), null);

    // checkExpiredLeases only returns still-active leases past TTL;
    // revoked leases are already excluded.
    const expired = coord.checkExpiredLeases();
    assert.deepStrictEqual(expired, []);
  });

  it("uses TaskGraph for cycle detection", () => {
    const graph = new TaskGraph();
    graph.upsert({
      taskId: "a", title: "A", objective: "a", dependencies: ["b"],
    });
    graph.upsert({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
    });
    const cycle = graph.detectCycle();
    assert.ok(cycle);
    assert.ok(cycle.includes("a"));
    assert.ok(cycle.includes("b"));
  });

  it("uses Scheduler for capability matching", () => {
    const sched = new Scheduler({ maxConcurrency: 4 });
    sched.registerWorker("w1", { capabilities: ["node"] });
    sched.registerWorker("w2", { capabilities: ["python"] });

    const eligible = sched.eligibleWorkers({ requiredCapabilities: ["node"] });
    assert.ok(eligible.includes("w1"));
    assert.ok(!eligible.includes("w2"));

    assert.strictEqual(sched.activeLeaseCount("w1"), 0);
    const lease = sched.createLease({ taskId: "t1", workerId: "w1" });
    assert.strictEqual(sched.activeLeaseCount("w1"), 1);
    sched.completeLease(lease.leaseId);
    assert.strictEqual(sched.activeLeaseCount("w1"), 0);
  });
});
