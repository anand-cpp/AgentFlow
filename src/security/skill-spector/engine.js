// SkillSpector security gate — mandatory security review for external agent skills.
//
// Before AgentFlow installs, downloads, activates, imports, executes, or trusts
// any external agent skill, it must pass through NVIDIA SkillSpector scanning.
//
// Skill states:
//   DISCOVERED → AWAITING_SECURITY_SCAN → SCANNING → SCAN_FAILED →
//   SECURITY_FINDINGS → APPROVAL_REQUIRED → APPROVED_FOR_SANDBOX →
//   SANDBOX_TESTING → VERIFIED → REJECTED → BLOCKED
//
// A skill must never become active merely because it downloaded successfully.
// A failed or incomplete scan must never be represented as successful verification.

import { execFile } from "node:child_process";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);

/** Skill skill states. */
export const SKILL_STATE = {
  DISCOVERED: "discovered",
  AWAITING_SECURITY_SCAN: "awaiting_security_scan",
  SCANNING: "scanning",
  SCAN_FAILED: "scan_failed",
  SECURITY_FINDINGS: "security_findings",
  APPROVAL_REQUIRED: "approval_required",
  APPROVED_FOR_SANDBOX: "approved_for_sandbox",
  SANDBOX_TESTING: "sandbox_testing",
  VERIFIED: "verified",
  REJECTED: "rejected",
  BLOCKED: "blocked",
};

/** Skill scan result. */
export class SkillScanResult {
  constructor({
    skillId = null,
    skillName = null,
    skillSource = null,
    skillCommit = null,
    state = SKILL_STATE.DISCOVERED,
    scanId = null,
    scanOutput = null,
    findings = [],
    severity = null,
    confidence = null,
    scannerVersion = null,
    scannedAt = null,
    error = null,
  } = {}) {
    this.skillId = skillId;
    this.skillName = skillName;
    this.skillSource = skillSource;
    this.skillCommit = skillCommit;
    this.state = state;
    this.scanId = scanId;
    this.scanOutput = scanOutput;
    this.findings = findings;
    this.severity = severity;
    this.confidence = confidence;
    this.scannerVersion = scannerVersion;
    this.scannedAt = scannedAt;
    this.error = error;
  }
}

/**
 * SkillSpector integration — scans external agent skills for security issues
 * before they are installed or activated in AgentFlow.
 *
 * SkillSpector is a scanner, not a sandbox. After a skill passes the scanning
 * gate, it must still be tested in an isolated sandbox environment.
 */
export class SkillSpectorEngine {
  constructor({ stateDir, skillsDir } = {}) {
    this.stateDir = stateDir || null;
    this.skillsDir = skillsDir || null;
    this.skills = new Map(); // skillId -> skill record
    this.scanHistory = new Map(); // skillId -> SkillScanResult[]
  }

  /** Register a discovered skill. */
  registerSkill({ id, name, source, commit = null }) {
    if (this.skills.has(id)) {
      throw new Error(`Skill already registered: ${id}`);
    }

    const skill = {
      id,
      name,
      source,
      commit,
      state: SKILL_STATE.DISCOVERED,
      registeredAt: new Date().toISOString(),
      scanResults: [],
    };

    this.skills.set(id, skill);
    return skill;
  }

  /** Get a skill by ID. */
  getSkill(id) {
    return this.skills.get(id);
  }

  /** List all skills. */
  listSkills() {
    return [...this.skills.values()];
  }

  /** Check if SkillSpector binary is available. */
  async checkPreconditions() {
    try {
      await execFileAsync("skill-spector", ["--version"], { timeout: 10000 });
      return { available: true };
    } catch {
      return { available: false, reason: "skill-spector binary not found or not executable" };
    }
  }

  /**
   * Scan a skill with SkillSpector.
   *
   * The skill source is resolved, files are inspected, and SkillSpector is run.
   * Results are parsed and normalized into AgentFlow finding format.
   *
   * @param {string} skillId — ID of a registered skill
   * @param {object} options — { targetPath, timeoutMs }
   * @returns {SkillScanResult}
   */
  async scanSkill(skillId, options = {}) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    // Transition to AWAITING_SECURITY_SCAN
    skill.state = SKILL_STATE.AWAITING_SECURITY_SCAN;

