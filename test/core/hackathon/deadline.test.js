// Deadline-aware execution tests.
//
// Verifies that the coordinator enforces deadline-based execution policies:
// time remaining, worker budget, reserve, priority rules, and concurrency limits.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";

describe("deadline-aware execution", () => {
  it("reports deadline status with time budget", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp",
      timeBudget: {
        totalDurationHours: 24,
        elapsedHours: 2,
        teammateCount: 5,
        reserveFraction: 0.1,
      },
    });

    const status = coord.getDeadlineStatus();
    assert.ok(status);
    assert.strictEqual(status.totalDurationHours, 24);
    assert.strictEqual(status.elapsedHours, 2);
    assert.strictEqual(status.remainingHours, 22);
    assert.ok(status.workerBudgetHours > 0);
    assert.ok(status.reserveHours > 0);
    assert.ok(status.remainingFraction > 0);
    assert.ok(status.percentageRemaining > 0);
  });

  it("returns implement policy when more than 50% remains", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
      timeBudget: {
        totalDurationHours: 24,
        elapsedHours: 2,
        teammateCount: 1,
        reserveFraction: 0.1,
      },
    });

    const policy = coord.getExecutionPolicy();
    assert.strictEqual(policy.label, "implement");
    assert.strictEqual(policy.acceptOptional, true);
  });

  it("returns critical policy when less than 10% remains", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
      timeBudget: {
        totalDurationHours: 24,
        elapsedHours: 22,
        teammateCount: 1,
        reserveFraction: 0.1,
      },
    });

    const policy = coord.getExecutionPolicy();
    assert.strictEqual(policy.label, "critical");
    assert.strictEqual(policy.acceptOptional, false);
  });

  it("returns stabilize policy when 10-25% remains", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
      timeBudget: {
        totalDurationHours: 24,
        elapsedHours: 20,
        teammateCount: 1,
        reserveFraction: 0.1,
      },
    });

    const policy = coord.getExecutionPolicy();
    assert.strictEqual(policy.label, "stabilize");
    assert.strictEqual(policy.acceptOptional, false);
  });

  it("shouldAcceptOptionalWork follows the policy", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
      timeBudget: {
        totalDurationHours: 24,
        elapsedHours: 2,
        teammateCount: 1,
        reserveFraction: 0.1,
      },
    });

    assert.strictEqual(coord.shouldAcceptOptionalWork(), true);

    // Exhaust the time budget.
    coord.session.timeBudget.elapsedHours = 23;
    coord.session.timeBudget.remainingHours = 1;
    assert.strictEqual(coord.shouldAcceptOptionalWork(), false);
  });

  it("getMaxConcurrentTasks is deadline-aware", async () => {
    const coord = new CoordinatorRuntime({
      maxConcurrentTasks: 8,
    });
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
      timeBudget: {
        totalDurationHours: 24,
        elapsedHours: 2,
        teammateCount: 1,
        reserveFraction: 0.1,
      },
    });

    // Implement policy: maxConcurrentTasks = min(8, 8) = 8.
    assert.strictEqual(coord.getMaxConcurrentTasks(), 8);

    // Critical policy: maxConcurrentTasks = min(2, 8) = 2.
    coord.session.timeBudget.elapsedHours = 23;
    coord.session.timeBudget.remainingHours = 1;
    assert.strictEqual(coord.getMaxConcurrentTasks(), 2);
  });

  it("rankTaskPriority orders by deadline priority", async () => {
    const coord = new CoordinatorRuntime();

    const critical = coord.rankTaskPriority({
      priority: "critical_security",
      securityRestrictions: [],
    });
    const crash = coord.rankTaskPriority({ priority: "crash_blocker" });
    const core = coord.rankTaskPriority({ priority: "core_functionality" });
    const integration = coord.rankTaskPriority({ priority: "integration_failure" });
    const optional = coord.rankTaskPriority({ priority: "optional_enhancement" });

    assert.strictEqual(critical, 1);
    assert.strictEqual(crash, 2);
    assert.strictEqual(core, 3);
    assert.strictEqual(integration, 4);
    assert.strictEqual(optional, 8);
    assert.ok(critical < crash);
    assert.ok(crash < core);
    assert.ok(core < integration);
    assert.ok(integration < optional);
  });

  it("handles no time budget gracefully", async () => {
    const coord = new CoordinatorRuntime();
    await coord.startSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });

    const status = coord.getDeadlineStatus();
    assert.ok(status);
    assert.strictEqual(status.totalDurationHours, 0);
    assert.strictEqual(status.remainingHours, 0);
    assert.strictEqual(status.percentageRemaining, 0);

    const policy = coord.getExecutionPolicy();
    assert.strictEqual(policy.label, "implement");
  });
});
