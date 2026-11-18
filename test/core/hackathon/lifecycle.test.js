// Hackathon task lifecycle tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateTransition,
  isTerminal,
  isActive,
  isAssignable,
} from "../../../src/core/hackathon/lifecycle.js";
import { TASK_STATUS } from "../../../src/core/hackathon/session.js";

describe("Task lifecycle", () => {
  it("defines all required statuses", () => {
    const required = [
      "PENDING",
      "ASSIGNED",
      "ACCEPTED",
      "RUNNING",
      "COMPLETED",
      "BLOCKED",
      "FAILED",
      "CANCELLED",
      "EXPIRED",
    ];
    for (const name of required) {
      assert.ok(TASK_STATUS[name], `missing status ${name}`);
    }
  });

  it("allows the normal execution path", () => {
    assert.strictEqual(validateTransition("pending", "assigned").ok, true);
    assert.strictEqual(validateTransition("assigned", "accepted").ok, true);
    assert.strictEqual(validateTransition("accepted", "running").ok, true);
    assert.strictEqual(validateTransition("running", "completed").ok, true);
  });

  it("rejects invalid transitions", () => {
    assert.strictEqual(validateTransition("pending", "running").ok, false);
    assert.strictEqual(validateTransition("completed", "running").ok, false);
    assert.strictEqual(validateTransition("failed", "accepted").ok, false);
    assert.strictEqual(validateTransition("running", "pending").ok, false);
  });

  it("allows exception transitions from active states", () => {
    assert.strictEqual(validateTransition("assigned", "blocked").ok, true);
    assert.strictEqual(validateTransition("accepted", "failed").ok, true);
    assert.strictEqual(validateTransition("running", "cancelled").ok, true);
    assert.strictEqual(validateTransition("running", "expired").ok, true);
    assert.strictEqual(validateTransition("assigned", "cancelled").ok, true);
  });

  it("allows recovery from failure/expiry to assigned", () => {
    assert.strictEqual(validateTransition("failed", "assigned").ok, true);
    assert.strictEqual(validateTransition("expired", "assigned").ok, true);
    assert.strictEqual(validateTransition("cancelled", "pending").ok, true);
  });

  it("identifies terminal states", () => {
    assert.strictEqual(isTerminal("completed"), true);
    assert.strictEqual(isTerminal("failed"), true);
    assert.strictEqual(isTerminal("cancelled"), true);
    assert.strictEqual(isTerminal("running"), false);
    assert.strictEqual(isTerminal("pending"), false);
  });

  it("identifies active states", () => {
    assert.strictEqual(isActive("assigned"), true);
    assert.strictEqual(isActive("accepted"), true);
    assert.strictEqual(isActive("running"), true);
    assert.strictEqual(isActive("blocked"), true);
    assert.strictEqual(isActive("pending"), false);
    assert.strictEqual(isActive("completed"), false);
  });

  it("identifies assignable states", () => {
    assert.strictEqual(isAssignable("pending"), true);
    assert.strictEqual(isAssignable("expired"), true);
    assert.strictEqual(isAssignable("failed"), true);
    assert.strictEqual(isAssignable("cancelled"), true);
    assert.strictEqual(isAssignable("assigned"), false);
    assert.strictEqual(isAssignable("running"), false);
    assert.strictEqual(isAssignable("completed"), false);
  });

  it("rejects unknown states", () => {
    assert.strictEqual(validateTransition("bogus", "pending").ok, false);
    assert.strictEqual(validateTransition("pending", "bogus").ok, false);
  });
});
