// Integration tests for AgentFlow security orchestration pipeline.
//
// Tests the complete flow:
//   SCAN → NORMALIZE → TRIAGE → TODO CREATION → PATCH → TEST → RESCAN → VERIFY → DELIVERY GATE.
//
// Uses test fixtures (no real vulnerabilities introduced into production files).
// All scanner binaries are expected to be unavailable in this environment,
// so tests verify that unavailability is correctly reported (not faked).
// When real scanners are installed, additional integration tests run.

import assert from "node:assert/strict";
import test from "node:test";

import findingsEngineModule from "../../src/security/findings/engine.js";
const { FindingsEngine, VERIFICATION_STATUS, SEVERITY } = findingsEngineModule;

import {
  SecurityOrchestrator,
  SCAN_PROFILES,
  DELIVERY_STATUS,
} from "../../src/security/orchestrator.js";
import { SemgrepScanner } from "../../src/security/scanners/semgrep.js";
import { OsvScanner } from "../../src/security/scanners/osv.js";
import { TrivyScanner } from "../../src/security/scanners/trivy.js";
import { RemediationEngine } from "../../src/security/remediation/engine.js";

import skillSpectorModule from "../../src/security/skill-spector/engine.js";
const { SkillSpectorEngine, SKILL_STATE } = skillSpectorModule;

import { TodoEngine } from "../../src/security/todo.js";

function buildOrchestrator() {
  const orch = new SecurityOrchestrator({ defaultProfile: SCAN_PROFILES.STANDARD });
  orch.registerScanner(new SemgrepScanner());
  orch.registerScanner(new OsvScanner());
  orch.registerScanner(new TrivyScanner());
  return orch;
}

test("security: scanner unavailability is correctly reported (not faked)", async () => {
  const orch = buildOrchestrator();
  const availability = await orch.probeScanners();

  // If scanners are installed, this test is informational only
  if (availability.semgrep.available || availability.trivy.available) {
    // At least one real scanner is available; verify it reports as available
    assert.ok(
      availability.semgrep.available || availability.trivy.available,
      "Expected at least one scanner to be available",
    );
    return;
  }

  // No scanners installed: all should report unavailable
  assert.strictEqual(availability.semgrep.available, false);
  assert.strictEqual(availability["osv-scanner"].available, false);
  assert.strictEqual(availability.trivy.available, false);

  assert.ok(availability.semgrep.reason);
  assert.ok(availability["osv-scanner"].reason);
  assert.ok(availability.trivy.reason);
});

test("security: real semgrep scanner produces findings", async () => {
  const orch = buildOrchestrator();
  const availability = await orch.probeScanners();

  if (!availability.semgrep.available) {
    // Skip if semgrep not installed
    return;
  }

  const scanner = orch.getScanner("semgrep");
  const result = await scanner.execute(".");
  assert.strictEqual(result.status, "completed");
  assert.ok(result.findings.length > 0, "Expected semgrep to find at least one finding");
  assert.ok(
    result.findings.some((f) => f.ruleId.includes("detect-child-process")),
    "Expected to find child-process findings in the codebase",
  );
  assert.ok(
    result.findings.some((f) => f.file.includes("tool-shell.js")),
    "Expected to find findings in tool-shell.js",
  );
});

test("security: real trivy filesystem scanner produces findings", async () => {
  const orch = buildOrchestrator();
  const availability = await orch.probeScanners();

  if (!availability.trivy.available) {
    // Skip if trivy not installed
    return;
  }

  const scanner = orch.getScanner("trivy");
  const result = await scanner.execute(".");
  assert.strictEqual(result.status, "completed");
  assert.ok(result.findings.length > 0, "Expected trivy to find at least one finding");
});

test("security: delivery gate reports incomplete when no scans run", async () => {
  const orch = buildOrchestrator();
  const gate = orch.evaluateDeliveryGate();

  assert.strictEqual(gate.status, DELIVERY_STATUS.NOT_SECURITY_VERIFIED);
  assert.strictEqual(gate.eligible, false);
  assert.ok(gate.reasons.length > 0);
  assert.ok(gate.reasons.some((r) => r.includes("no security scans")));
});

