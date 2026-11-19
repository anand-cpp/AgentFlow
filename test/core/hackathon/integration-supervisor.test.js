// Integration Supervisor tests.
//
// Verifies contract management, conflict detection, integration decisions,
// and readiness summary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IntegrationSupervisor,
  CONTRACT_STATUS,
  INTEGRATION_STATUS,
  CONFLICT_SEVERITY,
} from "../../../src/core/hackathon/integration-supervisor.js";

describe("IntegrationSupervisor", () => {
  it("creates and approves contracts", () => {
    const sup = new IntegrationSupervisor();

    const c = sup.createContract({
      name: "API Contract",
      description: "Defines module boundaries and APIs",
      moduleBoundaries: ["src/auth", "src/api"],
    });
    assert.ok(c);
    assert.strictEqual(c.status, CONTRACT_STATUS.DRAFT);
    assert.strictEqual(c.name, "API Contract");

    const approved = sup.approveContract({ contractId: c.contractId, approvedBy: "leader-1" });
    assert.strictEqual(approved.status, CONTRACT_STATUS.APPROVED);
    assert.strictEqual(approved.approvedBy, "leader-1");
  });

  it("lists contracts", () => {
    const sup = new IntegrationSupervisor();

    sup.createContract({ name: "Contract A" });
    sup.createContract({ name: "Contract B" });

    const contracts = sup.listContracts();
    assert.strictEqual(contracts.length, 2);
    assert.ok(contracts.some((c) => c.name === "Contract A"));
    assert.ok(contracts.some((c) => c.name === "Contract B"));
  });

  it("detects duplicate file ownership conflicts", () => {
    const sup = new IntegrationSupervisor();

    // Simulate a coordinator with tasks that own files.
    sup.coordinator = {
      getTasks: () => [
        {
          taskId: "task-1",
          assignedWorkerId: "worker-1",
          filesOwned: ["src/auth.js", "src/api.js"],
        },
      ],
    };

    const conflicts = sup.detectConflicts({
      workerId: "worker-2",
      filesOwned: ["src/auth.js", "src/ui.js"],
    });

    assert.ok(conflicts.length > 0);
    assert.strictEqual(conflicts[0].severity, CONFLICT_SEVERITY.HIGH);
    assert.ok(conflicts[0].description.includes("src/auth.js"));
    assert.ok(conflicts[0].affectedWorkers.includes("worker-1"));
    assert.ok(conflicts[0].affectedWorkers.includes("worker-2"));
  });

  it("detects unapproved interface contracts", () => {
    const sup = new IntegrationSupervisor();

    sup.createContract({
      contractId: "contract-api",
      name: "API Contract",
      status: CONTRACT_STATUS.DRAFT,
    });

    const conflicts = sup.detectConflicts({
      workerId: "worker-1",
      interfaceContracts: ["contract-api"],
    });

    assert.ok(conflicts.length > 0);
    assert.strictEqual(conflicts[0].severity, CONFLICT_SEVERITY.MEDIUM);
    assert.ok(conflicts[0].affectedContracts.includes("contract-api"));
  });

  it("makes integration decisions", () => {
    const sup = new IntegrationSupervisor();

    const d = sup.makeDecision({
      workerId: "worker-1",
      branch: "hackathon/session-1/worker-worker-1",
      status: INTEGRATION_STATUS.PENDING,
      summary: "Worker 1 implementation ready for review",
    });

    assert.ok(d);
    assert.strictEqual(d.status, INTEGRATION_STATUS.PENDING);
    assert.strictEqual(d.workerId, "worker-1");
  });

  it("approves and rejects integrations", () => {
    const sup = new IntegrationSupervisor();

    const d = sup.makeDecision({
      workerId: "worker-1",
      branch: "hackathon/session-1/worker-worker-1",
      status: INTEGRATION_STATUS.PENDING,
    });

    const approved = sup.approveIntegration({ decisionId: d.decisionId, approvedBy: "leader-1" });
    assert.strictEqual(approved.status, INTEGRATION_STATUS.APPROVED);
    assert.strictEqual(approved.approvedBy, "leader-1");

    const d2 = sup.makeDecision({
      workerId: "worker-2",
      branch: "hackathon/session-1/worker-worker-2",
      status: INTEGRATION_STATUS.PENDING,
    });

    const rejected = sup.rejectIntegration({
      decisionId: d2.decisionId,
      rejectedBy: "leader-1",
      reason: "fails security review",
    });
    assert.strictEqual(rejected.status, INTEGRATION_STATUS.REJECTED);
    assert.ok(rejected.issues.length > 0);
  });

  it("blocks integration", () => {
    const sup = new IntegrationSupervisor();

    const d = sup.makeDecision({
      workerId: "worker-1",
      branch: "hackathon/session-1/worker-worker-1",
      status: INTEGRATION_STATUS.PENDING,
    });

    const blocked = sup.blockIntegration({
      decisionId: d.decisionId,
      blockedBy: "leader-1",
      reason: "conflicts with worker-2",
    });
    assert.strictEqual(blocked.status, INTEGRATION_STATUS.BLOCKED);
  });

  it("returns readiness summary", () => {
    const sup = new IntegrationSupervisor();

    sup.makeDecision({ workerId: "worker-1", branch: "b1", status: INTEGRATION_STATUS.APPROVED });
    sup.makeDecision({ workerId: "worker-2", branch: "b2", status: INTEGRATION_STATUS.REJECTED });
    sup.makeDecision({ workerId: "worker-3", branch: "b3", status: INTEGRATION_STATUS.PENDING });

    const summary = sup.getReadinessSummary();
    assert.strictEqual(summary.totalDecisions, 3);
    assert.strictEqual(summary.approved, 1);
    assert.strictEqual(summary.rejected, 1);
    assert.strictEqual(summary.pending, 1);
    assert.strictEqual(summary.readyForIntegration, 1);
  });

  it("returns open conflicts", () => {
    const sup = new IntegrationSupervisor();

    sup.coordinator = {
      getTasks: () => [
        {
          taskId: "task-1",
          assignedWorkerId: "worker-1",
          filesOwned: ["src/shared.js"],
        },
      ],
    };

    sup.detectConflicts({
      workerId: "worker-2",
      filesOwned: ["src/shared.js"],
    });

    const open = sup.getOpenConflicts();
    assert.strictEqual(open.length, 1);

    sup.resolveConflict({
      conflictId: open[0].conflictId,
      resolution: "Reassigned src/shared.js to worker-1",
      resolvedBy: "leader-1",
    });

    const openAfter = sup.getOpenConflicts();
    assert.strictEqual(openAfter.length, 0);
  });
});
