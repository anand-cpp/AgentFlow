// Trivy scanner adapter.
// Runs Trivy for filesystem, dependency, secret, and IaC scanning.
// Supports JSON output (--format json).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ScannerAdapter, Finding, SEVERITY, CONFIDENCE, VERIFICATION_STATUS } from "./base.js";

const execFileAsync = promisify(execFile);

export class TrivyScanner extends ScannerAdapter {
  get id() { return "trivy"; }
  get name() { return "Trivy"; }
  get version() { return "trivy"; }
  get supportedArtifactTypes() { return ["filesystem", "git-repo", "secrets", "iac"]; }

  async checkPreconditions() {
    try {
      await execFileAsync("trivy", ["--version"], { timeout: 10000 });
      return { available: true };
    } catch {
      return { available: false, reason: "trivy binary not found or not executable" };
    }
  }

  async executeScanner(target, options = {}) {
    const scanType = options.scanType || "fs";
    const args = ["--format", "json", "--quiet", "--skip-dirs", "node_modules,.git,dist,build"];

    if (scanType === "fs") {
      args.push("fs", target);
    } else if (scanType === "config") {
      args.push("config", target);
    } else if (scanType === "secret") {
      args.push("secret", target);
    } else if (scanType === "image") {
      args.push("image", target);
    }

    const { stdout, stderr } = await execFileAsync("trivy", args, {
      timeout: options.timeoutMs || 600000,
      maxBuffer: 100 * 1024 * 1024,
    });

    return { stdout, stderr };
  }

  parseOutput(output) {
    const { stdout } = output;
    const findings = [];

    if (!stdout || stdout.trim() === "") return findings;

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      return [new Finding({
        scannerId: this.id,
        ruleId: "trivy-parse-error",
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.UNVERIFIED,
        title: "Trivy output could not be parsed",
        description: `Trivy produced output that could not be parsed as JSON: ${err.message}`,
        file: null,
        line: null,
        rawReport: stdout.slice(0, 2000),
        verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
      })];
    }

    const results = parsed.Results || [];
    for (const result of results) {
      const target = result.Target || null;
      const vulnerabilities = result.Vulnerabilities || [];
      const misconfigs = result.Misconfigurations || [];
      const secrets = result.Secrets || [];

      for (const vuln of vulnerabilities) {
        findings.push(new Finding({
          scannerId: this.id,
          ruleId: vuln.VulnerabilityID || "unknown",
          cve: vuln.VulnerabilityID || null,
          severity: this.normalizeSeverity(vuln.Severity || "UNKNOWN"),
          confidence: CONFIDENCE.CONFIRMED,
          title: vuln.Title || vuln.VulnerabilityID || "Trivy vulnerability",
          description: vuln.Description || "",
          rootCause: `Vulnerable package: ${vuln.PkgName}@${vuln.InstalledVersion}`,
          recommendedFix: vuln.FixedVersion ? `Update ${vuln.PkgName} to ${vuln.FixedVersion}` : null,
          file: target,
          line: null,
          dependencyPath: `${vuln.PkgName}@${vuln.InstalledVersion}`,
          evidence: {
            package: vuln.PkgName,
            installedVersion: vuln.InstalledVersion,
            fixedVersion: vuln.FixedVersion,
            references: vuln.References || [],
          },
          rawReport: vuln,
          scannerLocation: `${target}:${vuln.PkgName}@${vuln.InstalledVersion}`,
          verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
        }));
      }

      for (const misconfig of misconfigs) {
        findings.push(new Finding({
          scannerId: this.id,
          ruleId: misconfig.MisconfigurationID || misconfig.Check || "unknown",
          severity: this.normalizeSeverity(misconfig.Severity || "LOW"),
          confidence: CONFIDENCE.LIKELY,
          title: misconfig.Title || misconfig.Check || "Misconfiguration",
          description: misconfig.Description || "",
          rootCause: misconfig.Cause || null,
          recommendedFix: null,
          file: target,
          line: misconfig.MisconfigurationRange?.start?.line || null,
          dependencyPath: null,
          evidence: {
            check: misconfig.Check,
            match: misconfig.Match || null,
          },
          rawReport: misconfig,
          scannerLocation: `${target}:${misconfig.MisconfigurationRange?.start?.line || ""}`,
          verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
        }));
      }

      for (const secret of secrets) {
        findings.push(new Finding({
          scannerId: this.id,
          ruleId: secret.RuleID || "secret-detection",
          severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.LIKELY,
          title: secret.Title || "Secret detected",
          description: `Potential secret exposed: ${secret.TargetName || secret.RuleID}`,
          rootCause: "Secret value found in source or config file",
          recommendedFix: "Remove the secret from source and rotate it",
          file: target,
          line: secret.StartLine || null,
          dependencyPath: null,
          evidence: {
            ruleId: secret.RuleID,
            targetName: secret.TargetName,
            match: secret.Match || null,
          },
          rawReport: secret,
          scannerLocation: `${target}:${secret.StartLine || ""}`,
          verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
        }));
      }
    }

    return findings;
  }
}

export default { TrivyScanner };
