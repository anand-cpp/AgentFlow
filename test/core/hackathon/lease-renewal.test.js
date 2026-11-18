// Lease renewal and edge case tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { Scheduler } from "../../../src/core/hackathon/scheduler.js";

describe("Lease renewal", () => {
  it("renews a lease and extends expiration", async () => {
    const coord = new CoordinatorRuntime({ leaseTtlMs: 1000 });
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

    const lease1 = coord.scheduler.getLease("task-1");
    assert.ok(lease1);
    const originalExpiry = lease1.expiresAt;

    // Force at least 1ms between creation and renewal so timestamps differ.
    await new Promise((resolve) => setTimeout(resolve, 1));

    // Renew the lease.
    const renewed = await coord.renewLease({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(renewed.ok, true);

    const lease2 = coord.scheduler.getLease("task-1");
    assert.ok(lease2);
    assert.notStrictEqual(lease2.expiresAt, originalExpiry);
    assert.ok(Date.parse(lease2.expiresAt) > Date.parse(originalExpiry));
  });

  it("rejects lease renewal by wrong worker", async () => {
    const coord = new CoordinatorRuntime({ leaseTtlMs: 1000 });
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
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.renewLease({ taskId: "task-1", workerId: "worker-2" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects renewal of expired lease", async () => {
    const coord = new CoordinatorRuntime({ leaseTtlMs: 10 });
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

    // Wait for lease to expire.
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }

    const lease = coord.scheduler.getLease("task-1");
    assert.strictEqual(lease, null); // expired

    const result = await coord.renewLease({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("scheduler rejects renewal of unknown lease", () => {
    const sched = new Scheduler();
    assert.throws(() => sched.renewLease("unknown-lease"), /unknown lease/);
  });

  it("scheduler rejects renewal of non-active lease", () => {
    const sched = new Scheduler();
    const lease = sched.createLease({ taskId: "t1", workerId: "w1" });
    sched.completeLease(lease.leaseId);
    assert.throws(() => sched.renewLease(lease.leaseId), /not active/);
  });

  it("scheduler revokeWorkerLeases revokes all worker leases", () => {
    const sched = new Scheduler();
    sched.createLease({ taskId: "t1", workerId: "w1" });
    sched.createLease({ taskId: "t2", workerId: "w1" });
    sched.createLease({ taskId: "t3", workerId: "w2" });

    const revoked = sched.revokeWorkerLeases("w1");
    assert.strictEqual(revoked.length, 2);
    assert.strictEqual(sched.getLease("t1"), null);
    assert.strictEqual(sched.getLease("t2"), null);
    assert.ok(sched.getLease("t3")); // w2's lease intact
  });

  it("scheduler expiredLeases returns and expires leases", () => {
    const sched = new Scheduler();
    sched.createLease({ taskId: "t1", workerId: "w1", ttlMs: 10 });

    // No expired leases yet.
    assert.deepStrictEqual(sched.expiredLeases(), []);

    // Wait for expiry.
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }

    const expired = sched.expiredLeases();
    assert.strictEqual(expired.length, 1);
    assert.strictEqual(expired[0].taskId, "t1");
    assert.strictEqual(sched.getLease("t1"), null);
  });
});
