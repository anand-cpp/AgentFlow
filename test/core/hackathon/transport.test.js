// Hackathon local transport tests — real in-process communication, no network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LocalTransport,
  LocalBus,
  TRANSPORT_STATE,
} from "../../../src/core/hackathon/transport.js";
import { HACKATHON_EVENTS, createEvent } from "../../../src/core/hackathon/events.js";

describe("LocalTransport and LocalBus", () => {
  it("bus starts with no subscribers", () => {
    const bus = new LocalBus();
    assert.strictEqual(bus.subscriberCount("sess-1"), 0);
  });

  it("connects two transports over the same bus", async () => {
    const bus = new LocalBus();
    const a = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-a" });
    const b = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-b" });

    const connected = [];
    a.on("connect", () => connected.push("a"));
    b.on("connect", () => connected.push("b"));

    await a.connect();
    await b.connect();

    assert.strictEqual(a.state, TRANSPORT_STATE.CONNECTED);
    assert.strictEqual(b.state, TRANSPORT_STATE.CONNECTED);
    assert.deepStrictEqual(connected, ["a", "b"]);
    assert.strictEqual(bus.subscriberCount("sess-1"), 2);
  });

  it("delivers a message from one transport to another", async () => {
    const bus = new LocalBus();
    const a = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-a" });
    const b = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-b" });

    const received = [];
    b.on("message", (ev) => received.push(ev));

    await a.connect();
    await b.connect();

    const ev = createEvent({
      sessionId: "sess-1",
      workerId: "worker-b",
      taskId: "task-1",
      type: HACKATHON_EVENTS.TASK_DISPATCHED,
      payload: { taskId: "task-1" },
    });
    await a.send(ev);

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].type, HACKATHON_EVENTS.TASK_DISPATCHED);
    assert.strictEqual(received[0].workerId, "worker-b");
  });

  it("does not deliver messages to other sessions", async () => {
    const bus = new LocalBus();
    const a = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-a" });
    const c = new LocalTransport({ bus, sessionId: "sess-2", workerId: "worker-c" });

    const received = [];
    c.on("message", () => received.push("c"));

    await a.connect();
    await c.connect();

    const ev = createEvent({
      sessionId: "sess-1",
      workerId: "worker-a",
      type: HACKATHON_EVENTS.WORKER_HEARTBEAT,
      payload: {},
    });
    await a.send(ev);

    assert.strictEqual(received.length, 0);
  });

  it("does not deliver messages addressed to a different worker", async () => {
    const bus = new LocalBus();
    const a = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-a" });
    const b = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-b" });

    const received = [];
    b.on("message", () => received.push("b"));

    await a.connect();
    await b.connect();

    const ev = createEvent({
      sessionId: "sess-1",
      workerId: "worker-a", // addressed to a, not b
      type: HACKATHON_EVENTS.TASK_DISPATCHED,
      payload: {},
    });
    await a.send(ev);

    assert.strictEqual(received.length, 0);
  });

  it("enforces message-size limit at event creation", () => {
    const big = "x".repeat(70000);
    assert.throws(() =>
      createEvent({
        sessionId: "sess-1",
        workerId: "worker-a",
        type: HACKATHON_EVENTS.TASK_PROGRESS,
        payload: { data: big },
      }),
    /byte limit/);
  });

  it("rejects send when not connected", async () => {
    const bus = new LocalBus();
    const a = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-a" });

    const ev = createEvent({
      sessionId: "sess-1",
      workerId: "worker-a",
      type: HACKATHON_EVENTS.WORKER_HEARTBEAT,
      payload: {},
    });

    await assert.rejects(() => a.send(ev), /not connected/);
  });

  it("closes a transport", async () => {
    const bus = new LocalBus();
    const a = new LocalTransport({ bus, sessionId: "sess-1", workerId: "worker-a" });
    await a.connect();
    await a.close();
    assert.strictEqual(a.state, TRANSPORT_STATE.CLOSED);
    assert.strictEqual(bus.subscriberCount("sess-1"), 0);
  });
});
