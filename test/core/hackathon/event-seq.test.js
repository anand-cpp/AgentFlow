// Event sequencing and deduplication tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EventSequence, EventSequenceRegistry } from "../../../src/core/hackathon/event-seq.js";
import { createEvent } from "../../../src/core/hackathon/events.js";
import { HACKATHON_EVENTS } from "../../../src/core/hackathon/events.js";

describe("EventSequence", () => {
  it("creates a tracker for a session", () => {
    const tracker = new EventSequence({ sessionId: "sess-1" });
    assert.strictEqual(tracker.sessionId, "sess-1");
    assert.strictEqual(tracker.lastSequence, 0);
    assert.strictEqual(tracker.nextExpected(), 1);
    assert.strictEqual(tracker.pendingCount(), 0);
  });

  it("accepts events in order", () => {
    const tracker = new EventSequence({ sessionId: "sess-1" });

    const ev1 = createEvent({
      sessionId: "sess-1", sequence: 1, type: HACKATHON_EVENTS.WORKER_CONNECTED, payload: {},
    });
    const r1 = tracker.accept(ev1);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.duplicate, false);
    assert.strictEqual(r1.sequence, 1);
    assert.strictEqual(r1.gap, false);
    assert.strictEqual(tracker.nextExpected(), 2);

    const ev2 = createEvent({
      sessionId: "sess-1", sequence: 2, type: HACKATHON_EVENTS.WORKER_HEARTBEAT, payload: {},
    });
    const r2 = tracker.accept(ev2);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.duplicate, false);
    assert.strictEqual(tracker.nextExpected(), 3);
  });

  it("detects duplicate events", () => {
    const tracker = new EventSequence({ sessionId: "sess-1" });

    const ev1 = createEvent({
      sessionId: "sess-1", sequence: 1, type: HACKATHON_EVENTS.WORKER_CONNECTED, payload: {},
    });
    tracker.accept(ev1);

    const r2 = tracker.accept(ev1); // same event again
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.duplicate, true);
    assert.strictEqual(r2.sequence, 1);

    const r3 = tracker.isDuplicate(1);
    assert.strictEqual(r3, true);
    assert.strictEqual(tracker.isDuplicate(2), false);
  });

  it("detects gaps in sequence", () => {
    const tracker = new EventSequence({ sessionId: "sess-1" });

    const ev1 = createEvent({
      sessionId: "sess-1", sequence: 1, type: HACKATHON_EVENTS.WORKER_CONNECTED, payload: {},
    });
    tracker.accept(ev1);

    // Skip sequence 2, send sequence 3.
    const ev3 = createEvent({
      sessionId: "sess-1", sequence: 3, type: HACKATHON_EVENTS.TASK_PROGRESS, payload: {},
    });
    const r3 = tracker.accept(ev3);
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(r3.duplicate, false);
    assert.strictEqual(r3.gap, true); // gap detected: missed sequence 2
    // lastSequence is still 1 because seq 2 hasn't been delivered.
    assert.strictEqual(tracker.nextExpected(), 2);
    assert.strictEqual(tracker.pendingCount(), 1);
  });

  it("buffers out-of-order events and delivers in order", () => {
    const tracker = new EventSequence({ sessionId: "sess-1" });

    // Send sequence 3 first.
    const ev3 = createEvent({
      sessionId: "sess-1", sequence: 3, type: HACKATHON_EVENTS.TASK_PROGRESS, payload: {},
    });
    const r3 = tracker.accept(ev3);
    assert.strictEqual(r3.delivered.length, 0); // not delivered yet, waiting for 1 and 2
    assert.strictEqual(tracker.pendingCount(), 1);

    // Send sequence 1.
    const ev1 = createEvent({
      sessionId: "sess-1", sequence: 1, type: HACKATHON_EVENTS.WORKER_CONNECTED, payload: {},
    });
    const r1 = tracker.accept(ev1);
    assert.strictEqual(r1.delivered.length, 1); // delivers 1
    assert.strictEqual(r1.delivered[0].sequence, 1);
    assert.strictEqual(tracker.nextExpected(), 2); // still waiting for 2

    // Send sequence 2 - now 1, 2, 3 should all be delivered.
    const ev2 = createEvent({
      sessionId: "sess-1", sequence: 2, type: HACKATHON_EVENTS.WORKER_HEARTBEAT, payload: {},
    });
    const r2 = tracker.accept(ev2);
    assert.strictEqual(r2.delivered.length, 2); // delivers 2 and 3
    assert.strictEqual(tracker.pendingCount(), 0);
    assert.strictEqual(tracker.nextExpected(), 4);
  });

  it("persists and restores state", () => {
    const tracker = new EventSequence({ sessionId: "sess-1" });

    const ev1 = createEvent({
      sessionId: "sess-1", sequence: 1, type: HACKATHON_EVENTS.WORKER_CONNECTED, payload: {},
    });
    tracker.accept(ev1);

    const ev2 = createEvent({
      sessionId: "sess-1", sequence: 2, type: HACKATHON_EVENTS.WORKER_HEARTBEAT, payload: {},
    });
    tracker.accept(ev2);

    const json = tracker.toJSON();
    assert.strictEqual(json.version, 1);
    assert.strictEqual(json.sessionId, "sess-1");
    assert.strictEqual(json.lastSequence, 2);
    assert.ok(json.seen.includes(1));
    assert.ok(json.seen.includes(2));

    const restored = EventSequence.fromJSON(json);
    assert.strictEqual(restored.lastSequence, 2);
    assert.strictEqual(restored.nextExpected(), 3);
    assert.strictEqual(restored.isDuplicate(1), true);
    assert.strictEqual(restored.isDuplicate(2), true);
    assert.strictEqual(restored.isDuplicate(3), false);
  });
});

describe("EventSequenceRegistry", () => {
  it("creates and retrieves trackers per session", () => {
    const registry = new EventSequenceRegistry();

    const t1 = registry.getOrCreate("sess-1");
    const t2 = registry.getOrCreate("sess-2");
    assert.notStrictEqual(t1, t2);

    const t1again = registry.get("sess-1");
    assert.strictEqual(t1again, t1);

    const t3 = registry.get("sess-3");
    assert.strictEqual(t3, null); // not created yet

    registry.remove("sess-1");
    assert.strictEqual(registry.get("sess-1"), null);
  });

  it("requires sessionId", () => {
    const registry = new EventSequenceRegistry();
    assert.throws(() => registry.getOrCreate(""), /sessionId required/);
  });
});
