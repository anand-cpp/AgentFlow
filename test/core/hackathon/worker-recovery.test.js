// Worker state recovery tests — worker restores task state after restart.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkerState, persistWorkerState, loadWorkerState,
  recordTask, updateTaskProgress, completeTaskInState,
} from "../../../src/core/hackathon/worker-state.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-worker-recovery-"));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

describe("Worker state recovery", () => {
  it("worker recovers task state after restart", async () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: ["src/index.js"],
    });
    updateTaskProgress(state, "task-1", 75, [{ kind: "note", value: "half done" }]);
    await persistWorkerState(dir, state);

    // Simulate restart: load state from disk.
    const result = loadWorkerState(dir, "worker-1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.workerId, "worker-1");
    assert.strictEqual(result.value.sessionRef, "sess-1");
    assert.ok(result.value.tasks["task-1"]);
    assert.strictEqual(result.value.tasks["task-1"].state, "assigned");
    assert.strictEqual(result.value.tasks["task-1"].progress, 75);
    assert.strictEqual(result.value.currentTaskId, "task-1");
    assert.deepStrictEqual(result.value.tasks["task-1"].filesOwned, ["src/index.js"]);
  });

  it("worker recovers completed task after restart", async () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    recordTask(state, {
      taskId: "task-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-12-01T00:00:00Z",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
      filesOwned: [],
    });
    completeTaskInState(state, "task-1");
    await persistWorkerState(dir, state);

    const result = loadWorkerState(dir, "worker-1");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.tasks["task-1"].state, "completed");
    assert.strictEqual(result.value.tasks["task-1"].progress, 100);
    assert.strictEqual(result.value.currentTaskId, null);
  });

  it("worker state is versioned", async () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    await persistWorkerState(dir, state);

    // Corrupt the version on disk.
    const file = path.join(dir, "worker-worker-1.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.version = 99;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    assert.throws(() => loadWorkerState(dir, "worker-1"), /version 99/);
  });

  it("worker state redacts secrets before persisting", async () => {
    const state = createWorkerState({
      workerId: "worker-1",
      sessionRef: "sess-1",
    });
    state.apiKey = "x";

    await persistWorkerState(dir, state);

    const file = path.join(dir, "worker-worker-1.json");
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes('"apiKey": "x"'), "apiKey should be redacted");
  });
});
