// Worker pre-flight capability tests.
//
// Verifies that runPreflight produces a structured CapabilityReport with
// hardware, environment, GitHub, provider, and execution checks. Uses real
// system calls where available and gracefully handles missing tools.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPreflight, CapabilityReport } from "../../../src/core/hackathon/preflight.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-preflight-"));
after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("preflight capability assessment", () => {
  it("produces a complete CapabilityReport", async () => {
    const report = await runPreflight({
      deviceId: "test-device-1",
      sessionId: "test-session-1",
      workspaceRoot: tmpDir,
    });

    assert.ok(report instanceof CapabilityReport);
    assert.strictEqual(report.deviceId, "test-device-1");
    assert.strictEqual(report.sessionId, "test-session-1");
    assert.ok(report.checkedAt);
    assert.ok(report.overall);
  });

  it("collects hardware info", async () => {
    const report = await runPreflight({
      deviceId: "test-device-2",
      sessionId: "test-session-2",
      workspaceRoot: tmpDir,
    });

    assert.ok(report.hardware);
    assert.ok(report.hardware.platform);
    assert.ok(report.hardware.arch);
    assert.ok(Number.isInteger(report.hardware.cpus));
    assert.ok(report.hardware.totalMem > 0);
    assert.ok(report.hardware.nodeVersion);
  });

  it("collects environment info", async () => {
    const report = await runPreflight({
      deviceId: "test-device-3",
      sessionId: "test-session-3",
      workspaceRoot: tmpDir,
    });

    assert.ok(report.environment);
    assert.ok(report.environment.node);
    assert.ok(report.environment.git);
  });

  it("collects GitHub info (may be unauthenticated)", async () => {
    const report = await runPreflight({
      deviceId: "test-device-4",
      sessionId: "test-session-4",
      workspaceRoot: tmpDir,
    });

    assert.ok(report.github);
    assert.ok(typeof report.github.ghAvailable === "boolean");
    assert.ok(typeof report.github.canCommitLocally === "boolean");
    // Local commits always work without GitHub auth.
    assert.strictEqual(report.github.canCommitLocally, true);
  });

  it("performs a real execution test", async () => {
    const report = await runPreflight({
      deviceId: "test-device-5",
      sessionId: "test-session-5",
      workspaceRoot: tmpDir,
    });

    assert.ok(report.execution);
    assert.strictEqual(report.execution.commandExecution, true);
    assert.strictEqual(report.execution.fileCreate, true);
    assert.strictEqual(report.execution.fileRead, true);
    assert.strictEqual(report.execution.fileModify, true);
    assert.strictEqual(report.execution.cleanup, true);
    assert.ok(!report.execution.error);
  });

  it("marks execution test as critical", async () => {
    const report = await runPreflight({
      deviceId: "test-device-6",
      sessionId: "test-session-6",
      workspaceRoot: tmpDir,
    });

    const execCheck = report.checks.find((c) => c.name === "execution_test");
    assert.ok(execCheck);
    assert.strictEqual(execCheck.critical, true);
    assert.strictEqual(execCheck.status, "pass");
  });

  it("rejects missing deviceId", async () => {
    await assert.rejects(
      () => runPreflight({ sessionId: "s" }),
      /deviceId required/
    );
  });

  it("rejects missing sessionId", async () => {
    await assert.rejects(
      () => runPreflight({ deviceId: "d" }),
      /sessionId required/
    );
  });
});
