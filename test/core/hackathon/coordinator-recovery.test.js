// Coordinator recovery tests — session restore and state validation after restart.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  recoverCoordinator, validateRecovery,
} from "../../../src/core/hackathon/coordinator-recovery.js";
import { createSession } from "../../../src/core/hackathon/session.js";
import { persistSession } from "../../../src/core/hackathon/session.js";
import { TaskGraph } from "../../../src/core/hackathon/task-graph.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-recovery-"));
after(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
});

describe("Coordinator recovery", () => {
  it("recovers a session from disk", async () => {
    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });
    session.status = "active";

    // Add a worker and task.
    session.workers["worker-1"] = {
      workerId: "worker-1",
      status: "connected",
      capabilities: ["node"],
      connectedAt: "2026-01-01T00:00:00Z",
      lastHeartbeat: "2026-01-01T00:00:00Z",
    };
    session.tasks["task-1"] = {
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      state: "assigned",
      progress: 50,
      version: 1,
    };

    await persistSession(dir, session);

    const result = await recoverCoordinator({
      stateDir: dir,
      sessionId: session.id,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.session.id, session.id);
    assert.strictEqual(result.report.sessionId, session.id);
    assert.strictEqual(result.report.workerCount, 1);
    assert.strictEqual(result.report.connectedWorkers, 0); // disconnected after restart
    assert.strictEqual(result.report.taskCount, 1);
    assert.strictEqual(result.report.expiredLeases, 0); // no leases were created
  });

  it("recovers with task state preserved", async () => {
    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    session.status = "active";

    session.workers["worker-1"] = {
      workerId: "worker-1",
      status: "connected",
      capabilities: ["node"],
    };
    session.tasks["task-1"] = {
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      assignedWorkerId: "worker-1",
      state: "assigned",
      leaseId: "lease-1",
      version: 1,
    };

    await persistSession(dir, session);

    const result = await recoverCoordinator({
      stateDir: dir,
      sessionId: session.id,
    });
    assert.strictEqual(result.ok, true);
    // Task state is preserved through recovery.
    assert.strictEqual(result.taskGraph.get("task-1").state, "assigned");
    assert.strictEqual(result.taskGraph.get("task-1").assignedWorkerId, "worker-1");
  });

  it("validates a clean recovery", () => {
    const taskGraph = new TaskGraph();
    taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      dependencies: [],
    });
    taskGraph.upsert({
      taskId: "task-2",
      title: "Task 2",
      objective: "Do task 2",
      dependencies: ["task-1"],
    });

    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const result = validateRecovery({ taskGraph, session });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.issues, []);
  });

  it("detects dependency cycles in recovery", () => {
    const taskGraph = new TaskGraph();
    taskGraph.upsert({
      taskId: "a", title: "A", objective: "a", dependencies: ["b"],
    });
    taskGraph.upsert({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
    });

    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const result = validateRecovery({ taskGraph, session });
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some((i) => i.type === "dependency_cycle"));
  });

  it("detects missing dependencies in recovery", () => {
    const taskGraph = new TaskGraph();
    taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      dependencies: ["nonexistent"],
    });

    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const result = validateRecovery({ taskGraph, session });
    assert.strictEqual(result.valid, false);
    assert.ok(result.issues.some((i) => i.type === "missing_dependency"));
  });

  it("rejects recovery of missing session", async () => {
    const result = await recoverCoordinator({
      stateDir: dir,
      sessionId: "nonexistent-session",
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects recovery with missing stateDir or sessionId", async () => {
    const r1 = await recoverCoordinator({});
    assert.strictEqual(r1.ok, false);

    const r2 = await recoverCoordinator({ stateDir: dir });
    assert.strictEqual(r2.ok, false);

    const r3 = await recoverCoordinator({ sessionId: "sess-1" });
    assert.strictEqual(r3.ok, false);
  });
});
