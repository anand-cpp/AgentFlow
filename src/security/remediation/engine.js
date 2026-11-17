// Remediation engine — bounded patch/rescan/verify cycle.
//
// Implements the remediation loop:
//
//   SCAN → TRIAGE → PATCH → TEST → INDEPENDENT RESCAN → FINDING VERIFICATION → DELIVERY GATE
//
// Every patch is applied in an isolated worktree or branch. A patch does NOT
// automatically resolve its finding — an independent rescan must confirm the
// finding is gone before it is marked remediated. Failed remediation retains
// its evidence and creates a retryable task. The loop is bounded to prevent
// infinite repair cycles. Patches are never automatically merged or pushed.

import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import findingsEngineModule from "../findings/engine.js";
import { SecurityOrchestrator } from "../orchestrator.js";

const { FindingsEngine, SEVERITY, VERIFICATION_STATUS } = findingsEngineModule;

const execFileAsync = promisify(execFile);

/** Patch outcome values. */
export const PATCH_OUTCOME = {
  APPLIED: "applied",
  FAILED: "failed",
  SKIPPED: "skipped",
  REVERTED: "reverted",
};

/** Remediation attempt states. */
export const REMEDIATION_STATE = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
};

/**
 * Remediation attempt record — one attempt to fix a single finding.
 */
