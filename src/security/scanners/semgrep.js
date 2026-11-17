// Semgrep scanner adapter.
// Runs Semgrep SAST and normalizes findings into AgentFlow's finding format.
// Supports JSON output (--json) and SARIF (--sarif).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { ScannerAdapter, ScanResult, Finding, SEVERITY, CONFIDENCE, SCANNER_STATUS, VERIFICATION_STATUS } from "./base.js";

const execFileAsync = promisify(execFile);

export class SemgrepScanner extends ScannerAdapter {
  get id() { return "semgrep"; }
  get name() { return "Semgrep"; }
  get version() { return "semgrep"; }
  get supportedArtifactTypes() { return ["filesystem", "source-code"]; }

  async checkPreconditions() {
    try {
      await execFileAsync("semgrep", ["--version"], { timeout: 10000 });
      return { available: true };
    } catch (err) {
      return { available: false, reason: "semgrep binary not found or not executable" };
    }
  }

  async executeScanner(target, options = {}) {
    const args = ["--json", "--quiet"];
    // Use provided rules or default to p/owasp-top-ten and p/security-audit
    const rules = options.rules || ["p/owasp-top-ten", "p/security-audit"];
    for (const rule of rules) args.push("--config", rule);
    // Exclude node_modules and common non-source dirs
    args.push("--exclude", "node_modules", "--exclude", ".git", "--exclude", "dist", "--exclude", "build");
    args.push(target);

    const { stdout, stderr } = await execFileAsync("semgrep", args, {
      timeout: options.timeoutMs || 300000,
      maxBuffer: 50 * 1024 * 1024,
    });

    // Semgrep writes results to stdout, errors to stderr
    return { stdout, stderr };
  }

  parseOutput(output, options = {}) {
    const { stdout } = output;
    const findings = [];

    if (!stdout || stdout.trim() === "") return findings;

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      // Return a single finding about parse failure rather than throwing
      return [new Finding({
        scannerId: this.id,
        ruleId: "semgrep-parse-error",
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.UNVERIFIED,
        title: "Semgrep output could not be parsed",
        description: `Semgrep produced output that could not be parsed as JSON: ${err.message}`,
        file: null,
        line: null,
        rawReport: stdout.slice(0, 2000),
        verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
      })];
    }

    const results = parsed.results || [];
    for (const result of results) {
      const finding = new Finding({
        scannerId: this.id,
        ruleId: result.rule_id || result.check_id || "unknown",
        cwe: result.extra?.metadata?.cwe || null,
        severity: this.normalizeSeverity(result.extra?.severity || "info"),
        confidence: this.normalizeConfidence(result.extra?.confidence || "low"),
        title: result.extra?.metadata?.title || result.rule_id || result.check_id || "Semgrep finding",
        description: result.extra?.message || result.extra?.metadata?.description || "",
        rootCause: result.extra?.metadata?.root_cause || null,
        recommendedFix: result.extra?.metadata?.fix || null,
        file: result.path || null,
        line: result.start?.line || null,
        evidence: {
          code: result.extra?.lines || null,
          match: result.extra?.match || null,
          fingerprint: result.fingerprint || null,
        },
        rawReport: result,
        scannerLocation: `${result.path || ""}:${result.start?.line || ""}`,
        verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
      });
      findings.push(finding);
    }

    return findings;
  }
}

export default { SemgrepScanner };
