// Session pause/resume integration tests — pause blocks task dispatching.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { SessionExecutor } from "../../../src/core/hackathon/executor.js";
import { SessionControl } from "../../../src/core/hackathon/session-control.js";

describe("Session control integration", () => {
  it("pause stops executor dispatch loop", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    exec.start();
    assert.strictEqual(exec._running, true);

    const ctrl = new SessionControl({ coordinator: coord, executor: exec });
    await ctrl.pause();
    assert.strictEqual(exec._running, false);
  });

  it("resume restarts executor dispatch loop", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    const ctrl = new SessionControl({ coordinator: coord, executor: exec });

    await ctrl.pause();
    assert.strictEqual(exec._running, false);

    await ctrl.resume();
    assert.strictEqual(exec._running, true);
  });

  it("pause persists session status", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const ctrl = new SessionControl({ coordinator: coord });

    await ctrl.pause();
    assert.strictEqual(coord.session.status, "paused");
    assert.strictEqual(ctrl.isPaused(), true);
    assert.strictEqual(ctrl.isActive(), false);
  });

  it("resume restores session status", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const ctrl = new SessionControl({ coordinator: coord });

    await ctrl.pause();
    await ctrl.resume();
    assert.strictEqual(coord.session.status, "active");
    assert.strictEqual(ctrl.isActive(), true);
    assert.strictEqual(ctrl.isPaused(), false);
  });

  it("getStatus returns current status", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const ctrl = new SessionControl({ coordinator: coord });

    assert.strictEqual(ctrl.getStatus(), "active");
    await ctrl.pause();
    assert.strictEqual(ctrl.getStatus(), "paused");
    await ctrl.resume();
    assert.strictEqual(ctrl.getStatus(), "active");
  });
});
