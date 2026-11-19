// Coordinator recovery with stateDir tests — recovery works with stateDir.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { recoverCoordinator } from "../../../src/core/hackathon/coordinator-recovery.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-recovery-statedir-"));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

describe("Coordinator recovery with stateDir", () => {
  it("recovery works with stateDir configured", async () => {
    const coord = new CoordinatorRuntime({ stateDir: dir });
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const sessionId = coord.session.id;

    // Recover from disk.
    const result = await recoverCoordinator({
      stateDir: dir,
      sessionId,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.id, sessionId);
    assert.strictEqual(result.session.status, "active");
  });

  it("recovery rejects missing stateDir", async () => {
    const result = await recoverCoordinator({
      sessionId: "sess-1",
    });
    assert.strictEqual(result.ok, false);
  });

  it("recovery rejects missing sessionId", async () => {
    const result = await recoverCoordinator({
      stateDir: dir,
    });
    assert.strictEqual(result.ok, false);
  });
});
