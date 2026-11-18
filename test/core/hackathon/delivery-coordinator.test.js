// Delivery gate with coordinator tests — gate integrated with coordinator session.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { HackathonDeliveryGate } from "../../../src/core/hackathon/delivery-gate.js";
import { SecurityOrchestrator, SCAN_PROFILES } from "../../../src/security/orchestrator.js";
import { SemgrepScanner } from "../../../src/security/scanners/semgrep.js";

describe("Delivery gate with coordinator", () => {
  it("gate is created with coordinator session", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: coord.session.id });

    assert.strictEqual(gate.isIntegrationPermitted(), false);
    assert.strictEqual(gate.isPromotionPermitted(), false);
  });

  it("gate evaluation is tied to session", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: coord.session.id });

    const result = await gate.evaluate();
    assert.ok(result);
    assert.strictEqual(typeof result.eligible, "boolean");
  });

  it("gate rejects missing orchestrator", () => {
    assert.throws(() => new HackathonDeliveryGate({}), /orchestrator required/);
  });

  it("gate rejects missing sessionId", () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    assert.throws(() => new HackathonDeliveryGate({ orchestrator: orch }), /sessionId required/);
  });
});
