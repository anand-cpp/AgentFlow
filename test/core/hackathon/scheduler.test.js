// Scheduler tests — validates worker matching, leases, and reassignment.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Scheduler } from "../../../src/core/hackathon/scheduler.js";

describe("Scheduler", () => {
  it("matches workers by capability", () => {
    const s = new Scheduler();
    s.registerWorker("w1", { capabilities: ["node", "typescript"] });
    s.registerWorker("w2", { capabilities: ["python"] });

    const task = { requiredCapabilities: ["node"] };
    const eligible = s.eligibleWorkers(task);
    assert.ok(eligible.includes("w1"));
    assert.ok(!eligible.includes("w2"));
  });

  it("excludes unavailable workers", () => {
    const s = new Scheduler();
    s.registerWorker("w1", { capabilities: ["node"], available: false });
    const task = { requiredCapabilities: ["node"] };
    assert.deepStrictEqual(s.eligibleWorkers(task), []);
  });

  it("creates and retrieves a lease", () => {
    const s = new Scheduler();
    const lease = s.createLease({ taskId: "t1", workerId: "w1" });
    assert.ok(lease.leaseId);
    assert.strictEqual(lease.status, "active");

    const got = s.getLease("t1");
    assert.ok(got);
    assert.strictEqual(got.leaseId, lease.leaseId);
  });

  it("expires a lease past its TTL", () => {
    const s = new Scheduler();
    s.createLease({ taskId: "t1", workerId: "w1", ttlMs: 1 });
    const got = s.getLease("t1");
    assert.ok(got); // not yet expired

    // Wait past TTL
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }
    const expired = s.getLease("t1");
    assert.strictEqual(expired, null);
  });

  it("renews a lease", () => {
    const s = new Scheduler();
    const lease = s.createLease({ taskId: "t1", workerId: "w1", ttlMs: 50 });
    const before = lease.expiresAt;
    s.renewLease(lease.leaseId, { ttlMs: 60000 });
    const after = s.getLease("t1").expiresAt;
    assert.notStrictEqual(after, before);
    assert.ok(Date.parse(after) > Date.parse(before));
  });

  it("revokes all leases for a worker", () => {
    const s = new Scheduler();
    s.createLease({ taskId: "t1", workerId: "w1" });
    s.createLease({ taskId: "t2", workerId: "w1" });
    s.createLease({ taskId: "t3", workerId: "w2" });

    const revoked = s.revokeWorkerLeases("w1");
    assert.strictEqual(revoked.length, 2);
    assert.strictEqual(s.getLease("t1"), null);
    assert.strictEqual(s.getLease("t2"), null);
    assert.ok(s.getLease("t3")); // w2's lease intact
  });

  it("completes a lease", () => {
    const s = new Scheduler();
    const lease = s.createLease({ taskId: "t1", workerId: "w1" });
    s.completeLease(lease.leaseId);
    assert.strictEqual(s.getLease("t1"), null);
    assert.strictEqual(s.leases.get(lease.leaseId).status, "completed");
  });

  it("tracks active lease count per worker", () => {
    const s = new Scheduler();
    s.createLease({ taskId: "t1", workerId: "w1" });
    s.createLease({ taskId: "t2", workerId: "w1" });
    assert.strictEqual(s.activeLeaseCount("w1"), 2);
    assert.strictEqual(s.activeLeaseCount("w2"), 0);
  });

  it("canPerform returns false for unknown worker", () => {
    const s = new Scheduler();
    const task = { requiredCapabilities: ["node"] };
    assert.strictEqual(s.canPerform("unknown", task), false);
  });
});
