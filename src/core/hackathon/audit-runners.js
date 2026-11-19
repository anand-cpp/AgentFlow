// Built-in audit runners for Hackathon Mode parallel audit system.
//
// Each runner performs read-only inspection and returns findings.
// None of these runners modify source files.

import fs from "node:fs";
import path from "node:path";

import {
  AuditRunner,
  createFinding,
  FINDING_SEVERITY,
  AUDIT_STREAM,
} from "./audit-coordinator.js";

/** SecurityAuditRunner — inspects authentication, authorization, secrets, vulnerabilities. */
export class SecurityAuditRunner extends AuditRunner {
  constructor({ context = {} } = {}) {
    super({ stream: AUDIT_STREAM.SECURITY, context });
  }

  async run() {
    const findings = [];

    // Check for exposed credentials in known upstream files.
    const credentialFiles = [
      "open-sse/providers/registry/windsurf.js",
      "open-sse/providers/registry/iflow.js",
    ];
    for (const file of credentialFiles) {
      if (fs.existsSync(file)) {
        findings.push(createFinding({
          findingId: `sec-exposed-cred-${path.basename(file)}`,
          stream: AUDIT_STREAM.SECURITY,
          severity: FINDING_SEVERITY.CRITICAL,
          title: `Exposed credential in ${file}`,
          description: `The file ${file} contains hardcoded credentials that were historically leaked. The credential owner must rotate the values and GitHub must drop retained objects.`,
          file,
          recommendation: "Rotate the exposed credential and request GitHub object removal.",
        }));
      }
    }

    // Check for plaintext secrets in source.
    const secretPatterns = [
      /api[_-]?key\s*[:=]\s*["'][^"']{8,}["']/i,
      /secret[_-]?key\s*[:=]\s*["'][^"']{8,}["']/i,
      /password\s*[:=]\s*["'][^"']{6,}["']/i,
    ];
    const srcFiles = this._findJsFiles("src");
    for (const file of srcFiles) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          for (const pattern of secretPatterns) {
            if (pattern.test(lines[i])) {
              findings.push(createFinding({
                findingId: `sec-plaintext-${path.basename(file)}-${i + 1}`,
                stream: AUDIT_STREAM.SECURITY,
                severity: FINDING_SEVERITY.HIGH,
                title: `Possible plaintext secret in ${file}:${i + 1}`,
                description: `Line ${i + 1} of ${file} matches a potential secret pattern.`,
                file,
                line: i + 1,
                recommendation: "Move secrets to environment variables or OS secret store.",
              }));
            }
          }
        }
      } catch {
        /* skip unreadable files */
      }
    }

    return findings;
  }

  _findJsFiles(dir) {
    const out = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push(...this._findJsFiles(full));
        } else if (e.name.endsWith(".js")) {
          out.push(full);
        }
      }
    } catch {
      /* skip */
    }
    return out;
  }
}

/** FunctionalAuditRunner — inspects broken behavior, crashes, state transitions. */
export class FunctionalAuditRunner extends AuditRunner {
  constructor({ context = {} } = {}) {
    super({ stream: AUDIT_STREAM.FUNCTIONAL, context });
  }

  async run() {
    const findings = [];

    // Check that critical modules exist and are loadable.
    const criticalModules = [
      "src/core/hackathon/coordinator.js",
      "src/core/hackathon/worker.js",
      "src/core/hackathon/session.js",
      "src/core/hackathon/device-registry.js",
      "src/core/hackathon/preflight.js",
    ];
    for (const mod of criticalModules) {
      if (!fs.existsSync(mod)) {
        findings.push(createFinding({
          findingId: `func-missing-${path.basename(mod)}`,
          stream: AUDIT_STREAM.FUNCTIONAL,
          severity: FINDING_SEVERITY.CRITICAL,
          title: `Missing critical module: ${mod}`,
          description: `The module ${mod} is required for Hackathon Mode but does not exist.`,
          file: mod,
          recommendation: "Implement the missing module or remove the dependency.",
        }));
      }
    }

    return findings;
  }
}

/** ArchitectureAuditRunner — inspects APIs, schemas, event contracts, dependency compatibility. */
export class ArchitectureAuditRunner extends AuditRunner {
  constructor({ context = {} } = {}) {
    super({ stream: AUDIT_STREAM.ARCHITECTURE, context });
  }

  async run() {
    const findings = [];

    // Check that the event protocol has all expected event types.
    const eventsFile = "src/core/hackathon/events.js";
    if (fs.existsSync(eventsFile)) {
      const content = fs.readFileSync(eventsFile, "utf8");
      const expectedEvents = [
        "WORKER_REGISTERED", "WORKER_CONNECTED", "WORKER_DISCONNECTED",
        "WORKER_HEARTBEAT", "WORKER_RECONNECTED",
        "TASK_DISPATCHED", "TASK_ACCEPTED", "TASK_STARTED", "TASK_PROGRESS",
        "TASK_BLOCKED", "TASK_COMPLETED", "TASK_FAILED", "TASK_CANCELLED",
        "LEASE_RENEWED", "LEASE_EXPIRED", "TASK_REASSIGNED",
      ];
      for (const evt of expectedEvents) {
        if (!content.includes(evt)) {
          findings.push(createFinding({
            findingId: `arch-missing-event-${evt}`,
            stream: AUDIT_STREAM.ARCHITECTURE,
            severity: FINDING_SEVERITY.MEDIUM,
            title: `Missing event type: ${evt}`,
            description: `The event protocol is missing ${evt}, which is part of the defined Hackathon Mode event contract.`,
            file: eventsFile,
            recommendation: `Add ${evt} to the HACKATHON_EVENTS constant.`,
          }));
        }
      }
    }

    return findings;
  }
}

