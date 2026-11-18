// Hackathon coordinator tests — validates session, worker registration,
// task dispatch, lifecycle transitions, heartbeats, and leases.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { LocalBus } from "../../../src/core/hackathon/transport.js";

describe("CoordinatorRuntime", () => {
  it("starts a session", async () => {
    const coord = new CoordinatorRuntime();
    const result = await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.data.sessionId);
    assert.strictEqual(result.data.leaderId, "leader-1");
    assert.strictEqual(coord.getSessionState().status, "active");
  });

  it("rejects starting a second session while running", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.startSession({
      leaderId: "leader-2",
      projectIdea: "y",
      projectRoot: "/tmp2",
    });
    assert.strictEqual(result.ok, false);
  });

  it("creates an invitation for a worker", () => {
    const coord = new CoordinatorRuntime();
    // Manually set a session (bypass startSession for focused test)
    coord.session = {
      id: "sess-1",
      leaderId: "leader-1",
      status: "active",
    };
    const result = coord.createInvitation({ workerId: "worker-1" });
    assert.strictEqual(result.ok, true);
    assert.ok(result.data.token);
    assert.strictEqual(result.data.workerId, "worker-1");
  });

  it("registers an authenticated worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    const result = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node", "typescript"],
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.workerId, "worker-1");
    assert.strictEqual(result.data.status, "connected");
  });

  it("rejects registration with invalid token", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.registerWorker({
      workerId: "worker-1",
      token: "bad-token",
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects registration for uninvited worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.registerWorker({
      workerId: "unknown-worker",
      token: "some-token",
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, false);
  });

  it("records worker heartbeat", async () => {
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
    const result = coord.heartbeat({ workerId: "worker-1" });
    assert.strictEqual(result.ok, true);
    assert.ok(result.data.lastHeartbeat);
  });

  it("rejects heartbeat for unknown worker", () => {
    const coord = new CoordinatorRuntime();
    const result = coord.heartbeat({ workerId: "unknown" });
    assert.strictEqual(result.ok, false);
  });

  it("dispatches a task to a worker", async () => {
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

    // Add a task to the graph.
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "Add endpoint",
      objective: "Create a health check endpoint",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, true);
    assert.ok(result.data.leaseId);
    assert.strictEqual(result.data.state, "assigned");
  });

  it("rejects dispatch when dependency not complete", async () => {
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
      dependencies: ["task-0"], // not complete
      requiredTests: [],
    });

    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(String(result.error).includes("dependency"));
  });

  it("rejects dispatch when worker lacks capability", async () => {
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
      capabilities: ["python"], // no node
    });

    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
    assert.ok(String(result.error).includes("capabilities"));
  });

  it("worker accepts and starts a task", async () => {
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

    const accept = await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(accept.ok, true);
    assert.strictEqual(accept.data.state, "accepted");

    const start = await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(start.ok, true);
    assert.strictEqual(start.data.state, "running");
  });

  it("rejects task acceptance by wrong worker", async () => {
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

    const result = await coord.acceptTask({ taskId: "task-1", workerId: "worker-2" });
    assert.strictEqual(result.ok, false);
  });

  it("worker completes a task with required test evidence", async () => {
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
      requiredTests: ["unit-test"],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [{ kind: "commit", value: "abc123" }],
      testResults: ["unit-test"],
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.state, "completed");
    assert.strictEqual(result.data.verified, false); // pending supervisor verification
  });

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
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: ["unit-test"],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [],
      testResults: [], // missing required test
    });
    assert.strictEqual(result.ok, false);
    assert.ok(String(result.error).includes("missing required test evidence"));
  });

  it("worker fails a task and releases the lease", async () => {
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

    const result = await coord.failTask({
      taskId: "task-1",
      workerId: "worker-1",
      error: "compilation failed",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.state, "failed");
    // Lease released — task can be reassigned.
    assert.strictEqual(coord.scheduler.getLease("task-1"), null);
  });

  it("worker disconnects and reconnects", async () => {
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

    const disc = coord.workerDisconnected({ workerId: "worker-1" });
    assert.strictEqual(disc.ok, true);
    assert.strictEqual(disc.data.status, "disconnected");

    const recon = await coord.workerReconnected({
      workerId: "worker-1",
      capabilities: ["node"],
    });
    assert.strictEqual(recon.ok, true);
    assert.strictEqual(recon.data.status, "connected");
  });

  it("revokes a worker and its leases", async () => {
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

    const result = coord.revokeWorker({ workerId: "worker-1" });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.status, "revoked");
    assert.strictEqual(coord.scheduler.getLease("task-1"), null);
  });

  it("checks expired leases", () => {
    const coord = new CoordinatorRuntime({ leaseTtlMs: 1 });
    coord.session = {
      id: "sess-1",
      leaderId: "leader-1",
      status: "active",
      tasks: {},
      workers: {},
    };
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      requiredCapabilities: [],
      dependencies: [],
      requiredTests: [],
      state: "assigned",
      assignedWorkerId: "worker-1",
    });
    coord.scheduler.createLease({ taskId: "task-1", workerId: "worker-1", ttlMs: 1 });

    // Wait past TTL.
    const start = Date.now();
    while (Date.now() - start < 15) { /* spin */ }

    const expired = coord.checkExpiredLeases();
    assert.strictEqual(expired.length, 1);
    assert.strictEqual(expired[0].taskId, "task-1");
  });

  it("emits events to the LocalBus", async () => {
    const bus = new LocalBus();
    const coord = new CoordinatorRuntime({ bus });
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const received = [];
    bus.subscribe("sess-1", (message) => received.push(message));

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    assert.ok(received.length > 0);
    assert.strictEqual(received[0].type, "hackathon.worker_connected");
  });

  it("getSessionState returns summary", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const state = coord.getSessionState();
    assert.strictEqual(state.sessionId, coord.session.id);
    assert.strictEqual(state.leaderId, "leader-1");
    assert.strictEqual(state.workerCount, 0);
    assert.strictEqual(state.taskCount, 0);
  });

  it("shutdown stops heartbeat monitors", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    await coord.shutdown();
    assert.strictEqual(coord._running, false);
  });
});
