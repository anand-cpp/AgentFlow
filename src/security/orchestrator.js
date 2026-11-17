// Security orchestrator — coordinates scanner execution, findings, remediation,
// and delivery gating for AgentFlow.
//
// Manages scan profiles (QUICK, STANDARD, DEEP, RELEASE), scanner lifecycle,
// finding deduplication, and security-gated delivery decisions.

import { ScannerAdapter, SCANNER_STATUS } from "./scanners/base.js";
import { FindingsEngine } from "./findings/engine.js";

export const SCAN_PROFILES = {
  QUICK: "quick",
  STANDARD: "standard",
  DEEP: "deep",
  RELEASE: "release",
};

export const DELIVERY_STATUS = {
  VERIFIED: "verified",
  BLOCKED_SECURITY: "blocked_security",
  BLOCKED_INCOMPLETE: "blocked_incomplete",
  VERIFIED_WITH_RISKS: "verified_with_risks",
  NOT_SECURITY_VERIFIED: "not_security_verified",
};

export class SecurityOrchestrator {
  constructor(options = {}) {
    this.scanners = new Map(); // scannerId -> ScannerAdapter
    this.findingsEngine = new FindingsEngine();
    this.scanHistory = []; // array of scan sessions
    this.policies = options.policies || {};
    this.stateDir = options.stateDir || null;
    this.defaultProfile = options.defaultProfile || SCAN_PROFILES.STANDARD;

    // Scanner registry — subclasses/instances register themselves
    this._scannerRegistry = new Map();
  }

  /** Register a scanner adapter. */
  registerScanner(scannerAdapter) {
    if (!(scannerAdapter instanceof ScannerAdapter)) {
      throw new Error("registered scanner must extend ScannerAdapter");
    }
    this._scannerRegistry.set(scannerAdapter.id, scannerAdapter);
  }

  /** Get a registered scanner by id. */
  getScanner(id) {
    return this._scannerRegistry.get(id);
  }

  /** List registered scanner ids. */
  listScanners() {
    return [...this._scannerRegistry.keys()];
  }

  /** Check which scanners are available. */
  async probeScanners() {
    const availability = {};
    for (const [id, scanner] of this._scannerRegistry) {
      const preconditions = await scanner.checkPreconditions();
      availability[id] = {
        available: preconditions.available,
        reason: preconditions.reason,
      };
    }
    return availability;
  }

  /** Get scanner definitions for a profile. */
  getProfileScanners(profile) {
    const profileScanners = {
      [SCAN_PROFILES.QUICK]: ["semgrep", "osv-scanner"],
      [SCAN_PROFILES.STANDARD]: ["semgrep", "osv-scanner", "trivy"],
      [SCAN_PROFILES.DEEP]: ["semgrep", "osv-scanner", "trivy"],
      [SCAN_PROFILES.RELEASE]: ["semgrep", "osv-scanner", "trivy"],
    };
    return profileScanners[profile] || profileScanners[SCAN_PROFILES.STANDARD];
  }

