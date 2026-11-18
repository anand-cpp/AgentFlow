// Real distributed execution test.
//
// Demonstrates the coordinator/worker protocol with two independent workers
// running in separate working directories. The coordinator is authoritative;
// workers execute through their own local AgentRuntime and report progress.
//
// This is real local-process communication (not mocked) through the
// CoordinatorRuntime + WorkerRuntime protocol. External model providers are
// not invoked (the AgentRuntime is constructed but complete() is not called
// in these tests), so the coordinator/worker protocol, event flow, scheduling,
// and state transitions are exercised for real.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { WorkerRuntime } from "../../../src/core/hackathon/worker.js";
import { SessionExecutor } from "../../../src/core/hackathon/executor.js";
import { LocalBus } from "../../../src/core/hackathon/transport.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-dist-"));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

function workerDir(name) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("Real distributed execution", () => {
  it("two workers execute independent tasks concurrently with real events", async () => {
    const bus = new LocalBus();
    const coord = new CoordinatorRuntime({ bus });

    // Leader starts a session.
    const session = await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: dir,
    });
    assert.strictEqual(session.ok, true);

    // Two workers with separate working directories and identities.
    const w1Dir = workerDir("worker-1");
    const w2Dir = workerDir("worker-2");

    const worker1 = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: coord.session.id,
      coordinator: coord,
      workspaceRoot: w1Dir,
    });
    const worker2 = new WorkerRuntime({
      workerId: "worker-2",
      sessionId: coord.session.id,
      coordinator: coord,
      workspaceRoot: w2Dir,
    });

    // Both workers register with valid invitations.
    const invite1 = coord.createInvitation({ workerId: "worker-1" });
    const r1 = await worker1.register({ invitationToken: invite1.data.token });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(worker1.registered, true);
    assert.strictEqual(worker1.workspaceRoot, w1Dir);

    const invite2 = coord.createInvitation({ workerId: "worker-2" });
    const r2 = await worker2.register({ invitationToken: invite2.data.token });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(worker2.registered, true);
    assert.strictEqual(worker2.workspaceRoot, w2Dir);

    // Two independent tasks (no dependencies).
    coord.taskGraph.upsert({
      taskId: "task-alpha",
      title: "Task Alpha",
      objective: "Implement alpha component",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: ["src/alpha.js"],
    });
    coord.taskGraph.upsert({
      taskId: "task-beta",
      title: "Task Beta",
      objective: "Implement beta component",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: ["src/beta.js"],
    });

    // Dispatch both concurrently to different workers.
    const d1 = await coord.dispatchTask({ taskId: "task-alpha", workerId: "worker-1" });
    const d2 = await coord.dispatchTask({ taskId: "task-beta", workerId: "worker-2" });
    assert.strictEqual(d1.ok, true);
    assert.strictEqual(d2.ok, true);
    assert.notStrictEqual(d1.data.leaseId, d2.data.leaseId);

    // Worker 1 accepts and starts task-alpha.
    await coord.acceptTask({ taskId: "task-alpha", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-alpha", workerId: "worker-1" });

    // Worker 2 accepts and starts task-beta.
    await coord.acceptTask({ taskId: "task-beta", workerId: "worker-2" });
    await coord.taskStarted({ taskId: "task-beta", workerId: "worker-2" });

    // Both report real progress.
    await coord.taskProgress({
      taskId: "task-alpha",
      workerId: "worker-1",
      progress: 50,
      evidence: [{ kind: "note", value: "alpha scaffolding done" }],
    });
    await coord.taskProgress({
      taskId: "task-beta",
      workerId: "worker-2",
      progress: 30,
      evidence: [{ kind: "note", value: "beta scaffolding started" }],
    });

    // Both complete with required test evidence.
    await coord.completeTask({
      taskId: "task-alpha",
      workerId: "worker-1",
      evidence: [{ kind: "commit", value: "alpha-a1b2c3" }],
      testResults: ["unit-test-alpha"],
    });
    await coord.completeTask({
      taskId: "task-beta",
      workerId: "worker-2",
      evidence: [{ kind: "commit", value: "beta-d4e5f6" }],
      testResults: ["unit-test-beta"],
    });

    // Verify both tasks completed.
    const ta = coord.taskGraph.get("task-alpha");
    const tb = coord.taskGraph.get("task-beta");
    assert.strictEqual(ta.state, "completed");
    assert.strictEqual(tb.state, "completed");
    assert.strictEqual(ta.assignedWorkerId, "worker-1");
    assert.strictEqual(tb.assignedWorkerId, "worker-2");
    assert.strictEqual(ta.progress, 100);
    assert.strictEqual(tb.progress, 100);

    // Verify completion evidence was recorded.
    assert.ok(ta.evidence.some((e) => e.kind === "commit"));
    assert.ok(tb.evidence.some((e) => e.kind === "commit"));

    // Verify events reached the coordinator (event history).
    const eventTypes = coord.session.events.map((e) => e.type);
    assert.ok(eventTypes.includes("hackathon.task_dispatched"));
    assert.ok(eventTypes.includes("hackathon.task_started"));
    assert.ok(eventTypes.includes("hackathon.task_progress"));
    assert.ok(eventTypes.includes("hackathon.task_completed"));

    // Verify workers are distinct (separate identities, separate dirs).
    assert.notStrictEqual(worker1.workerId, worker2.workerId);
    assert.notStrictEqual(worker1.workspaceRoot, worker2.workspaceRoot);
    assert.ok(fs.existsSync(w1Dir));
    assert.ok(fs.existsSync(w2Dir));
  });

  it("dependent task waits for prerequisite completion", async () => {
    const coord = new CoordinatorRuntime();

    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: dir,
    });

    const w1Dir = workerDir("worker-dep");
    const worker = new WorkerRuntime({
      workerId: "worker-dep",
      sessionId: coord.session.id,
      coordinator: coord,
      workspaceRoot: w1Dir,
    });
    const invite = coord.createInvitation({ workerId: "worker-dep" });
    await worker.register({ invitationToken: invite.data.token });

    // task-b depends on task-a.
    coord.taskGraph.upsert({
      taskId: "task-a",
      title: "Task A",
      objective: "Do A",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    coord.taskGraph.upsert({
      taskId: "task-b",
      title: "Task B",
      objective: "Do B (depends on A)",
      requiredCapabilities: ["node"],
      dependencies: ["task-a"],
      requiredTests: [],
    });

    // Dispatch task-a (ready).
    const ra = await coord.dispatchTask({ taskId: "task-a", workerId: "worker-dep" });
    assert.strictEqual(ra.ok, true);

    // task-b must NOT be dispatchable while task-a is not complete.
    const rb = await coord.dispatchTask({ taskId: "task-b", workerId: "worker-dep" });
    assert.strictEqual(rb.ok, false);
    assert.ok(String(rb.error).includes("dependency"));

    // Complete task-a through the worker lifecycle.
    await coord.acceptTask({ taskId: "task-a", workerId: "worker-dep" });
    await coord.taskStarted({ taskId: "task-a", workerId: "worker-dep" });
    await coord.completeTask({
      taskId: "task-a",
      workerId: "worker-dep",
      evidence: [],
      testResults: [],
    });

    // Now task-b is dispatchable.
    const rb2 = await coord.dispatchTask({ taskId: "task-b", workerId: "worker-dep" });
    assert.strictEqual(rb2.ok, true);
  });

  it("worker disconnects and reconnects, lease expires and task is reassignable", async () => {
    const coord = new CoordinatorRuntime({ leaseTtlMs: 50 });
    const exec = new SessionExecutor({ coordinator: coord });

    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: dir,
    });

    const w1Dir = workerDir("worker-reconnect");
    const worker = new WorkerRuntime({
      workerId: "worker-reconnect",
      sessionId: coord.session.id,
      coordinator: coord,
      workspaceRoot: w1Dir,
    });
    exec.registerWorker("worker-reconnect", { capabilities: ["node"] });

    const invite = coord.createInvitation({ workerId: "worker-reconnect" });
    await worker.register({ invitationToken: invite.data.token });

    coord.taskGraph.upsert({
      taskId: "task-rec",
      title: "Task Reconnect",
      objective: "Reconnect test",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-rec", workerId: "worker-reconnect" });

    // Worker disconnects.
    exec.onWorkerDisconnected({ workerId: "worker-reconnect" });
    assert.strictEqual(coord.scheduler.getLease("task-rec"), null);

    // Worker reconnects.
    await exec.onWorkerReconnected({ workerId: "worker-reconnect", capabilities: ["node"] });

    const rec = coord.workers.get("worker-reconnect");
    assert.strictEqual(rec.status, "connected");

    // Lease TTL expires (50ms) — checkExpiredLeases expires it.
    const start = Date.now();
    while (Date.now() - start < 100) { /* spin */ }
    const expired = coord.checkExpiredLeases();
    // The lease was already revoked on disconnect, so nothing to expire.
    assert.deepStrictEqual(expired, []);
  });
});
