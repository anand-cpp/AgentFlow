// Parallel audit system tests.
//
// Verifies:
//   - AuditCoordinator runs streams concurrently with bounded concurrency
//   - AuditStreamResult captures findings, duration, errors
//   - Deduplication removes duplicate findings across streams
//   - Critical/high findings are identified
//   - Summary is accurate
//   - Each built-in audit runner produces expected findings

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuditCoordinator,
  AuditRunner,
  AuditStreamResult,
  createFinding,
  FINDING_SEVERITY,
  AUDIT_STREAM,
} from "../../../src/core/hackathon/audit-coordinator.js";
import {
  SecurityAuditRunner,
  FunctionalAuditRunner,
  ArchitectureAuditRunner,
  TestingAuditRunner,
  DependencyAuditRunner,
  DeploymentAuditRunner,
} from "../../../src/core/hackathon/audit-runners.js";

describe("AuditCoordinator", () => {
  it("runs all registered streams concurrently", async () => {
    const coord = new AuditCoordinator({ maxConcurrency: 2 });

    class TestRunner extends AuditRunner {
      async run() {
        return [createFinding({
          findingId: `test-${this.stream}`,
          stream: this.stream,
          severity: FINDING_SEVERITY.MEDIUM,
          title: `Test finding for ${this.stream}`,
          description: "test",
        })];
      }
    }

    coord.registerRunner(AUDIT_STREAM.SECURITY, new TestRunner({ stream: AUDIT_STREAM.SECURITY }));
    coord.registerRunner(AUDIT_STREAM.FUNCTIONAL, new TestRunner({ stream: AUDIT_STREAM.FUNCTIONAL }));

    const results = await coord.runAll();

    assert.strictEqual(results.length, 2);
    assert.ok(coord.isComplete());
    assert.ok(coord.getResult(AUDIT_STREAM.SECURITY));
    assert.ok(coord.getResult(AUDIT_STREAM.FUNCTIONAL));
    assert.strictEqual(coord.getResult(AUDIT_STREAM.SECURITY).findingCount, 1);
    assert.strictEqual(coord.getResult(AUDIT_STREAM.FUNCTIONAL).findingCount, 1);
  });

  it("reports errors from failing runners", async () => {
    const coord = new AuditCoordinator();

    class FailingRunner extends AuditRunner {
      async run() {
        throw new Error("runner failed");
      }
    }

    coord.registerRunner(AUDIT_STREAM.SECURITY, new FailingRunner({ stream: AUDIT_STREAM.SECURITY }));
    await coord.runAll();

    const result = coord.getResult(AUDIT_STREAM.SECURITY);
    assert.ok(result);
    assert.ok(result.error);
    assert.strictEqual(result.error.message, "runner failed");
    assert.strictEqual(result.findingCount, 0);
  });

  it("deduplicates findings across streams", async () => {
    const coord = new AuditCoordinator();

    class DupRunner1 extends AuditRunner {
      async run() {
        return [createFinding({
          findingId: "dup-1",
          stream: AUDIT_STREAM.SECURITY,
          severity: FINDING_SEVERITY.HIGH,
          title: "Duplicate finding",
          description: "test",
          file: "src/foo.js",
        })];
      }
    }
    class DupRunner2 extends AuditRunner {
      async run() {
        return [createFinding({
          findingId: "dup-2",
          stream: AUDIT_STREAM.SECURITY,
          severity: FINDING_SEVERITY.HIGH,
          title: "Duplicate finding",
          description: "test",
          file: "src/foo.js",
        })];
      }
    }

    coord.registerRunner(AUDIT_STREAM.SECURITY, new DupRunner1({ stream: AUDIT_STREAM.SECURITY }));
    coord.registerRunner(AUDIT_STREAM.FUNCTIONAL, new DupRunner2({ stream: AUDIT_STREAM.SECURITY }));
    await coord.runAll();

    const { unique, duplicates } = coord.deduplicateFindings();
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(duplicates.length, 1);
  });

  it("identifies critical and high findings", async () => {
    const coord = new AuditCoordinator();

    class CriticalRunner extends AuditRunner {
      async run() {
        return [
          createFinding({
            findingId: "crit-1",
            stream: AUDIT_STREAM.SECURITY,
            severity: FINDING_SEVERITY.CRITICAL,
            title: "Critical issue",
            description: "test",
          }),
          createFinding({
            findingId: "low-1",
            stream: AUDIT_STREAM.SECURITY,
            severity: FINDING_SEVERITY.LOW,
            title: "Low issue",
            description: "test",
          }),
        ];
      }
    }

    coord.registerRunner(AUDIT_STREAM.SECURITY, new CriticalRunner({ stream: AUDIT_STREAM.SECURITY }));
    await coord.runAll();

    const critical = coord.getCriticalFindings();
    assert.strictEqual(critical.length, 1);
    assert.strictEqual(critical[0].findingId, "crit-1");
  });

  it("returns accurate summary", async () => {
    const coord = new AuditCoordinator();

    class SummaryRunner extends AuditRunner {
      async run() {
        return [
          createFinding({
            findingId: "s-1",
            stream: AUDIT_STREAM.SECURITY,
            severity: FINDING_SEVERITY.CRITICAL,
            title: "Critical",
            description: "test",
          }),
          createFinding({
            findingId: "s-2",
            stream: AUDIT_STREAM.SECURITY,
            severity: FINDING_SEVERITY.HIGH,
            title: "High",
            description: "test",
          }),
        ];
      }
    }

    coord.registerRunner(AUDIT_STREAM.SECURITY, new SummaryRunner({ stream: AUDIT_STREAM.SECURITY }));
    await coord.runAll();

    const summary = coord.getSummary();
    assert.strictEqual(summary.totalFindings, 2);
    assert.strictEqual(summary.criticalFindings, 1);
    assert.strictEqual(summary.highFindings, 1);
    assert.strictEqual(summary.completedStreams, 1);
  });

  it("throws when running twice", async () => {
    const coord = new AuditCoordinator();

    class TestRunner extends AuditRunner {
      async run() { return []; }
    }

    coord.registerRunner(AUDIT_STREAM.SECURITY, new TestRunner({ stream: AUDIT_STREAM.SECURITY }));
    await coord.runAll();

    await assert.rejects(
      () => coord.runAll(),
      /already ran/
    );
  });
});

