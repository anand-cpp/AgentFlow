// Event sequence integration tests — dedup with coordinator events.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CoordinatorRuntime } from "../../../src/core/hackathon/coordinator.js";
import { EventSequenceRegistry } from "../../../src/core/hackathon/event-seq.js";
import { createEvent } from "../../../src/core/hackathon/events.js";
import { HACKATHON_EVENTS } from "../../../src/core/hackathon/events.js";

describe("Event sequence integration", () => {
  it("registry tracks one tracker per session", () => {
    const registry = new EventSequenceRegistry();
    const t1 = registry.getOrCreate("sess-1");
    const t2 = registry.getOrCreate("sess-2");
    assert.notStrictEqual(t1, t2);
    assert.strictEqual(registry.get("sess-1"), t1);
    assert.strictEqual(registry.get("sess-2"), t2);
  });

  it("registry remove stops tracking a session", () => {
    const registry = new EventSequenceRegistry();
    registry.getOrCreate("sess-1");
    assert.ok(registry.get("sess-1"));
    registry.remove("sess-1");
    assert.strictEqual(registry.get("sess-1"), null);
  });

  it("duplicate sequence numbers are detected across events", () => {
    const registry = new EventSequenceRegistry();
    const tracker = registry.getOrCreate("sess-1");

    const ev1 = createEvent({
      sessionId: "sess-1", sequence: 1,
      type: HACKATHON_EVENTS.WORKER_HEARTBEAT, payload: {},
    });
    const r1 = tracker.accept(ev1);
    assert.strictEqual(r1.duplicate, false);

    const ev2 = createEvent({
      sessionId: "sess-1", sequence: 1, // same sequence
      type: HACKATHON_EVENTS.WORKER_HEARTBEAT, payload: {},
    });
    const r2 = tracker.accept(ev2);
    assert.strictEqual(r2.duplicate, true);
  });

  it("coordinator events use incrementing sequences", async () => {
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

    // Events should have incrementing sequence numbers.
    const seqs = coord.session.events.map((e) => e.sequence).filter((s) => s != null);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], `sequence ${seqs[i]} should be > ${seqs[i - 1]}`);
    }
  });
});