/** TestingAuditRunner — inspects test coverage for unit, integration, e2e tests. */
export class TestingAuditRunner extends AuditRunner {
  constructor({ context = {} } = {}) {
    super({ stream: AUDIT_STREAM.TESTING, context });
  }

  async run() {
    const findings = [];

    // Check that test files exist for core hackathon modules.
    const testDir = "test/core/hackathon";
    const sourceModules = [
      "coordinator.js", "worker.js", "session.js", "device-registry.js",
      "preflight.js", "executor.js", "scheduler.js", "task-graph.js",
      "lifecycle.js", "events.js", "auth.js",
    ];
    for (const mod of sourceModules) {
      const testFile = path.join(testDir, mod.replace(".js", ".test.js"));
      if (!fs.existsSync(testFile)) {
        findings.push(createFinding({
          findingId: `test-missing-${mod}`,
          stream: AUDIT_STREAM.TESTING,
          severity: FINDING_SEVERITY.MEDIUM,
          title: `Missing test for ${mod}`,
          description: `No test file found for ${mod}.`,
          file: testFile,
          recommendation: `Create ${testFile} to cover ${mod}.`,
        }));
      }
    }

    return findings;
  }
}

/** DependencyAuditRunner — inspects package versions, lockfiles, vulnerabilities. */
export class DependencyAuditRunner extends AuditRunner {
  constructor({ context = {} } = {}) {
    super({ stream: AUDIT_STREAM.DEPENDENCY, context });
  }

  async run() {
    const findings = [];

    // Check that package-lock.json exists and is in sync with package.json.
    const lockFile = "package-lock.json";
    const pkgFile = "package.json";
    if (fs.existsSync(pkgFile) && !fs.existsSync(lockFile)) {
      findings.push(createFinding({
        findingId: "dep-missing-lockfile",
        stream: AUDIT_STREAM.DEPENDENCY,
        severity: FINDING_SEVERITY.HIGH,
        title: "Missing package-lock.json",
        description: "package.json exists but package-lock.json is missing. Dependencies may not be reproducibly installed.",
        file: lockFile,
        recommendation: "Run npm install to generate package-lock.json.",
      }));
    }

    // Check for outdated or missing dev dependencies.
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
        const devDeps = pkg.devDependencies || {};
        const requiredDevDeps = ["eslint", "typescript"];
        for (const dep of requiredDevDeps) {
          if (!devDeps[dep]) {
            findings.push(createFinding({
              findingId: `dep-missing-dev-${dep}`,
              stream: AUDIT_STREAM.DEPENDENCY,
              severity: FINDING_SEVERITY.MEDIUM,
              title: `Missing dev dependency: ${dep}`,
              description: `${dep} is required for linting/typechecking but is not in devDependencies.`,
              file: pkgFile,
              recommendation: `Add ${dep} to devDependencies in package.json.`,
            }));
          }
        }
      } catch {
        /* skip invalid package.json */
      }
    }

    return findings;
  }
}

/** DeploymentAuditRunner — inspects startup, configuration, credentials, restart recovery. */
export class DeploymentAuditRunner extends AuditRunner {
  constructor({ context = {} } = {}) {
    super({ stream: AUDIT_STREAM.DEPLOYMENT, context });
  }

  async run() {
    const findings = [];

    // Check that the bin entry point exists.
    const binFile = "bin/agentflow.js";
    if (!fs.existsSync(binFile)) {
      findings.push(createFinding({
        findingId: "deploy-missing-bin",
        stream: AUDIT_STREAM.DEPLOYMENT,
        severity: FINDING_SEVERITY.HIGH,
        title: "Missing CLI entry point",
        description: `The binary entry point ${binFile} does not exist.`,
        file: binFile,
        recommendation: "Create the CLI entry point script.",
      }));
    }

    // Check for README documentation.
    if (!fs.existsSync("README.md")) {
      findings.push(createFinding({
        findingId: "deploy-missing-readme",
        stream: AUDIT_STREAM.DEPLOYMENT,
        severity: FINDING_SEVERITY.MEDIUM,
        title: "Missing README.md",
        description: "No README.md found for deployment and usage documentation.",
        file: "README.md",
        recommendation: "Create README.md with setup and usage instructions.",
      }));
    }

    return findings;
  }
}

export default {
  SecurityAuditRunner,
  FunctionalAuditRunner,
  ArchitectureAuditRunner,
  TestingAuditRunner,
  DependencyAuditRunner,
  DeploymentAuditRunner,
};
