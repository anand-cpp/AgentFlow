// Security integration tests — coordinator enforces security controls.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { HackathonDeliveryGate } from "../../../src/core/hackathon/delivery-gate.js";
import { SecurityOrchestrator, SCAN_PROFILES } from "../../../src/security/orchestrator.js";
import { SemgrepScanner } from "../../../src/security/scanners/semgrep.js";

describe("Security integration with coordinator", () => {
  it("coordinator session is independent from security gate", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({
      orchestrator: orch,
      sessionId: coord.session.id,
    });

    // Session exists but gate is not yet evaluated.
    assert.strictEqual(gate.isIntegrationPermitted(), false);
    assert.strictEqual(coord.session.status, "active");
  });

  it("coordinator enforces worker authentication", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    // Uninvited worker cannot register.
    const result = await coord.registerWorker({
      workerId: "uninvited",
      token: "fake-token",
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, false);
  });

  it("coordinator enforces task ownership", async () => {
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
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });

    // Different worker cannot accept.
    const result = await coord.acceptTask({ taskId: "task-1", workerId: "worker-2" });
    assert.strictEqual(result.ok, false);
  });

  it("coordinator revoked worker cannot dispatch", async () => {
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

    coord.revokeWorker({ workerId: "worker-1" });

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
  });
});
