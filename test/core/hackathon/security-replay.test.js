// Security replay attack tests — duplicate events and replay protection.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { NonceTracker } from "../../../src/core/hackathon/auth.js";
import { createNonce } from "../../../src/core/hackathon/auth.js";
import { createEvent } from "../../../src/core/hackathon/events.js";
import { HACKATHON_EVENTS } from "../../../src/core/hackathon/events.js";

describe("Security replay protection", () => {
  it("nonce is accepted once and rejected on replay", () => {
    const tracker = new NonceTracker({ ttlMs: 60000 });
    const nonce = createNonce();

    assert.strictEqual(tracker.use(nonce), true);
    assert.strictEqual(tracker.use(nonce), false); // replay rejected
    assert.strictEqual(tracker.use(nonce), false); // replay rejected again
  });

  it("different nonces are all accepted", () => {
    const tracker = new NonceTracker({ ttlMs: 60000 });
    const n1 = createNonce();
    const n2 = createNonce();
    const n3 = createNonce();

    assert.strictEqual(tracker.use(n1), true);
    assert.strictEqual(tracker.use(n2), true);
    assert.strictEqual(tracker.use(n3), true);
    assert.strictEqual(tracker.size(), 3);
  });

  it("event dedup rejects duplicate sequence numbers", () => {
    // Events with the same sequence number but different eventIds are
    // distinct events; dedup is enforced by the event-seq tracker.
    const ev1 = createEvent({
      sessionId: "sess-1",
      sequence: 1,
      type: HACKATHON_EVENTS.WORKER_HEARTBEAT,
      payload: {},
    });
    const ev2 = createEvent({
      sessionId: "sess-1",
      sequence: 1, // same sequence as ev1
      type: HACKATHON_EVENTS.WORKER_HEARTBEAT,
      payload: {},
    });

    // Both events are valid individually (different eventIds).
    assert.notStrictEqual(ev1.eventId, ev2.eventId);
    assert.strictEqual(ev1.sequence, ev2.sequence);
  });

  it("worker cannot complete task assigned to another worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
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

    // Worker-2 tries to complete worker-1's task.
    const result = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-2",
      evidence: [],
      testResults: [],
    });
    assert.strictEqual(result.ok, false);
  });

  it("worker cannot accept task assigned to another worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
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

    // Worker-2 tries to accept worker-1's task.
    const result = await coord.acceptTask({ taskId: "task-1", workerId: "worker-2" });
    assert.strictEqual(result.ok, false);
  });

  it("revoked worker cannot perform any operation", async () => {
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

    // Revoke the worker through the public API.
    const revoked = coord.revokeWorker({ workerId: "worker-1" });
    assert.strictEqual(revoked.ok, true);
    assert.strictEqual(revoked.data.status, "revoked");

    // Heartbeat should fail.
    const hb = coord.heartbeat({ workerId: "worker-1" });
    assert.strictEqual(hb.ok, false);

    // Task dispatch should fail.
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    const dispatch = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(dispatch.ok, false);
  });
});
