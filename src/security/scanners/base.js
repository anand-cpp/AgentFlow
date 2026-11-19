// Scanner adapter base contract.
//
// Every security scanner integrated with AgentFlow must implement this
// interface. The orchestrator treats scanners uniformly regardless of their
// underlying tool, normalizing outputs into AgentFlow's finding format.
//
// Zero runtime dependencies: plain Node builtins only.

/** Severity scale used across all normalized findings. */
export const SEVERITY = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "info",
};

/** Finding confidence levels. */
export const CONFIDENCE = {
  CONFIRMED: "confirmed",
  LIKELY: "likely",
  POTENTIAL: "potential",
  FALSE_POSITIVE: "false_positive",
  ACCEPTED_RISK: "accepted_risk",
  UNVERIFIED: "unverified",
};

/** Scanner status values. */
export const SCANNER_STATUS = {
  AVAILABLE: "available",
  UNAVAILABLE: "unavailable",
  BLOCKED: "blocked",
  NOT_RUN: "not_run",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMEOUT: "timeout",
};

/** Finding verification status. */
export const VERIFICATION_STATUS = {
  UNVERIFIED: "unverified",
  VERIFIED: "verified",
  REMEDIATED: "remediated",
  REJECTED: "rejected",
  FALSE_POSITIVE: "false_positive",
};

/** Result of a scanner execution. */
export class ScanResult {
  constructor({ scannerId, status, findings = [], metadata = {}, error = null, startedAt, completedAt }) {
    this.scannerId = scannerId;
    this.status = status;
    this.findings = findings;
    this.metadata = metadata;
    this.error = error;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
  }

  isSuccessful() {
    return this.status === SCANNER_STATUS.COMPLETED;
  }

  isBlocked() {
    return this.status === SCANNER_STATUS.BLOCKED || this.status === SCANNER_STATUS.UNAVAILABLE;
  }
}

/** Normalized AgentFlow security finding. */
export class Finding {
  constructor({
    id = null,
    scannerId = null,
    ruleId = null,
    cwe = null,
    cve = null,
    severity = SEVERITY.INFO,
    confidence = CONFIDENCE.UNVERIFIED,
    reachability = null,
    exploitability = null,
    title = null,
    description = null,
    rootCause = null,
    recommendedFix = null,
    file = null,
    line = null,
    dependencyPath = null,
    evidence = null,
    verificationStatus = VERIFICATION_STATUS.UNVERIFIED,
    rawReport = null,
    scannerLocation = null,
  } = {}) {
    this.id = id || `af-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.scannerId = scannerId;
    this.ruleId = ruleId;
    this.cwe = cwe;
    this.cve = cve;
    this.severity = severity;
    this.confidence = confidence;
    this.reachability = reachability;
    this.exploitability = exploitability;
    this.title = title;
    this.description = description;
    this.rootCause = rootCause;
    this.recommendedFix = recommendedFix;
    this.file = file;
    this.line = line;
    this.dependencyPath = dependencyPath;
    this.evidence = evidence;
    this.verificationStatus = verificationStatus;
    this.rawReport = rawReport;
    this.scannerLocation = scannerLocation;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  isConfirmed() {
    return this.verificationStatus === VERIFICATION_STATUS.VERIFIED;
  }

  isCriticalOrHigh() {
    return this.severity === SEVERITY.CRITICAL || this.severity === SEVERITY.HIGH;
  }

  isFalsePositive() {
    return this.verificationStatus === VERIFICATION_STATUS.FALSE_POSITIVE;
  }
}

/**
 * Base scanner adapter.
 *
 * Subclasses must implement:
 *   - id
 *   - name
 *   - version
 *   - supportedArtifactTypes
 *   - checkPreconditions()
 *   - execute(target, options)
 *   - parseOutput(output, options)
 */
export class ScannerAdapter {
  constructor() {
    if (this.constructor === ScannerAdapter) {
      throw new Error("ScannerAdapter is abstract; subclass it");
    }
  }

  get id() {
    throw new Error("scanner id not implemented");
  }

  get name() {
    throw new Error("scanner name not implemented");
  }

  get version() {
    throw new Error("scanner version not implemented");
  }

  get supportedArtifactTypes() {
    return ["filesystem"];
  }

  /** Check if the scanner binary/tool is available. Returns { available, reason }. */
  async checkPreconditions() {
    return { available: false, reason: "not implemented" };
  }

  /**
   * Execute the scanner against a target.
   * Returns a ScanResult with normalized findings.
   */
  async execute(target, options = {}) {
    const preconditions = await this.checkPreconditions();
    if (!preconditions.available) {
      return new ScanResult({
        scannerId: this.id,
        status: SCANNER_STATUS.BLOCKED,
        error: new Error(preconditions.reason || "scanner preconditions not met"),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }

    const startedAt = new Date().toISOString();
    try {
      const rawOutput = await this.executeScanner(target, options);
      const findings = this.parseOutput(rawOutput, options);
      const completedAt = new Date().toISOString();
      return new ScanResult({
        scannerId: this.id,
        status: SCANNER_STATUS.COMPLETED,
        findings,
        metadata: { target, startedAt, completedAt, durationMs: new Date(completedAt) - new Date(startedAt) },
        startedAt,
        completedAt,
      });
    } catch (err) {
      const completedAt = new Date().toISOString();
      return new ScanResult({
        scannerId: this.id,
        status: SCANNER_STATUS.FAILED,
        error: err,
        startedAt,
        completedAt,
      });
    }
  }

  /** Subclass implements the actual scanner invocation. */
  async executeScanner(target, _options = {}) {
    throw new Error(`executeScanner not implemented for ${this.id}`);
  }

  /** Subclass parses raw scanner output into Finding[]. */
  parseOutput(output, _options = {}) {
    throw new Error(`parseOutput not implemented for ${this.id}`);
  }

  /** Normalize a raw severity string to AgentFlow SEVERITY. */
  normalizeSeverity(value) {
    const v = String(value || "").toLowerCase();
    if (v.includes("crit")) return SEVERITY.CRITICAL;
    if (v.includes("high")) return SEVERITY.HIGH;
    if (v.includes("med")) return SEVERITY.MEDIUM;
    if (v.includes("low")) return SEVERITY.LOW;
    return SEVERITY.INFO;
  }

  /** Normalize a raw confidence string. */
  normalizeConfidence(value) {
    const v = String(value || "").toLowerCase();
    if (v.includes("confirm")) return CONFIDENCE.CONFIRMED;
    if (v.includes("likely")) return CONFIDENCE.LIKELY;
    if (v.includes("potential")) return CONFIDENCE.POTENTIAL;
    if (v.includes("false")) return CONFIDENCE.FALSE_POSITIVE;
    return CONFIDENCE.UNVERIFIED;
  }
}

export default { ScanResult, Finding, SEVERITY, CONFIDENCE, SCANNER_STATUS, VERIFICATION_STATUS, ScannerAdapter };
