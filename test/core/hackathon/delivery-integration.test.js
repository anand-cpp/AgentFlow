// Delivery gate integration tests — gate blocks integration until eligible.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HackathonDeliveryGate } from "../../../src/core/hackathon/delivery-gate.js";
import { SecurityOrchestrator, SCAN_PROFILES } from "../../../src/security/orchestrator.js";
import { SemgrepScanner } from "../../../src/security/scanners/semgrep.js";

describe("Delivery gate integration", () => {
  it("gate is not permitted before evaluation", () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    assert.strictEqual(gate.isIntegrationPermitted(), false);
    assert.strictEqual(gate.isPromotionPermitted(), false);
  });

  it("gate evaluation returns eligibility status", async () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    const result = await gate.evaluate();
    assert.ok(result);
    assert.strictEqual(typeof result.eligible, "boolean");
    assert.ok(result.status);
    assert.ok(Array.isArray(result.reasons));
  });

  it("gate records last evaluation", async () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    await gate.evaluate();
    const last = gate.getLastEvaluation();
    assert.ok(last);
    assert.strictEqual(last.sessionId, "sess-1");
    assert.ok(last.evaluatedAt);
  });

  it("gate supports different profiles", async () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });

    const quick = await gate.evaluate({ profile: SCAN_PROFILES.QUICK });
    assert.ok(quick);
    assert.strictEqual(typeof quick.eligible, "boolean");

    const standard = await gate.evaluate({ profile: SCAN_PROFILES.STANDARD });
    assert.ok(standard);
    assert.strictEqual(typeof standard.eligible, "boolean");
  });

  it("gate requires orchestrator", () => {
    assert.throws(() => new HackathonDeliveryGate({}), /orchestrator required/);
  });

  it("gate requires sessionId", () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    assert.throws(() => new HackathonDeliveryGate({ orchestrator: orch }), /sessionId required/);
  });
});
