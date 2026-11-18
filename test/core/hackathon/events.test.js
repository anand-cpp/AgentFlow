// Hackathon event protocol tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HACKATHON_EVENTS,
  HackathonEvent,
  validateEvent,
  createEvent,
  MAX_PAYLOAD_BYTES,
} from "../../../src/core/hackathon/events.js";

describe("Hackathon events", () => {
  it("defines all required event types", () => {
    const required = [
      "WORKER_REGISTERED",
      "WORKER_CONNECTED",
      "WORKER_DISCONNECTED",
      "WORKER_HEARTBEAT",
      "WORKER_RECONNECTED",
      "TASK_DISPATCHED",
      "TASK_ACCEPTED",
      "TASK_STARTED",
      "TASK_PROGRESS",
      "TASK_BLOCKED",
      "TASK_COMPLETED",
      "TASK_FAILED",
      "TASK_CANCELLED",
      "LEASE_RENEWED",
      "LEASE_EXPIRED",
      "TASK_REASSIGNED",
    ];
    for (const name of required) {
      assert.ok(HACKATHON_EVENTS[name], `missing event type ${name}`);
      assert.strictEqual(typeof HACKATHON_EVENTS[name], "string");
    }
  });

  it("creates and validates a well-formed event", () => {
    const ev = createEvent({
      sessionId: "sess-1",
      workerId: "worker-1",
      taskId: "task-1",
      sequence: 1,
      type: HACKATHON_EVENTS.TASK_DISPATCHED,
      payload: { taskId: "task-1", workerId: "worker-1" },
    });
    assert.ok(ev.eventId);
    assert.strictEqual(ev.sessionId, "sess-1");
    assert.strictEqual(ev.workerId, "worker-1");
    assert.strictEqual(ev.taskId, "task-1");
    assert.strictEqual(ev.sequence, 1);
    assert.strictEqual(ev.type, HACKATHON_EVENTS.TASK_DISPATCHED);
    assert.ok(ev.timestamp);
    assert.strictEqual(validateEvent(ev), true);
  });

  it("rejects missing sessionId", () => {
    assert.throws(() =>
      createEvent({ workerId: "w", type: HACKATHON_EVENTS.TASK_DISPATCHED }),
    /sessionId/);
  });

  it("rejects unknown event type", () => {
    assert.throws(() =>
      createEvent({ sessionId: "s", type: "hackathon.unknown" }),
    /unknown event type/);
  });

  it("rejects negative sequence", () => {
    assert.throws(() =>
      createEvent({ sessionId: "s", type: HACKATHON_EVENTS.TASK_DISPATCHED, sequence: -1 }),
    /non-negative/);
  });

  it("round-trips through JSON", () => {
    const ev = createEvent({
      sessionId: "sess-1",
      taskId: "task-1",
      type: HACKATHON_EVENTS.TASK_COMPLETED,
      payload: { evidence: ["commit abc123"] },
    });
    const json = ev.toJSON();
    const restored = HackathonEvent.fromJSON(json);
    assert.strictEqual(restored.eventId, ev.eventId);
    assert.strictEqual(restored.sessionId, ev.sessionId);
    assert.strictEqual(restored.type, ev.type);
    assert.deepStrictEqual(restored.payload, ev.payload);
  });

  it("enforces the message-size limit", () => {
    const big = "x".repeat(MAX_PAYLOAD_BYTES + 1);
    assert.throws(() =>
      createEvent({
        sessionId: "s",
        type: HACKATHON_EVENTS.TASK_PROGRESS,
        payload: { data: big },
      }),
    /exceeds/);
  });
});