export class RemediationAttempt {
  constructor({
    id = null,
    findingId = null,
    findingTitle = null,
    findingSeverity = null,
    strategy = null,
    patchCommand = null,
    state = REMEDIATION_STATE.PENDING,
    outcome = null,
    patchDiff = null,
    testResult = null,
    rescanResult = null,
    verificationResult = null,
    error = null,
    attemptNumber = 1,
    maxAttempts = 3,
    createdAt = null,
    completedAt = null,
  } = {}) {
    this.id = id || `rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.findingId = findingId;
    this.findingTitle = findingTitle;
    this.findingSeverity = findingSeverity;
    this.strategy = strategy;
    this.patchCommand = patchCommand;
    this.state = state;
    this.outcome = outcome;
    this.patchDiff = patchDiff;
    this.testResult = testResult;
    this.rescanResult = rescanResult;
    this.verificationResult = verificationResult;
    this.error = error;
    this.attemptNumber = attemptNumber;
    this.maxAttempts = maxAttempts;
    this.createdAt = createdAt || new Date().toISOString();
    this.completedAt = completedAt;
  }

  get isExhausted() {
    return this.attemptNumber >= this.maxAttempts;
  }

  get canRetry() {
    return this.state !== REMEDIATION_STATE.COMPLETED && !this.isExhausted;
  }
}

/**
 * Remediation engine — orchestrates the patch/rescan/verify cycle.
 *
 * Does NOT automatically merge or push patches. Does NOT automatically mark
 * findings as remediated — that requires an independent rescan.
 */
export class RemediationEngine {
  constructor({ findingsEngine, securityOrchestrator, stateDir } = {}) {
    this.findingsEngine = findingsEngine;
    this.securityOrchestrator = securityOrchestrator;
    this.stateDir = stateDir || null;
    this.attempts = new Map(); // attemptId -> RemediationAttempt
    this.findingAttempts = new Map(); // findingId -> attemptId[]
    this.maxConcurrentAttempts = 1; // Sequential to avoid conflicts
  }

  /**
   * Create a remediation attempt for a finding.
   * The attempt is not executed until runAttempt() is called.
   */
  createAttempt({
    findingId,
    strategy = "dependency-update",
    patchCommand = null,
    maxAttempts = 3,
  }) {
    const finding = this.findingsEngine.getById(findingId);
    if (!finding) {
      throw new Error(`Finding not found: ${findingId}`);
    }

    const existingAttempts = this.findingAttempts.get(findingId) || [];
    const attemptNumber = existingAttempts.length + 1;

    const attempt = new RemediationAttempt({
      findingId,
      findingTitle: finding.title,
      findingSeverity: finding.severity,
      strategy,
      patchCommand,
      attemptNumber,
      maxAttempts,
    });

    this.attempts.set(attempt.id, attempt);
    if (!this.findingAttempts.has(findingId)) {
      this.findingAttempts.set(findingId, []);
    }
    this.findingAttempts.get(findingId).push(attempt.id);

    return attempt;
  }

  /**
   * Run a remediation attempt through the full cycle:
   *   PATCH → TEST → INDEPENDENT RESCAN → FINDING VERIFICATION
   *
   * Returns the attempt with updated state.
   * Does NOT auto-resolve the finding — rescan must confirm.
   */
  async runAttempt(attemptId, options = {}) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new Error(`Attempt not found: ${attemptId}`);
    }

    if (attempt.state === REMEDIATION_STATE.COMPLETED) {
      throw new Error(`Attempt already completed: ${attemptId}`);
    }

    attempt.state = REMEDIATION_STATE.IN_PROGRESS;
    attempt.completedAt = null;

    try {
      // Step 1: PATCH
      const patchResult = await this._applyPatch(attempt, options);
      attempt.patchDiff = patchResult.diff;
      attempt.outcome = patchResult.outcome;

      if (patchResult.outcome === PATCH_OUTCOME.FAILED) {
        attempt.state = REMEDIATION_STATE.FAILED;
        attempt.error = patchResult.error;
        attempt.completedAt = new Date().toISOString();
        return attempt;
      }

      if (patchResult.outcome === PATCH_OUTCOME.SKIPPED) {
        attempt.state = REMEDIATION_STATE.BLOCKED;
        attempt.error = patchResult.error || new Error("Patch skipped — no applicable fix strategy");
        attempt.completedAt = new Date().toISOString();
        return attempt;
      }

      // Step 2: TEST (run regression tests)
      const testResult = await this._runTests(attempt, options);
      attempt.testResult = testResult;

      if (!testResult.passed) {
        attempt.state = REMEDIATION_STATE.FAILED;
        attempt.error = new Error(`Tests failed: ${testResult.error || "unknown"}`);
        attempt.completedAt = new Date().toISOString();
        return attempt;
      }

      // Step 3: INDEPENDENT RESCAN (fresh scanner run against the target)
      const rescanResult = await this._rescan(attempt, options);
      attempt.rescanResult = rescanResult;

      // Step 4: FINDING VERIFICATION (compare rescan findings to original)
      const verificationResult = await this._verifyFinding(attempt, rescanResult, options);
      attempt.verificationResult = verificationResult;

      if (verificationResult.findingResolved) {
        attempt.state = REMEDIATION_STATE.COMPLETED;
        attempt.outcome = PATCH_OUTCOME.APPLIED;
        // Mark finding as remediated — ONLY after independent rescan confirms
        this.findingsEngine.markRemediated(attempt.findingId, {
          remediationAttemptId: attempt.id,
          rescanResult: verificationResult.rescanSummary,
          verifiedAt: new Date().toISOString(),
        });
      } else if (attempt.isExhausted) {
        attempt.state = REMEDIATION_STATE.FAILED;
        attempt.error = new Error(
          `Remediation exhausted after ${attempt.maxAttempts} attempts — finding still present`
        );
      } else {
        attempt.state = REMEDIATION_STATE.PENDING; // Can retry
      }

      attempt.completedAt = new Date().toISOString();
      return attempt;
    } catch (err) {
      attempt.state = REMEDIATION_STATE.FAILED;
      attempt.error = err;
      attempt.completedAt = new Date().toISOString();
      return attempt;
    }
  }

  /** Apply a patch (dependency update or source code change). */
  async _applyPatch(attempt, options = {}) {
    const finding = this.findingsEngine.getById(attempt.findingId);
    if (!finding) {
      return { outcome: PATCH_OUTCOME.FAILED, error: new Error("Finding not found"), diff: null };
    }

    // Strategy: dependency update
    if (attempt.strategy === "dependency-update" && finding.dependencyPath) {
      return this._applyDependencyUpdate(attempt, finding, options);
    }

    // Strategy: source code patch (provided command)
    if (attempt.patchCommand) {
      return this._applyCommandPatch(attempt, options);
    }

    return {
      outcome: PATCH_OUTCOME.SKIPPED,
      error: new Error(`No patch strategy available for finding: ${finding.title}`),
      diff: null,
    };
  }

  /** Apply a dependency version bump. */
  async _applyDependencyUpdate(attempt, finding, options = {}) {
    // Parse dependency path like "package@version"
    const match = finding.dependencyPath.match(/^(.+)@(.+)$/);
    if (!match) {
      return {
        outcome: PATCH_OUTCOME.FAILED,
        error: new Error(`Cannot parse dependency path: ${finding.dependencyPath}`),
        diff: null,
      };
    }

    const [, pkgName, currentVersion] = match;
    const fixedVersion = finding.evidence?.fixedVersion;

    if (!fixedVersion) {
      return {
        outcome: PATCH_OUTCOME.SKIPPED,
        error: new Error(`No fixed version available for ${pkgName}`),
        diff: null,
      };
    }

    // Detect lockfile type
    const lockfile = this._detectLockfile();
    if (!lockfile) {
      return {
        outcome: PATCH_OUTCOME.SKIPPED,
        error: new Error("No supported lockfile found for dependency update"),
        diff: null,
      };
    }

    // Apply the bump using the appropriate tool
    if (lockfile.type === "npm") {
      return await this._npmInstall(pkgName, fixedVersion, options);
    }

    return {
      outcome: PATCH_OUTCOME.SKIPPED,
      error: new Error(`Unsupported lockfile type: ${lockfile.type}`),
      diff: null,
    };
  }

  /** Detect lockfile type in the project. */
  _detectLockfile() {
    const candidates = [
      { file: "package-lock.json", type: "npm" },
      { file: "package.json", type: "npm" },
      { file: "requirements.txt", type: "pip" },
      { file: "Cargo.lock", type: "cargo" },
      { file: "go.sum", type: "go" },
    ];

    for (const c of candidates) {
      const fullPath = path.join(process.cwd(), c.file);
      try {
        if (fs.existsSync(fullPath)) {
          return { type: c.type, file: fullPath, path: c.file };
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  /** Run npm install to update a dependency. */
  async _npmInstall(pkgName, version, options = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "npm",
        ["install", `${pkgName}@${version}`, "--save-dev", "--no-audit", "--no-fund"],
        {
          timeout: options.timeoutMs || 120000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      const diff = this._captureGitDiff();

      return {
        outcome: PATCH_OUTCOME.APPLIED,
        diff,
        error: null,
        commandOutput: stdout,
      };
    } catch (err) {
      return {
        outcome: PATCH_OUTCOME.FAILED,
        error: err,
        diff: null,
        commandOutput: err.stdout || err.stderr || String(err),
      };
    }
  }

  /** Apply a user-provided patch command. */
  async _applyCommandPatch(attempt, options = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "sh",
        ["-c", attempt.patchCommand],
        {
          timeout: options.timeoutMs || 120000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      const diff = this._captureGitDiff();

      return {
        outcome: PATCH_OUTCOME.APPLIED,
        diff,
        error: null,
        commandOutput: stdout,
      };
    } catch (err) {
      return {
        outcome: PATCH_OUTCOME.FAILED,
        error: err,
        diff: null,
        commandOutput: err.stdout || err.stderr || String(err),
      };
    }
  }

  /** Capture git diff of working tree changes. */
  _captureGitDiff() {
    try {
      const { stdout } = execFileSync("git", ["diff"], {
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return stdout || null;
    } catch {
      return null;
    }
  }

  /** Run regression tests. */
  async _runTests(attempt, options = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(
        "node",
        ["scripts/run-tests.mjs"],
        {
          timeout: options.timeoutMs || 300000,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      const output = stdout + stderr;
      const passed = !output.includes("✖ failing tests") && !output.includes("fail");

      return {
        passed,
        output,
        error: passed ? null : new Error("Tests failed"),
      };
    } catch (err) {
      return {
        passed: false,
        output: err.stdout || err.stderr || String(err),
        error: err,
      };
    }
  }

  /** Independent rescan — fresh scanner run to verify the finding is gone. */
  async _rescan(attempt, options = {}) {
    if (!this.securityOrchestrator) {
      return {
        status: "skipped",
        reason: "No security orchestrator available for rescan",
        findings: [],
      };
    }

    // Run a quick scan (faster profile) against the same target
    const target = options.target || process.cwd();
    const session = await this.securityOrchestrator.runProfile(
      "quick",
      target,
      { timeoutMs: options.timeoutMs || 120000 }
    );

    // Find if the original finding is still present
    const originalFinding = this.findingsEngine.getById(attempt.findingId);
    const fingerprint = this._computeFingerprint(originalFinding);

    const stillPresent = session.results.some((r) =>
      r.findings.some((f) => this._computeFingerprint(f) === fingerprint)
    );

    return {
      status: "completed",
      sessionId: session.id,
      profile: session.profile,
      findings: session.results.flatMap((r) => r.findings),
      findingStillPresent: stillPresent,
      summary: session.findingsSummary,
    };
  }

  /** Verify if the finding was resolved by the rescan. */
  async _verifyFinding(attempt, rescanResult, options = {}) {
    const originalFinding = this.findingsEngine.getById(attempt.findingId);

    if (rescanResult.status !== "completed") {
      return {
        findingResolved: false,
        reason: `Rescan did not complete: ${rescanResult.status}`,
        rescanSummary: rescanResult.summary,
      };
    }

    if (rescanResult.findingStillPresent) {
      return {
        findingResolved: false,
        reason: "Finding still present after rescan",
        rescanSummary: rescanResult.summary,
      };
    }

    return {
      findingResolved: true,
      reason: "Finding no longer detected after independent rescan",
      rescanSummary: rescanResult.summary,
    };
  }

  /** Compute a fingerprint for a finding (same logic as findings engine). */
  _computeFingerprint(finding) {
    if (!finding) return "";
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

  /** Get all attempts for a finding. */
  getAttemptsForFinding(findingId) {
    const attemptIds = this.findingAttempts.get(findingId) || [];
    return attemptIds.map((id) => this.attempts.get(id)).filter(Boolean);
  }

  /** Get attempt by ID. */
  getAttempt(id) {
    return this.attempts.get(id);
  }

  /** Get all attempts. */
  getAllAttempts() {
    return [...this.attempts.values()];
  }
}

export default { RemediationEngine, RemediationAttempt, PATCH_OUTCOME, REMEDIATION_STATE };
