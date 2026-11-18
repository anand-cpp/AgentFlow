// Event log redaction tests — secrets are redacted before persistence.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { EventLog, readEvents } from "../../../src/core/events.js";

describe("Event log redaction", () => {
  it("redacts apiKey pattern in event payloads", async () => {
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
      title: "A",
      objective: "a",
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
      evidence: [{ kind: "note", value: "apiKey=sk-1234567890abcdef" }],
    });

    const { events } = readEvents({ file: log.file, limit: 100 });
    const progressEvent = events.find((e) => e.type === "hackathon.task_progress");
    assert.ok(progressEvent);
    const serialized = JSON.stringify(progressEvent);
    assert.ok(!serialized.includes("sk-1234567890abcdef"));
  });

  it("redacts password pattern in event payloads", async () => {
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
      title: "A",
      objective: "a",
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
      progress: 30,
      evidence: [{ kind: "note", value: "password=hunter2" }],
    });

    const { events } = readEvents({ file: log.file, limit: 100 });
    const progressEvent = events.find((e) => e.type === "hackathon.task_progress");
    assert.ok(progressEvent);
    const serialized = JSON.stringify(progressEvent);
    assert.ok(!serialized.includes("hunter2"));
  });
});
