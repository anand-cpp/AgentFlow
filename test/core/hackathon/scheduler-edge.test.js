// Scheduler edge case tests — boundary conditions and failure paths.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Scheduler } from "../../../src/core/hackathon/scheduler.js";

describe("Scheduler edge cases", () => {
  it("scheduler with no workers returns no eligible workers", () => {
    const sched = new Scheduler();
    const eligible = sched.eligibleWorkers({ requiredCapabilities: ["node"] });
    assert.deepStrictEqual(eligible, []);
  });

  it("scheduler with no workers canPerform returns false", () => {
    const sched = new Scheduler();
    assert.strictEqual(sched.canPerform("unknown", { requiredCapabilities: ["node"] }), false);
  });

  it("getLease returns null for task with no lease", () => {
    const sched = new Scheduler();
    assert.strictEqual(sched.getLease("nonexistent"), null);
  });

  it("completeLease returns false for unknown lease", () => {
    const sched = new Scheduler();
    assert.strictEqual(sched.completeLease("unknown-lease"), false);
  });

  it("expireLease returns false for unknown lease", () => {
    const sched = new Scheduler();
    assert.strictEqual(sched.expireLease("unknown-lease"), false);
  });

  it("renewLease throws for unknown lease", () => {
    const sched = new Scheduler();
    assert.throws(() => sched.renewLease("unknown-lease"), /unknown lease/);
  });

  it("renewLease throws for non-active lease", () => {
    const sched = new Scheduler();
    const lease = sched.createLease({ taskId: "t1", workerId: "w1" });
    sched.completeLease(lease.leaseId);
    assert.throws(() => sched.renewLease(lease.leaseId), /not active/);
  });

  it("revokeWorkerLeases returns empty for worker with no leases", () => {
    const sched = new Scheduler();
    const revoked = sched.revokeWorkerLeases("unknown-worker");
    assert.deepStrictEqual(revoked, []);
  });

  it("activeLeaseCount returns 0 for worker with no leases", () => {
    const sched = new Scheduler();
    assert.strictEqual(sched.activeLeaseCount("unknown-worker"), 0);
  });

  it("eligibleWorkers sorted by capability match score", () => {
    const sched = new Scheduler();
    sched.registerWorker("w1", { capabilities: ["node", "typescript", "python"] });
    sched.registerWorker("w2", { capabilities: ["node"] });
    sched.registerWorker("w3", { capabilities: ["python"] });

    const eligible = sched.eligibleWorkers({ requiredCapabilities: ["node", "typescript"] });
    // w1 matches both (score 2), w2 lacks typescript (excluded), w3 lacks both (excluded)
    assert.deepStrictEqual(eligible, ["w1"]);
  });

  it("eligibleWorkers includes partial matches when required is empty", () => {
    const sched = new Scheduler();
    sched.registerWorker("w1", { capabilities: ["node"] });
    sched.registerWorker("w2", { capabilities: ["python"] });

    const eligible = sched.eligibleWorkers({ requiredCapabilities: [] });
    // No required capabilities means all available workers are eligible.
    assert.deepStrictEqual(eligible.sort(), ["w1", "w2"]);
  });

  it("maxConcurrency limits scheduler", () => {
    const sched = new Scheduler({ maxConcurrency: 3 });
    assert.strictEqual(sched.maxConcurrency, 3);
  });
});
