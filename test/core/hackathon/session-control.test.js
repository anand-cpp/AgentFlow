// Session pause/resume control tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SessionControl } from "../../../src/core/hackathon/session-control.js";
import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { SessionExecutor } from "../../../src/core/hackathon/executor.js";

describe("SessionControl", () => {
  it("creates a control with no coordinator", () => {
    const ctrl = new SessionControl();
    assert.strictEqual(ctrl.getStatus(), null);
    assert.strictEqual(ctrl.isPaused(), false);
    assert.strictEqual(ctrl.isActive(), false);
  });

  it("pauses and resumes a session", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    const ctrl = new SessionControl({ coordinator: coord, executor: exec });

    assert.strictEqual(ctrl.isActive(), true);
    assert.strictEqual(ctrl.isPaused(), false);

    const paused = await ctrl.pause();
    assert.strictEqual(paused.ok, true);
    assert.strictEqual(paused.status, "paused");
    assert.strictEqual(ctrl.isPaused(), true);
    assert.strictEqual(ctrl.isActive(), false);

    const resumed = await ctrl.resume();
    assert.strictEqual(resumed.ok, true);
    assert.strictEqual(resumed.status, "active");
    assert.strictEqual(ctrl.isActive(), true);
    assert.strictEqual(ctrl.isPaused(), false);
  });

  it("pause when already paused is idempotent", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const ctrl = new SessionControl({ coordinator: coord });

    await ctrl.pause();
    const result = await ctrl.pause();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.message, "already paused");
  });

  it("resume when already active is idempotent", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const ctrl = new SessionControl({ coordinator: coord });

    const result = await ctrl.resume();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.message, "already active");
  });

  it("rejects pause with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const ctrl = new SessionControl({ coordinator: coord });
    const result = await ctrl.pause();
    assert.strictEqual(result.ok, false);
  });

  it("rejects resume with no active session", async () => {
    const coord = new CoordinatorRuntime();
    const ctrl = new SessionControl({ coordinator: coord });
    const result = await ctrl.resume();
    assert.strictEqual(result.ok, false);
  });

  it("stops executor on pause", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    const exec = new SessionExecutor({ coordinator: coord });
    exec.start();
    const ctrl = new SessionControl({ coordinator: coord, executor: exec });

    await ctrl.pause();
    assert.strictEqual(exec._running, false);

    await ctrl.resume();
    assert.strictEqual(exec._running, true);
  });
});
