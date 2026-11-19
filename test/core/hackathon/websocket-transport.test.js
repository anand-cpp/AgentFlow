// WebSocket transport tests.
//
// Verifies that WebSocketTransport can be instantiated, has the correct
// interface, and manages connection state. Full server-side integration is
// covered by the transport abstraction and event protocol tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebSocketTransport } from "../../../src/core/hackathon/websocket-transport.js";
import { TRANSPORT_STATE } from "../../../src/core/hackathon/transport.js";

describe("WebSocketTransport", () => {
  it("instantiates with default state", () => {
    const t = new WebSocketTransport({
      sessionId: "session-1",
      workerId: "worker-1",
      url: "ws://localhost:20127/hackathon",
      invitationToken: "token-123",
    });

    assert.strictEqual(t.sessionId, "session-1");
    assert.strictEqual(t.workerId, "worker-1");
    assert.strictEqual(t.url, "ws://localhost:20127/hackathon");
    assert.strictEqual(t.state, TRANSPORT_STATE.DISCONNECTED);
  });

  it("rejects connect without URL", async () => {
    const t = new WebSocketTransport({
      sessionId: "session-1",
      workerId: "worker-1",
    });
    await assert.rejects(
      () => t.connect(),
      /requires a URL/
    );
  });

  it("inherits from HackathonTransport", () => {
    const t = new WebSocketTransport({
      sessionId: "s",
      workerId: "w",
      url: "ws://x",
    });
    assert.ok(t.on);
    assert.ok(t.emit);
    assert.ok(typeof t.connect === "function");
    assert.ok(typeof t.send === "function");
    assert.ok(typeof t.close === "function");
  });
});