  /** Run a scan profile against a target. */
  async runProfile(profile, target, options = {}) {
    const profileName = profile || this.defaultProfile;
    const scannerIds = this.getProfileScanners(profileName);
    const startedAt = new Date().toISOString();

    const availability = await this.probeScanners();

    const results = [];
    for (const scannerId of scannerIds) {
      const scanner = this.getScanner(scannerId);
      if (!scanner) {
        results.push({
          scannerId,
          status: SCANNER_STATUS.BLOCKED,
          error: new Error(`scanner ${scannerId} not registered`),
        });
        continue;
      }

      const avail = availability[scannerId];
      if (!avail || !avail.available) {
        results.push({
          scannerId,
          status: SCANNER_STATUS.BLOCKED,
          error: new Error(avail ? avail.reason : "scanner unavailable"),
        });
        continue;
      }

      try {
        const result = await scanner.execute(target, options);
        results.push(result);
        this.findingsEngine.addScanResult(result);
      } catch (err) {
        results.push({
          scannerId,
          status: SCANNER_STATUS.FAILED,
          error: err,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const session = {
      id: `scan-${Date.now()}`,
      profile: profileName,
      target,
      startedAt,
      completedAt,
      results,
      findingsSummary: this.findingsEngine.summary(),
    };
    this.scanHistory.push(session);

    return session;
  }

  /** Evaluate delivery gate against current findings and scan coverage. */
  evaluateDeliveryGate(options = {}) {
    const summary = this.findingsEngine.summary();
    const coverage = summary.scannerCoverage;
    const strict = options.strictReleasePolicy !== false;

    // Check for unresolved critical/high findings
    const unresolvedCriticalHigh = summary.critical + summary.high - summary.remediated;

    // Check scanner coverage for the requested profile
    const requestedProfile = options.profile || this.defaultProfile;
    const expectedScanners = this.getProfileScanners(requestedProfile);
    const unavailableScanners = expectedScanners.filter(
      (id) => !coverage[id] || coverage[id].status !== SCANNER_STATUS.COMPLETED
    );

    let status = DELIVERY_STATUS.VERIFIED;
    const reasons = [];
    const blockingFindings = [];

    if (strict && unresolvedCriticalHigh > 0) {
      status = DELIVERY_STATUS.BLOCKED_SECURITY;
      reasons.push(`${unresolvedCriticalHigh} unresolved critical/high finding(s)`);
    }

    if (unavailableScanners.length > 0) {
      if (status === DELIVERY_STATUS.VERIFIED) {
        status = DELIVERY_STATUS.BLOCKED_INCOMPLETE;
      }
      reasons.push(`scanner(s) unavailable: ${unavailableScanners.join(", ")}`);
    }

    // Check accepted risks
    const acceptedRisks = summary.acceptedRisks;
    if (acceptedRisks > 0 && status === DELIVERY_STATUS.VERIFIED) {
      status = DELIVERY_STATUS.VERIFIED_WITH_RISKS;
      reasons.push(`${acceptedRisks} accepted risk(s)`);
    }

    if (summary.total === 0 && Object.keys(coverage).length === 0) {
      status = DELIVERY_STATUS.NOT_SECURITY_VERIFIED;
      reasons.push("no security scans have been run");
    }

    return {
      status,
      eligible: status === DELIVERY_STATUS.VERIFIED || status === DELIVERY_STATUS.VERIFIED_WITH_RISKS,
      reasons,
      blockingFindings,
      summary,
      coverage,
      profile: requestedProfile,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /** Get the current security status panel data (for TUI inspector). */
  getSecurityStatusPanel() {
    const summary = this.findingsEngine.summary();
    const coverage = this.findingsEngine.scannerCoverage();
    const gate = this.evaluateDeliveryGate();

    const scannerStatus = {};
    const allScanners = ["semgrep", "osv-scanner", "trivy", "codeql", "trufflehog", "zap", "garak"];
    for (const id of allScanners) {
      scannerStatus[id] = coverage[id] || { status: SCANNER_STATUS.NOT_RUN, findingCount: 0 };
    }

    return {
      delivery: gate.status,
      eligible: gate.eligible,
      reasons: gate.reasons,
      summary: {
        total: summary.total,
        critical: summary.critical,
        high: summary.high,
        medium: summary.medium,
        low: summary.low,
        confirmed: summary.confirmed,
        needingRemediation: summary.needingRemediation,
      },
      scannerStatus,
      evaluatedAt: gate.evaluatedAt,
    };
  }

  /** Get scan history. */
  getHistory(limit = 10) {
    return this.scanHistory.slice(-limit);
  }

  /** Clear findings (start fresh scan session). */
  clearFindings() {
    this.findingsEngine.clear();
  }
}

export default { SecurityOrchestrator, SCAN_PROFILES, DELIVERY_STATUS };
