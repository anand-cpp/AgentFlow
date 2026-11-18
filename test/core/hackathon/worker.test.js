// Hackathon worker runtime tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkerRuntime } from "../../../src/core/hackathon/worker.js";
import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";

describe("WorkerRuntime", () => {
  it("creates a worker with default state", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    assert.strictEqual(worker.workerId, "worker-1");
    assert.strictEqual(worker.sessionId, "sess-1");
    assert.strictEqual(worker.registered, false);
    assert.strictEqual(worker.connected, false);
    assert.strictEqual(worker.getCurrentTask(), null);
    assert.deepStrictEqual(worker.getTasks(), []);
  });

  it("registers through a coordinator", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: coord.session.id,
      coordinator: coord,
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    const result = await worker.register({ invitationToken: invite.data.token });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(worker.registered, true);
    assert.strictEqual(worker.connected, true);
  });

  it("rejects registration without token", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    const result = await worker.register({});
    assert.strictEqual(result.ok, false);
  });

  it("receives and accepts a task", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: coord.session.id,
      coordinator: coord,
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await worker.register({ invitationToken: invite.data.token });

    const receive = await worker.receiveTask({
      task: {
        taskId: "task-1",
        title: "Add endpoint",
        objective: "Create a health check endpoint",
        assignedWorkerId: "worker-1",
        requiredCapabilities: ["node"],
        dependencies: [],
        requiredTests: [],
        filesOwned: [],
      },
      leaseId: "lease-1",
      expiresAt: "2026-12-01T00:00:00Z",
    });
    assert.strictEqual(receive.ok, true);

    const task = worker.getTasks().find((t) => t.taskId === "task-1");
    assert.ok(task);
    assert.strictEqual(task.taskId, "task-1");
    assert.strictEqual(task.state, "assigned");

    const accept = await worker.acceptTask({ taskId: "task-1" });
    assert.strictEqual(accept.ok, true);
    assert.strictEqual(worker.getCurrentTask().state, "accepted");
  });

  it("rejects accepting a task not assigned to this worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: coord.session.id,
      coordinator: coord,
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await worker.register({ invitationToken: invite.data.token });

    const result = await worker.receiveTask({
      task: {
        taskId: "task-1",
        title: "A",
        objective: "a",
        assignedWorkerId: "worker-2", // not this worker
        requiredCapabilities: [],
        dependencies: [],
        requiredTests: [],
        filesOwned: [],
      },
      leaseId: "lease-1",
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects starting a task not in accepted state", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    const result = await worker.startTask({ taskId: "task-1" });
    assert.strictEqual(result.ok, false);
  });

  it("reports progress on a task", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: coord.session.id,
      coordinator: coord,
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await worker.register({ invitationToken: invite.data.token });

    await worker.receiveTask({
      task: {
        taskId: "task-1",
        title: "A",
        objective: "a",
        assignedWorkerId: "worker-1",
        requiredCapabilities: [],
        dependencies: [],
        requiredTests: [],
        filesOwned: [],
      },
      leaseId: "lease-1",
    });
    await worker.acceptTask({ taskId: "task-1" });
    await worker.startTask({ taskId: "task-1" });

    const result = await worker.reportProgress({ taskId: "task-1", progress: 50 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.progress, 50);
    assert.strictEqual(worker.getCurrentTask().progress, 50);
  });

  it("rejects progress with invalid value", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    const result = await worker.reportProgress({ taskId: "task-1", progress: 150 });
    assert.strictEqual(result.ok, false);
  });

  it("reports a task blocked", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    await worker.receiveTask({
      task: {
        taskId: "task-1",
        title: "A",
        objective: "a",
        assignedWorkerId: "worker-1",
        requiredCapabilities: [],
        dependencies: [],
        requiredTests: [],
        filesOwned: [],
      },
      leaseId: "lease-1",
    });
    await worker.acceptTask({ taskId: "task-1" });
    const result = await worker.reportBlocked({
      taskId: "task-1",
      reason: "waiting on dependency",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.state, "blocked");
  });

  it("disconnects and stops heartbeat", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    worker._connected = true;
    const result = await worker.disconnect();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(worker.connected, false);
  });

  it("reconnects and resumes heartbeat", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: coord.session.id,
      coordinator: coord,
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    await worker.register({ invitationToken: invite.data.token });

    await worker.disconnect();
    assert.strictEqual(worker.connected, false);

    const result = await worker.reconnect();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(worker.connected, true);
  });
});
