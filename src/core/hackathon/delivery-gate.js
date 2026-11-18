// Delivery gate integration for Hackathon Mode.
//
// Connects Hackathon sessions to the existing SecurityOrchestrator delivery
// gate. A Hackathon session cannot be promoted (integration or main-branch
// promotion) until the security gate is eligible — i.e., security scans have
// run with acceptable findings.
//
// This enforces the principle that Auto Mode (and by extension Hackathon
// delivery) requires delivery gate eligibility, consistent with the existing
// mode policy.

import { SCAN_PROFILES } from "../../security/orchestrator.js";
import { redactVerified } from "../redact.js";

/** Delivery gate status for a Hackathon session. */
export class HackathonDeliveryGate {
  constructor({ orchestrator, sessionId } = {}) {
    if (!orchestrator) throw new Error("orchestrator required");
    if (!sessionId) throw new Error("sessionId required");
    this.orchestrator = orchestrator;
    this.sessionId = sessionId;
    this.lastEvaluation = null;
  }

  /** Evaluate the delivery gate for the current session.
   *
   * Returns { eligible, status, reasons, summary, coverage }.
   * eligible is false when security scans are incomplete or findings are
   * unresolved — integration and promotion are blocked.
   */
  async evaluate({ profile = SCAN_PROFILES.STANDARD, strict = true } = {}) {
    const gate = this.orchestrator.evaluateDeliveryGate({
      profile,
      strictReleasePolicy: strict,
    });

    this.lastEvaluation = {
      ...gate,
      sessionId: this.sessionId,
      evaluatedAt: new Date().toISOString(),
    };

    return {
      eligible: gate.eligible,
      status: gate.status,
      reasons: gate.reasons,
      summary: gate.summary,
      coverage: gate.coverage,
    };
  }

  /** Whether integration is currently permitted. */
  isIntegrationPermitted() {
    if (!this.lastEvaluation) return false;
    return this.lastEvaluation.eligible;
  }

  /** Whether main-branch promotion is currently permitted. */
  isPromotionPermitted() {
    if (!this.lastEvaluation) return false;
    return this.lastEvaluation.eligible;
  }

  /** Get the last evaluation result. */
  getLastEvaluation() {
    return this.lastEvaluation;
  }

  /** Log the gate evaluation to the session's audit trail. */
  logEvaluation(eventLog) {
    if (!eventLog || !this.lastEvaluation) return;
    eventLog.emit("hackathon.delivery_gate_evaluated", redactVerified({
      sessionId: this.sessionId,
      eligible: this.lastEvaluation.eligible,
      status: this.lastEvaluation.status,
      reasons: this.lastEvaluation.reasons,
    }), "info");
  }
}

export default { HackathonDeliveryGate };