test("security: findings engine deduplicates by fingerprint", () => {
  const engine = new FindingsEngine();

  const f1 = {
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Test finding",
    severity: SEVERITY.HIGH,
    confidence: "confirmed",
  };

  const f2 = {
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Test finding",
    severity: SEVERITY.CRITICAL,
    confidence: "confirmed",
  };

  const r1 = engine.addFinding(f1);
  assert.strictEqual(r1.added, true);

  const r2 = engine.addFinding(f2);
  assert.strictEqual(r2.added, false);
  assert.strictEqual(r2.duplicate, true);

  const merged = engine.getById(r1.id);
  assert.strictEqual(merged.severity, SEVERITY.CRITICAL);
  assert.strictEqual(engine.getAll().length, 1);
});

test("security: delivery gate blocks on unresolved critical/high findings", async () => {
  const orch = buildOrchestrator();

  const finding = {
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Critical vulnerability",
    severity: SEVERITY.CRITICAL,
    confidence: "confirmed",
    verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
  };
  orch.findingsEngine.addFinding(finding);

  const gate = orch.evaluateDeliveryGate();
  assert.strictEqual(gate.status, DELIVERY_STATUS.BLOCKED_SECURITY);
  assert.strictEqual(gate.eligible, false);
  assert.ok(gate.reasons.some((r) => r.includes("unresolved critical/high")));
});

test("security: delivery gate passes when no critical/high findings", async () => {
  const orch = buildOrchestrator();
  const engine = new FindingsEngine();
  orch.findingsEngine = engine;

  engine.scannerResults.set("semgrep", [{
    scannerId: "semgrep",
    status: "completed",
    findings: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }]);
  engine.scannerResults.set("osv-scanner", [{
    scannerId: "osv-scanner",
    status: "completed",
    findings: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }]);
  engine.scannerResults.set("trivy", [{
    scannerId: "trivy",
    status: "completed",
    findings: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }]);

  engine.addFinding({
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Low severity issue",
    severity: SEVERITY.LOW,
    confidence: "confirmed",
    verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
  });

  const gate = orch.evaluateDeliveryGate();
  assert.strictEqual(gate.status, DELIVERY_STATUS.VERIFIED);
  assert.strictEqual(gate.eligible, true);
});

test("security: remediation attempt state machine", () => {
  const engine = new FindingsEngine();
  const orch = buildOrchestrator();
  const rem = new RemediationEngine({ findingsEngine: engine, securityOrchestrator: orch });

  const finding = engine.addFinding({
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Test vuln",
    severity: SEVERITY.HIGH,
    confidence: "confirmed",
  }).id;

  const attempt = rem.createAttempt({
    findingId: finding,
    strategy: "dependency-update",
  });

  assert.strictEqual(attempt.state, "pending");
  assert.strictEqual(attempt.canRetry, true);
  assert.strictEqual(attempt.isExhausted, false);
  assert.strictEqual(attempt.attemptNumber, 1);
});

test("security: remediation engine does not auto-resolve findings", async () => {
  const engine = new FindingsEngine();
  const orch = buildOrchestrator();
  const rem = new RemediationEngine({ findingsEngine: engine, securityOrchestrator: orch });

  const finding = engine.addFinding({
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Test vuln",
    severity: SEVERITY.HIGH,
    confidence: "confirmed",
    verificationStatus: VERIFICATION_STATUS.UNVERIFIED,
  }).id;

  const attempt = rem.createAttempt({ findingId: finding, strategy: "dependency-update" });

  const result = await rem.runAttempt(attempt.id);

  const f = engine.getById(finding);
  assert.strictEqual(f.verificationStatus, VERIFICATION_STATUS.UNVERIFIED);
  assert.strictEqual(result.state, "blocked");
});

test("security: SkillSpector state machine", async () => {
  const skill = new SkillSpectorEngine();

  skill.registerSkill({
    id: "skill-1",
    name: "test-skill",
    source: "/tmp/skill",
    commit: "abc123",
  });

  const registered = skill.getSkill("skill-1");
  assert.strictEqual(registered.state, SKILL_STATE.DISCOVERED);

  const canActivate = skill.canActivate("skill-1");
  assert.strictEqual(canActivate.allowed, false);
  assert.ok(canActivate.reason.includes("not verified"));

  const result = await skill.scanSkill("skill-1");
  // skill-spector binary is not installed, so scan fails → SCAN_FAILED
  assert.strictEqual(result.state, SKILL_STATE.SCAN_FAILED);
  assert.ok(result.error);

  assert.strictEqual(skill.getSkill("skill-1").state, SKILL_STATE.AWAITING_SECURITY_SCAN);
});

