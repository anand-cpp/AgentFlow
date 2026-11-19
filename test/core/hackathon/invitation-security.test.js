// Invitation security and onboarding tests.
//
// Verifies:
//   - Exactly the requested number of unique invitations are generated.
//   - Each invitation is cryptographically unique (no shared codes).
//   - Invitations are single-use (consumed on registration).
//   - Expired invitations are rejected.
//   - Revoked invitations are rejected.
//   - Invalid/malformed invitations are rejected.
//   - Two devices using the same invitation concurrently: exactly one succeeds.
//   - Unapproved devices cannot receive project tasks.
//   - Additional invitations can be generated after session creation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import {
  DEVICE_STATUS,
} from "../../../src/core/hackathon/device-registry.js";

describe("invitation security and onboarding", () => {
  it("generates exactly the requested number of unique invitations", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp",
    });

    const workerIds = ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"];
    const result = coord.createInvitations({ workerIds });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.invitations.length, 5);

    const tokens = result.data.invitations.map((i) => i.token);
    const uniqueTokens = new Set(tokens);
    assert.strictEqual(uniqueTokens.size, 5, "all tokens must be unique");

    // Every invitation has a different token.
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        assert.notStrictEqual(tokens[i], tokens[j]);
      }
    }
  });

  it("rejects duplicate workerIds in invitation batch", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const result = coord.createInvitations({ workerIds: ["worker-1", "worker-1"] });
    assert.strictEqual(result.ok, false);
  });

  it("consumes invitation token on registration (single-use)", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    const r1 = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    assert.strictEqual(r1.ok, true);

    // Same token cannot be used again.
    const r2 = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    assert.strictEqual(r2.ok, false);
    assert.ok(String(r2.error).includes("token mismatch"));
  });

  it("rejects expired invitation", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    // Create an invitation with a TTL that is already expired.
    const invite = coord.createInvitation({
      workerId: "worker-1",
      ttlMs: -1, // already expired
    });

    const r = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes("expired"));
  });

  it("rejects registration for revoked worker", async () => {
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

    // Revoke the worker (sets status to revoked, clears invitation token).
    await coord.revokeWorker({ workerId: "worker-1" });

    // Re-registration must fail because the worker is revoked.
    const r = await coord.registerWorker({
      workerId: "worker-1",
      token: invite.data.token,
      capabilities: ["node"],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes("revoked"));
  });

  it("rejects malformed invitation token", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    // Must invite first, then try with a malformed token.
    coord.createInvitation({ workerId: "worker-1" });

    const r = await coord.registerWorker({
      workerId: "worker-1",
      token: "short",
      capabilities: ["node"],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes("token mismatch"));
  });

  it("rejects registration for uninvited worker", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const r = await coord.registerWorker({
      workerId: "unknown-worker",
      token: "some-token",
      capabilities: ["node"],
    });
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes("not invited"));
  });

  it("two devices using same invitation concurrently: exactly one succeeds", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const invite = coord.createInvitation({ workerId: "worker-1" });
    const token = invite.data.token;

    // Two concurrent registration attempts with the same token.
    const results = await Promise.all([
      coord.registerWorker({
        workerId: "worker-1",
        token,
        capabilities: ["node"],
      }),
      coord.registerWorker({
        workerId: "worker-1",
        token,
        capabilities: ["node"],
      }),
    ]);

    const successes = results.filter((r) => r.ok).length;
    assert.strictEqual(successes, 1, "exactly one enrollment may succeed");
  });

  it("unapproved device cannot receive project tasks", async () => {
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

    // Device is registered but NOT approved — dispatchTask must fail.
    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "Test",
      objective: "test",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    const r = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes("not approved"));
  });

  it("approved device can receive project tasks", async () => {
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
    await coord.approveDevice({ workerId: "worker-1", approvedBy: "leader-1" });

    coord.taskGraph.upsert({
      taskId: "task-1",
      title: "Test",
      objective: "test",
      requiredCapabilities: ["node"],
      dependencies: [],
      requiredTests: [],
    });

    const r = await coord.dispatchTask({ taskId: "task-1", workerId: "worker-1" });
    assert.strictEqual(r.ok, true);
  });

  it("device registry tracks approval status through registration", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    // Initially no devices registered.
    assert.strictEqual(coord.getDevices().length, 0);

    // Create invitations and register workers (registration populates device registry).
    const invResult = coord.createInvitations({ workerIds: ["worker-1", "worker-2"] });
    assert.strictEqual(invResult.ok, true);

    await coord.registerWorker({
      workerId: "worker-1",
      token: invResult.data.invitations[0].token,
      capabilities: ["node"],
    });
    await coord.registerWorker({
      workerId: "worker-2",
      token: invResult.data.invitations[1].token,
      capabilities: ["node"],
    });

    // Both should be pending approval after registration.
    const pending = coord.getPendingDevices();
    assert.strictEqual(pending.length, 2);

    // Approve one.
    await coord.approveDevice({ workerId: "worker-1", approvedBy: "leader-1" });
    assert.strictEqual(coord.isDeviceApproved("worker-1"), true);
    assert.strictEqual(coord.isDeviceApproved("worker-2"), false);

    // Revoke one.
    await coord.revokeDevice({ workerId: "worker-2", revokedBy: "leader-1", reason: "security" });
    assert.strictEqual(coord.isDeviceApproved("worker-2"), false);
    assert.strictEqual(coord.getDevice("worker-2").status, DEVICE_STATUS.REVOKED);
  });

  it("additional invitations can be generated after session creation", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    // Initial batch.
    const r1 = coord.createInvitations({ workerIds: ["worker-1"] });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.data.invitations.length, 1);

    // Additional invitation later.
    const r2 = coord.createInvitations({ workerIds: ["worker-2"] });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.data.invitations.length, 1);
    assert.notStrictEqual(
      r1.data.invitations[0].token,
      r2.data.invitations[0].token,
    );
  });
});
