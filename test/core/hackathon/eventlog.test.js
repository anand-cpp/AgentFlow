// Event log integration tests — hackathon events recorded in EventLog.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { EventLog, readEvents } from "../../../src/core/events.js";

describe("Event log integration", () => {
  it("emits coordinator events to the event log", async () => {
    const log = new EventLog({ enabled: true });
    const coord = new CoordinatorRuntime({ eventLog: log });

    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    // Read back the events from the log.
    const { events } = readEvents({ file: log.file, limit: 50 });
    const types = events.map((e) => e.type);

    assert.ok(types.includes("hackathon.worker_registered"));
    assert.ok(types.includes("hackathon.worker_connected"));
  });

  it("emits task lifecycle events to the event log", async () => {
    const log = new EventLog({ enabled: true });
    const coord = new CoordinatorRuntime({ eventLog: log });

    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-1",
      evidence: [{ kind: "commit", value: "abc123" }],
      testResults: [],
    });

    const { events } = readEvents({ file: log.file, limit: 100 });
    const types = events.map((e) => e.type);

    assert.ok(types.includes("hackathon.task_dispatched"));
    assert.ok(types.includes("hackathon.task_accepted"));
    assert.ok(types.includes("hackathon.task_started"));
    assert.ok(types.includes("hackathon.task_completed"));
  });

  it("events contain session and worker identity", async () => {
    const log = new EventLog({ enabled: true });
    const coord = new CoordinatorRuntime({ eventLog: log });

    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    const { events } = readEvents({ file: log.file, limit: 50 });
    const connectEvent = events.find((e) => e.type === "hackathon.worker_connected");

    assert.ok(connectEvent);
    // sessionId is redacted by the event log's secret redaction
    // (sessionId matches SENSITIVE_KEYS), so check presence not value.
    assert.ok(connectEvent.sessionId);
    assert.strictEqual(connectEvent.workerId, "worker-1");
    assert.ok(connectEvent.ts);
    assert.ok(connectEvent.seq);
  });

  it("event log redacts secrets from payloads", async () => {
    const log = new EventLog({ enabled: true });
    const coord = new CoordinatorRuntime({ eventLog: log });

    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });

    // Report progress with a secret-like value in evidence.
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "Task 1",
      objective: "Do task 1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskProgress({
      taskId: "task-1",
      workerId: "worker-1",
      progress: 50,
      evidence: [{ kind: "note", value: "token=sk-1234567890abcdef" }],
    });

    const { events } = readEvents({ file: log.file, limit: 100 });
    const progressEvent = events.find((e) => e.type === "hackathon.task_progress");

    assert.ok(progressEvent);
    // The evidence value should be redacted (sk- pattern matched).
    assert.ok(!JSON.stringify(progressEvent).includes("sk-1234567890abcdef"));
  });
});
