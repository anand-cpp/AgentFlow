// Hackathon security tests — authentication, authorization, replay protection.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import {
  revokeInvitation, NonceTracker, createNonce,
} from "../../../src/core/hackathon/auth.js";
import { redactVerified } from "../../../src/core/redact.js";

describe("Authentication", () => {
  it("rejects uninvited worker registration", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.registerWorker({
      workerId: "uninvited-worker",
      token: "some-token",
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects invalid invitation token", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const result = await coord.registerWorker({
      workerId: "worker-1",
      token: "invalid-token",
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects revoked invitation", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    // Revoke the worker's invitation directly.
    const record = coord.workers.get("worker-1");
    revokeInvitation(record);
    const result = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, false);
  });

  it("accepts valid invitation", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const invite = coord.createInvitation({ workerId: "worker-1" });
    const result = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    assert.strictEqual(result.ok, true);
  });
});

describe("Replay protection (nonce)", () => {
  it("accepts a fresh nonce once", () => {
    const tracker = new NonceTracker();
    const nonce = createNonce();
    assert.strictEqual(tracker.use(nonce), true);
    assert.strictEqual(tracker.use(nonce), false); // replay rejected
  });

  it("expires nonces after TTL", () => {
    const tracker = new NonceTracker({ ttlMs: 1 });
    const nonce = createNonce();
    assert.strictEqual(tracker.use(nonce), true);
    // Wait past TTL.
    const start = Date.now();
    while (Date.now() - start < 15) { /* spin */ }
    tracker.gc();
    // After gc, the nonce is removed; can be used again.
    assert.strictEqual(tracker.use(nonce), true);
  });

  it("tracks nonce count", () => {
    const tracker = new NonceTracker();
    tracker.use(createNonce());
    tracker.use(createNonce());
    assert.strictEqual(tracker.size(), 2);
  });
});

describe("Authorization — task ownership", () => {
  it("rejects task acceptance by wrong worker", async () => {
    const coord = new CoordinatorRuntime();
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
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.acceptTask({ taskId: "task-1", workerId: "worker-2" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects completion by wrong worker", async () => {
    const coord = new CoordinatorRuntime();
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
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.acceptTask({ taskId: "task-1", workerId: "worker-1" });
    await coord.taskStarted({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.completeTask({
      taskId: "task-1",
      workerId: "worker-2",
      evidence: [],
      testResults: [],
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects lease renewal by wrong worker", async () => {
    const coord = new CoordinatorRuntime();
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
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });
    await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });

    const result = await coord.renewLease({ taskId: "task-1", workerId: "worker-2" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects dispatch to unconnected worker", async () => {
    const coord = new CoordinatorRuntime();
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
    coord.workerDisconnected({ workerId: "worker-1" });

    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "A",
      objective: "a",
      assignedWorkerId: "worker-1",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    const result = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });
});

describe("Secret redaction", () => {
  it("redacts credential-like fields from payloads", () => {
    // Use short obviously-fake values (<12 chars) so the secret scanner does
    // not flag them, but secret-named fields still match SENSITIVE_KEYS and
    // get redacted by redactDeep.
    const dirty = {
      apiKey: "x",
      password: "y",
      token: "z",
      safe: "public value",
      nested: { key: "w", inner: "ok" },
    };
    const clean = redactVerified(JSON.parse(JSON.stringify(dirty)));
    assert.ok(clean);
    assert.strictEqual(clean.apiKey, "***");
    assert.strictEqual(clean.password, "***");
    assert.strictEqual(clean.token, "***");
    assert.strictEqual(clean.safe, "public value");
    assert.strictEqual(clean.nested.inner, "ok");
  });
});

describe("Session membership", () => {
  it("rejects operations with no active session", () => {
    const coord = new CoordinatorRuntime();
    const result = coord.createInvitation({ workerId: "worker-1" });
    assert.strictEqual(result.ok, false);
  });

  it("rejects heartbeat for unknown worker", () => {
    const coord = new CoordinatorRuntime();
    const result = coord.heartbeat({ workerId: "unknown" });
    assert.strictEqual(result.ok, false);
  });
});