    const preconditions = await this.checkPreconditions();
    if (!preconditions.available) {
      const result = new SkillScanResult({
        skillId,
        skillName: skill.name,
        skillSource: skill.source,
        skillCommit: skill.commit,
        state: SKILL_STATE.SCAN_FAILED,
        error: new Error(preconditions.reason),
        scannedAt: new Date().toISOString(),
      });
      this._recordScanResult(skillId, result);
      return result;
    }

    // Transition to SCANNING
    skill.state = SKILL_STATE.SCANNING;

    const targetPath = options.targetPath || skill.source;
    const startedAt = new Date().toISOString();

    try {
      // Run skill-spector scan
      const { stdout, stderr } = await execFileAsync(
        "skill-spector",
        ["scan", targetPath, "--format", "json"],
        {
          timeout: options.timeoutMs || 300000,
          maxBuffer: 50 * 1024 * 1024,
        }
      );

      const completedAt = new Date().toISOString();
      const scanResult = this._parseSkillSpectorOutput(
        skillId,
        skill.name,
        skill.source,
        skill.commit,
        stdout,
        stderr,
        startedAt,
        completedAt
      );

      // Determine state based on findings
      if (scanResult.findings.length > 0) {
        const hasCriticalOrHigh = scanResult.findings.some(
          (f) => f.severity === "critical" || f.severity === "high"
        );
        if (hasCriticalOrHigh) {
          scanResult.state = SKILL_STATE.SECURITY_FINDINGS;
        } else {
          scanResult.state = SKILL_STATE.APPROVAL_REQUIRED;
        }
      } else {
        scanResult.state = SKILL_STATE.APPROVAL_REQUIRED;
      }

      this._recordScanResult(skillId, scanResult);
      skill.state = scanResult.state;
      return scanResult;
    } catch (err) {
      const completedAt = new Date().toISOString();
      const result = new SkillScanResult({
        skillId,
        skillName: skill.name,
        skillSource: skill.source,
        skillCommit: skill.commit,
        state: SKILL_STATE.SCAN_FAILED,
        error: err,
        scannedAt: completedAt,
      });
      this._recordScanResult(skillId, result);
      skill.state = SKILL_STATE.SCAN_FAILED;
      return result;
    }
  }

  /** Parse SkillSpector JSON output into AgentFlow findings. */
  _parseSkillSpectorOutput(skillId, skillName, skillSource, skillCommit, stdout, stderr, startedAt, completedAt) {
    const findings = [];

    if (!stdout || stdout.trim() === "") {
      return new SkillScanResult({
        skillId,
        skillName,
        skillSource,
        skillCommit,
        state: SKILL_STATE.SCAN_FAILED,
        error: new Error("SkillSpector produced no output"),
        scannedAt: completedAt,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      return new SkillScanResult({
        skillId,
        skillName,
        skillSource,
        skillCommit,
        state: SKILL_STATE.SCAN_FAILED,
        error: new Error(`SkillSpector output could not be parsed: ${err.message}`),
        scanOutput: stdout.slice(0, 2000),
        scannedAt: completedAt,
      });
    }

    // SkillSpector output format may vary — handle common structures
    const results = parsed.results || parsed.findings || parsed.vulnerabilities || [];

    for (const result of results) {
      findings.push({
        scannerId: "skill-spector",
        ruleId: result.rule_id || result.ruleId || result.id || "unknown",
        severity: this._normalizeSeverity(result.severity || result.level || "medium"),
        confidence: this._normalizeConfidence(result.confidence || "likely"),
        title: result.title || result.rule || "SkillSpector finding",
        description: result.description || result.message || "",
        rootCause: result.rootCause || result.root_cause || null,
        recommendedFix: result.fix || result.recommendedFix || null,
        file: result.file || result.path || null,
        line: result.line || result.line_number || null,
        evidence: {
          code: result.code || result.snippet || null,
          match: result.match || null,
        },
        rawReport: result,
        verificationStatus: "unverified",
      });
    }

    const maxSeverity = this._maxSeverity(findings.map((f) => f.severity));

    return new SkillScanResult({
      skillId,
      skillName,
      skillSource,
      skillCommit,
      state: SKILL_STATE.SCANNING, // will be updated by caller
      scanId: parsed.scan_id || parsed.id || null,
      findings,
      severity: maxSeverity,
      scannerVersion: parsed.scanner_version || parsed.version || null,
      scanOutput: stdout.slice(0, 5000),
      scannedAt: completedAt,
    });
  }

  /** Record a scan result for a skill. */
  _recordScanResult(skillId, result) {
    if (!this.scanHistory.has(skillId)) {
      this.scanHistory.set(skillId, []);
    }
    this.scanHistory.get(skillId).push(result);
  }

  /** Approve a skill for sandbox testing. */
  approveForSandbox(skillId, approver) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (skill.state !== SKILL_STATE.APPROVAL_REQUIRED && skill.state !== SKILL_STATE.SECURITY_FINDINGS) {
      throw new Error(`Skill ${skillId} is not in approval-required state (current: ${skill.state})`);
    }

    skill.state = SKILL_STATE.APPROVED_FOR_SANDBOX;
    skill.approvedAt = new Date().toISOString();
    skill.approvedBy = approver;
    return skill;
  }

  /** Reject a skill. */
  rejectSkill(skillId, approver, reason) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    skill.state = SKILL_STATE.REJECTED;
    skill.rejectedAt = new Date().toISOString();
    skill.rejectedBy = approver;
    skill.rejectReason = reason;
    return skill;
  }

  /** Mark a skill as verified (after sandbox testing). */
  verifySkill(skillId, verifier) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (skill.state !== SKILL_STATE.SANDBOX_TESTING) {
      throw new Error(`Skill ${skillId} is not in sandbox testing state (current: ${skill.state})`);
    }

    skill.state = SKILL_STATE.VERIFIED;
    skill.verifiedAt = new Date().toISOString();
    skill.verifiedBy = verifier;
    return skill;
  }

  /** Block a skill. */
  blockSkill(skillId, reason) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    skill.state = SKILL_STATE.BLOCKED;
    skill.blockedAt = new Date().toISOString();
    skill.blockReason = reason;
    return skill;
  }

  /** Start sandbox testing for a skill. */
  startSandboxTesting(skillId, tester) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (skill.state !== SKILL_STATE.APPROVED_FOR_SANDBOX) {
      throw new Error(`Skill ${skillId} is not approved for sandbox (current: ${skill.state})`);
    }

    skill.state = SKILL_STATE.SANDBOX_TESTING;
    skill.sandboxTester = tester;
    skill.sandboxStartedAt = new Date().toISOString();
    return skill;
  }

  /** Check if a skill can be activated (must be VERIFIED). */
  canActivate(skillId) {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return { allowed: false, reason: "Skill not found" };
    }

    if (skill.state !== SKILL_STATE.VERIFIED) {
      return {
        allowed: false,
        reason: `Skill not verified (current state: ${skill.state})`,
      };
    }

    return { allowed: true };
  }

  /** Normalize severity string. */
  _normalizeSeverity(value) {
    const v = String(value || "").toLowerCase();
    if (v.includes("crit")) return "critical";
    if (v.includes("high")) return "high";
    if (v.includes("med")) return "medium";
    if (v.includes("low")) return "low";
    return "info";
  }

  /** Normalize confidence string. */
  _normalizeConfidence(value) {
    const v = String(value || "").toLowerCase();
    if (v.includes("confirm")) return "confirmed";
    if (v.includes("likely")) return "likely";
    if (v.includes("potential")) return "potential";
    return "unverified";
  }

  /** Get max severity from findings. */
  _maxSeverity(findings) {
    if (findings.length === 0) return null;
    const order = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    return findings.reduce((max, f) => (order[f.severity] || 0) > (order[max] || 0) ? f.severity : max, findings[0].severity);
  }
}

export default { SkillSpectorEngine, SkillScanResult, SKILL_STATE };