describe("AuditStreamResult", () => {
  it("computes finding counts correctly", () => {
    const result = new AuditStreamResult({
      stream: AUDIT_STREAM.SECURITY,
      findings: [
        createFinding({
          findingId: "f1",
          stream: AUDIT_STREAM.SECURITY,
          severity: FINDING_SEVERITY.CRITICAL,
          title: "Critical",
          description: "test",
        }),
        createFinding({
          findingId: "f2",
          stream: AUDIT_STREAM.SECURITY,
          severity: FINDING_SEVERITY.HIGH,
          title: "High",
          description: "test",
        }),
        createFinding({
          findingId: "f3",
          stream: AUDIT_STREAM.SECURITY,
          severity: FINDING_SEVERITY.LOW,
          title: "Low",
          description: "test",
        }),
      ],
      durationMs: 100,
    });

    assert.strictEqual(result.findingCount, 3);
    assert.strictEqual(result.criticalCount, 1);
    assert.strictEqual(result.highCount, 1);
    assert.strictEqual(result.durationMs, 100);
    assert.strictEqual(result.stream, AUDIT_STREAM.SECURITY);
  });
});

describe("Built-in audit runners", () => {
  it("SecurityAuditRunner detects exposed credentials", async () => {
    const runner = new SecurityAuditRunner({});
    const findings = await runner.run();

    // Should find the known exposed credential files.
    const exposed = findings.filter((f) => f.title.includes("Exposed credential"));
    assert.ok(exposed.length > 0, "should detect exposed credentials");
  });

  it("FunctionalAuditRunner checks critical modules exist", async () => {
    const runner = new FunctionalAuditRunner({});
    const findings = await runner.run();

    // All critical modules should exist, so no critical findings.
    const critical = findings.filter((f) => f.severity === FINDING_SEVERITY.CRITICAL);
    assert.strictEqual(critical.length, 0);
  });

  it("ArchitectureAuditRunner checks event types exist", async () => {
    const runner = new ArchitectureAuditRunner({});
    const findings = await runner.run();

    // All expected event types should exist, so no missing event findings.
    const missingEvents = findings.filter((f) => f.title.includes("Missing event type"));
    assert.strictEqual(missingEvents.length, 0);
  });

  it("TestingAuditRunner checks for test files", async () => {
    const runner = new TestingAuditRunner({});
    const findings = await runner.run();

    // Should not report missing tests for modules that have tests.
    const missingCoordinator = findings.find((f) => f.findingId === "test-missing-coordinator.js");
    assert.strictEqual(missingCoordinator, undefined);
  });

  it("DependencyAuditRunner checks lockfile and dev deps", async () => {
    const runner = new DependencyAuditRunner({});
    const findings = await runner.run();

    // package-lock.json exists and eslint/typescript are dev deps, so no findings.
    const missingLockfile = findings.find((f) => f.findingId === "dep-missing-lockfile");
    assert.strictEqual(missingLockfile, undefined);
  });

  it("DeploymentAuditRunner checks bin and README", async () => {
    const runner = new DeploymentAuditRunner({});
    const findings = await runner.run();

    // bin/agentflow.js and README.md exist, so no findings.
    const missingBin = findings.find((f) => f.findingId === "deploy-missing-bin");
    assert.strictEqual(missingBin, undefined);
    const missingReadme = findings.find((f) => f.findingId === "deploy-missing-readme");
    assert.strictEqual(missingReadme, undefined);
  });
});
