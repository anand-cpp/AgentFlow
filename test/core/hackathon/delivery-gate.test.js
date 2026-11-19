// Delivery gate integration tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { HackathonDeliveryGate } from "../../../src/core/hackathon/delivery-gate.js";
import { SecurityOrchestrator, SCAN_PROFILES } from "../../../src/security/orchestrator.js";
import { SemgrepScanner } from "../../../src/security/scanners/semgrep.js";
import { OsvScanner } from "../../../src/security/scanners/osv.js";
import { TrivyScanner } from "../../../src/security/scanners/trivy.js";

describe("HackathonDeliveryGate", () => {
  it("creates a gate with orchestrator and session", () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    assert.ok(gate);
    assert.strictEqual(gate.isIntegrationPermitted(), false);
    assert.strictEqual(gate.isPromotionPermitted(), false);
    assert.strictEqual(gate.getLastEvaluation(), null);
  });

  it("evaluates delivery gate when no scans run", async () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    orch.registerScanner(new OsvScanner());
    orch.registerScanner(new TrivyScanner());

    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    const result = await gate.evaluate();

    // Scanners may not be available in this environment, so the gate may be
    // blocked_incomplete or not_security_verified. Either way, not eligible.
    assert.strictEqual(result.eligible, false);
    assert.ok(result.status);
    assert.ok(Array.isArray(result.reasons));
  });

  it("reports not permitted before evaluation", () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    assert.strictEqual(gate.isIntegrationPermitted(), false);
    assert.strictEqual(gate.isPromotionPermitted(), false);
  });

  it("uses default profile when none specified", async () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    const result = await gate.evaluate();
    assert.ok(result);
    assert.strictEqual(typeof result.eligible, "boolean");
  });

  it("supports quick profile", async () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    orch.registerScanner(new SemgrepScanner());
    const gate = new HackathonDeliveryGate({ orchestrator: orch, sessionId: "sess-1" });
    const result = await gate.evaluate({ profile: SCAN_PROFILES.QUICK });
    assert.ok(result);
    assert.strictEqual(typeof result.eligible, "boolean");
  });

  it("rejects missing orchestrator", () => {
    assert.throws(() => new HackathonDeliveryGate({}), /orchestrator required/);
  });

  it("rejects missing sessionId", () => {
    const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
    assert.throws(() => new HackathonDeliveryGate({ orchestrator: orch }), /sessionId required/);
  });
});
