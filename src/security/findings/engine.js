// Findings engine — deduplication, severity analysis, and finding state management.
//
// Centralizes all security findings from multiple scanners, deduplicates
// overlapping reports, and tracks verification state through the remediation
// lifecycle.

import { Finding, SEVERITY, CONFIDENCE, VERIFICATION_STATUS } from "../scanners/base.js";

/** Severity ordering for sorting. */
const SEVERITY_ORDER = {
  [SEVERITY.CRITICAL]: 5,
  [SEVERITY.HIGH]: 4,
  [SEVERITY.MEDIUM]: 3,
  [SEVERITY.LOW]: 2,
  [SEVERITY.INFO]: 1,
};

/** Generate a fingerprint for deduplication. */
function fingerprint(finding) {
  const parts = [
    finding.scannerId || "",
    finding.ruleId || "",
    finding.cve || "",
    finding.file || "",
    finding.line || "",
    finding.dependencyPath || "",
    finding.title || "",
  ];
  return parts.join("|");
}

export class FindingsEngine {
  constructor() {
    this.findings = new Map(); // id -> Finding
    this.fingerprints = new Map(); // fingerprint -> id
    this.scannerResults = new Map(); // scannerId -> ScanResult[]
  }

  /** Add a scan result, deduplicating findings by fingerprint. */
  addScanResult(scanResult) {
    const previous = this.scannerResults.get(scanResult.scannerId) || [];
    previous.push(scanResult);
    this.scannerResults.set(scanResult.scannerId, previous);

    for (const finding of scanResult.findings) {
      this.addFinding(finding);
    }

    return { added: scanResult.findings.length, total: this.findings.size };
  }

  /** Add a single finding, deduplicating by fingerprint. */
  addFinding(finding) {
    // Wrap plain objects in Finding instances to ensure method availability
    if (!(finding instanceof Finding)) {
      finding = new Finding(finding);
    }
    const fp = fingerprint(finding);
    const existingId = this.fingerprints.get(fp);

    if (existingId) {
      // Merge evidence from duplicate finding into existing
      const existing = this.findings.get(existingId);
      if (existing) {
        // Keep the higher severity
        if (SEVERITY_ORDER[finding.severity] > (SEVERITY_ORDER[existing.severity] || 0)) {
          existing.severity = finding.severity;
        }
        // Merge evidence
        if (finding.evidence && existing.evidence) {
          existing.evidence = { ...existing.evidence, ...finding.evidence };
        }
        // Update raw report if newer
        if (finding.rawReport) existing.rawReport = finding.rawReport;
        existing.updatedAt = new Date().toISOString();
      }
      return { added: false, id: existingId, duplicate: true };
    }

    this.findings.set(finding.id, finding);
    this.fingerprints.set(fp, finding.id);
    return { added: true, id: finding.id, duplicate: false };
  }

  /** Get all findings. */
  getAll() {
    return [...this.findings.values()];
  }

  /** Get finding by ID. */
  getById(id) {
    return this.findings.get(id);
  }

  /** Get findings by severity. */
  getBySeverity(severity) {
    return this.getAll().filter((f) => f.severity === severity);
  }

  /** Get confirmed (verified) findings. */
  getConfirmed() {
    return this.getAll().filter((f) => f.isConfirmed());
  }

  /** Get critical and high confirmed findings. */
  getCriticalOrHigh() {
    return this.getAll().filter((f) => f.isCriticalOrHigh());
  }

  /** Get findings by verification status. */
  getByVerificationStatus(status) {
    return this.getAll().filter((f) => f.verificationStatus === status);
  }

  /** Get unconfirmed findings (need verification). */
  getUnconfirmed() {
    return this.getAll().filter((f) => f.verificationStatus === VERIFICATION_STATUS.UNVERIFIED);
  }

  /** Get findings needing remediation (confirmed critical/high not yet remediated). */
  getNeedingRemediation() {
    return this.getAll().filter(
      (f) => f.isCriticalOrHigh() && f.verificationStatus !== VERIFICATION_STATUS.REMEDIATED
    );
  }

  /** Update finding verification status. */
  setVerification(id, status, evidence = null) {
    const finding = this.findings.get(id);
    if (!finding) return false;
    finding.verificationStatus = status;
    if (evidence) finding.evidence = { ...finding.evidence, ...evidence };
    finding.updatedAt = new Date().toISOString();
    return true;
  }

  /** Mark finding as remediated. */
  markRemediated(id, fixEvidence = null) {
    return this.setVerification(id, VERIFICATION_STATUS.REMEDIATED, fixEvidence);
  }

  /** Mark finding as false positive. */
  markFalsePositive(id, reason = null) {
    return this.setVerification(id, VERIFICATION_STATUS.FALSE_POSITIVE, { falsePositiveReason: reason });
  }

  /** Mark finding as accepted risk. */
  markAcceptedRisk(id, justification, approver, expiration) {
    return this.setVerification(id, VERIFICATION_STATUS.ACCEPTED_RISK, {
      justification,
      approver,
      expiration,
    });
  }

  /** Get severity distribution counts. */
  severityDistribution() {
    const dist = {};
    for (const s of Object.values(SEVERITY)) {
      dist[s] = this.getBySeverity(s).length;
    }
    return dist;
  }

  /** Get confidence distribution counts. */
  confidenceDistribution() {
    const dist = {};
    for (const c of Object.values(CONFIDENCE)) {
      dist[c] = this.getAll().filter((f) => f.confidence === c).length;
    }
    return dist;
  }

  /** Get scanner coverage (which scanners ran and their status). */
  scannerCoverage() {
    const coverage = {};
    for (const [scannerId, results] of this.scannerResults) {
      const latest = results[results.length - 1];
      coverage[scannerId] = {
        status: latest.status,
        findingCount: latest.findings.length,
        lastRun: latest.completedAt,
        error: latest.error?.message || null,
      };
    }
    return coverage;
  }

  /** Clear all findings (for rescan). */
  clear() {
    this.findings.clear();
    this.fingerprints.clear();
    this.scannerResults.clear();
  }

  /** Get summary statistics. */
  summary() {
    const all = this.getAll();
    return {
      total: all.length,
      critical: this.getBySeverity(SEVERITY.CRITICAL).length,
      high: this.getBySeverity(SEVERITY.HIGH).length,
      medium: this.getBySeverity(SEVERITY.MEDIUM).length,
      low: this.getBySeverity(SEVERITY.LOW).length,
      info: this.getBySeverity(SEVERITY.INFO).length,
      confirmed: this.getConfirmed().length,
      unconfirmed: this.getUnconfirmed().length,
      remediated: this.getByVerificationStatus(VERIFICATION_STATUS.REMEDIATED).length,
      falsePositives: this.getByVerificationStatus(VERIFICATION_STATUS.FALSE_POSITIVE).length,
      acceptedRisks: this.getByVerificationStatus(VERIFICATION_STATUS.ACCEPTED_RISK).length,
      needingRemediation: this.getNeedingRemediation().length,
      scannerCoverage: this.scannerCoverage(),
    };
  }
}

export default { FindingsEngine, SEVERITY, CONFIDENCE, VERIFICATION_STATUS, fingerprint };
