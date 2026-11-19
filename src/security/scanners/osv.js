// OSV-Scanner adapter.
// Scans dependency lockfiles for known vulnerabilities using google/osv-scanner.
// Supports JSON output (--json) and SARIF (--sarif-format).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { ScannerAdapter, Finding, SEVERITY, CONFIDENCE, VERIFICATION_STATUS } from "./base.js";

const execFileAsync = promisify(execFile);

export class OsvScanner extends ScannerAdapter {
  get id() { return "osv-scanner"; }
  get name() { return "OSV-Scanner"; }
  get version() { return "osv-scanner"; }
  get supportedArtifactTypes() { return ["lockfile", "dependencies", "package-lock", "requirements"]; }

  async checkPreconditions() {
    try {
      await execFileAsync("osv-scanner", ["--version"], { timeout: 10000 });
      return { available: true };
    } catch {
      return { available: false, reason: "osv-scanner binary not found or not executable" };
    }
  }

  async executeScanner(target, options = {}) {
    const args = ["--json", "--skip-git"];
    // Lockfile mode if target is a lockfile
    const targetStat = fs.statSync(target);
    if (targetStat.isFile()) args.push("--lockfile", target);
    else args.push(target);

    const { stdout, stderr } = await execFileAsync("osv-scanner", args, {
      timeout: options.timeoutMs || 300000,
      maxBuffer: 50 * 1024 * 1024,
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
        ruleId: "osv-parse-error",
        severity: SEVERITY.INFO,
        confidence: CONFIDENCE.UNVERIFIED,
        title: "OSV-Scanner output could not be parsed",
        description: `OSV-Scanner produced output that could not be parsed as JSON: ${err.message}`,
        file: null,
        line: null,
        rawReport: stdout.slice(0, 2000),
        verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
      })];
    }

    const results = parsed.results || [];
    for (const result of results) {
      const packages = result.packages || [];
      const source = result.source || { type: "lockfile", path: null };
      const targetPath = source.path || null;

      for (const pkg of packages) {
        const vulns = pkg.vulnerabilities || [];
        for (const vuln of vulns) {
          const finding = new Finding({
            scannerId: this.id,
            ruleId: vuln.id || "unknown",
            cve: vuln.id || null,
            severity: this.normalizeSeverity(vuln.severity || "low"),
            confidence: CONFIDENCE.CONFIRMED, // OSV data is authoritative
            title: vuln.alias || vuln.id || "Dependency vulnerability",
            description: vuln.summary || vuln.details || "",
            rootCause: `Vulnerable dependency: ${pkg.package.name}@${pkg.package.version}`,
            recommendedFix: vuln.fixes?.[0]?.versions?.[0] ? `Update ${pkg.package.name} to ${vuln.fixes[0].versions[0]}` : null,
            file: targetPath,
            line: null,
            dependencyPath: `${pkg.package.name}@${pkg.package.version}`,
            evidence: {
              package: pkg.package.name,
              version: pkg.package.version,
              vulnerabilityId: vuln.id,
              aliases: vuln.aliases || [],
              references: vuln.references || [],
            },
            rawReport: vuln,
            scannerLocation: `${targetPath || ""}:${pkg.package.name}@${pkg.package.version}`,
            verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
          });
          findings.push(finding);
        }
      }
    }

    return findings;
  }
}

export default { OsvScanner };