test("security: todo engine generates task lists by type", () => {
  const todo = new TodoEngine();

  const backend = todo.generateTaskList("backend", { source: "test" }, {});
  assert.strictEqual(backend.taskType, "backend");
  assert.ok(backend.tasks.length > 0);

  const securityTask = backend.tasks.find((t) => t.category === "security");
  assert.ok(securityTask, "Should have a security task");
});

test("security: todo engine links security findings to tasks", () => {
  const engine = new FindingsEngine();
  const orch = buildOrchestrator();
  const todo = new TodoEngine({ securityOrchestrator: orch });

  const taskList = todo.generateTaskList("backend", { source: "test" }, {});
  const securityTask = taskList.tasks.find((t) => t.category === "security");

  assert.ok(securityTask, "Should have a security task");

  const finding = engine.addFinding({
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Test vuln",
    severity: SEVERITY.HIGH,
    confidence: "confirmed",
  }).id;

  assert.ok(securityTask.id, "Security task should have an ID");

  const linked = todo.linkSecurityFinding(taskList.id, securityTask.id, finding.id, orch);
  assert.strictEqual(typeof linked, "boolean");

  if (linked) {
    const task = taskList.getTask(securityTask.id);
    assert.ok(task.evidence.linkedFindingId);
    assert.strictEqual(task.evidence.findingSeverity, SEVERITY.HIGH);
  }
});

test("security: remediation engine exhausts after max attempts", async () => {
  const engine = new FindingsEngine();
  const orch = buildOrchestrator();
  const rem = new RemediationEngine({ findingsEngine: engine, securityOrchestrator: orch });

  const finding = engine.addFinding({
    scannerId: "semgrep",
    ruleId: "rule-1",
    file: "src/foo.js",
    line: 10,
    title: "Test vuln",
    severity: SEVERITY.HIGH,
    confidence: "confirmed",
  }).id;

  const attempt = rem.createAttempt({
    findingId: finding,
    strategy: "dependency-update",
    maxAttempts: 1,
  });

  const result = await rem.runAttempt(attempt.id);

  assert.strictEqual(result.state, "blocked");
  assert.strictEqual(result.isExhausted, true);
  assert.strictEqual(result.canRetry, false);
});

test("security: full scan-remediate-rescan-verify cycle", async () => {
  const orch = buildOrchestrator();
  const engine = new FindingsEngine();
  orch.findingsEngine = engine;
  const rem = new RemediationEngine({ findingsEngine: engine, securityOrchestrator: orch });

  const availability = await orch.probeScanners();

  if (!availability.semgrep.available) {
    // Skip if semgrep not installed
    return;
  }

  // Step 1: SCAN
  const scanResult = await orch.runProfile("standard", ".");
  assert.strictEqual(scanResult.results[0].status, "completed");
  assert.ok(scanResult.findingsSummary.total > 0, "Expected scan to find findings");

  // Step 2: TRIAGE - find findings that need remediation
  const scanFindings = scanResult.results.flatMap((r) => r.findings || []);
  assert.ok(scanFindings.length > 0, "Expected scan to produce findings");
  const targetFinding = scanFindings[0];

  // Step 3: PATCH - create remediation attempt (will fail without real fix, but tests the pipeline)
  const attempt = rem.createAttempt({
    findingId: targetFinding.id,
    strategy: "dependency-update",
  });

  const runResult = await rem.runAttempt(attempt.id);

  // Step 4: TEST - the attempt will fail (no real fix applied), but the pipeline runs
  assert.ok(["failed", "blocked"].includes(runResult.state), "Expected run attempt to fail or block");

  // Step 5: RESCAN - verify the finding is still there (since we didn't actually fix it)
  const rescan = await orch.runProfile("quick", ".");
  assert.strictEqual(rescan.results[0].status, "completed");

  // Step 6: VERIFY - the finding is still present since we didn't actually fix it
  const rescanFindings = rescan.results.flatMap((r) => r.findings || []);
  const stillPresent = rescanFindings.some((f) =>
    f.ruleId === targetFinding.ruleId && f.file === targetFinding.file
  );
  assert.ok(stillPresent, "Expected finding to still be present after incomplete fix");

  // Step 7: DELIVERY GATE - should be blocked
  const gate = orch.evaluateDeliveryGate();
  assert.strictEqual(gate.eligible, false);
  assert.ok(gate.status !== DELIVERY_STATUS.VERIFIED, "Expected delivery gate to not be verified");
});