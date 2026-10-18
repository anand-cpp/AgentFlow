// Unit tests for the MCP client protocol: handshake lifecycle, ping, request
// timeouts, and server-request handling. Drives McpClient with an in-memory
// fake transport, so no real server (stdio or SSE) is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { McpClient } from "../../src/core/mcp/client.js";

/**
 * A duck-typed transport double: records everything the client sends and lets
 * the test push messages into it, as a server would. Not an instanceof
 * McpTransport — the client treats the transport structurally.
 */
function fakeTransport() {
  const listeners = new Map();
  const t = {
    sent: [],
    connectCalls: 0,
    closeCalls: 0,
    on(type, fn) {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(type, detail) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) fn(detail);
    },
    send(message) {
      t.sent.push(message);
    },
    connect() {
      t.connectCalls += 1;
    },
    close() {
      t.closeCalls += 1;
    },
    /** Answer a request from the "server" side. */
    reply(id, result) {
      t.emit("message", { jsonrpc: "2.0", id, result });
    },
    replyError(id, error) {
      t.emit("message", { jsonrpc: "2.0", id, error });
    },
    emitNotification(method, params) {
      t.emit("message", { jsonrpc: "2.0", method, params });
    },
    emitServerRequest(id, method, params) {
      t.emit("message", { jsonrpc: "2.0", id, method, params });
    },
  };
  return t;
}

test("client default transportType is stdio", () => {
  const c = new McpClient({ command: "echo" });
  assert.equal(c.transportType, "stdio");
});

test("initialize sends the protocol handshake and the initialized notification", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  const promise = c.initialize();
  // wiring + the initialize request happen synchronously before the first await
  assert.equal(t.sent.length, 1);
  const req = t.sent[0];
  assert.equal(req.method, "initialize");
  assert.equal(req.params.protocolVersion, "2024-11-05");
  assert.equal(req.params.clientInfo.name, "AgentFlow");
  assert.equal(req.params.clientInfo.version, "0.3.0");
  assert.ok(req.params.capabilities.roots, "client advertises roots");
  assert.ok(req.params.capabilities.sampling, "client advertises sampling");
  t.reply(req.id, { protocolVersion: req.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} }, serverInfo: { name: "mock", version: "1.0" } });
  await promise;
  assert.equal(c.initialized, true);
  assert.equal(c.capabilities.tools != null, true);
  assert.equal(c.serverInfo.name, "mock");
  // notifications/initialized follows the response
  assert.equal(t.sent.at(-1).method, "notifications/initialized");
});

test("initialize is idempotent after the handshake", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  const p1 = c.initialize();
  // request already on the wire synchronously; reply from the fake server
  t.reply(t.sent.at(-1).id, { capabilities: {} });
  await p1;
  const again = await c.initialize();
  assert.deepEqual(again.capabilities, {});
  assert.equal(t.sent.length, 2, "no second initialize on the wire");
});

test("ping returns the server's empty result", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  const p = c.ping();
  const reqId = t.sent.at(-1).id;
  t.reply(reqId, {});
  await p;
  assert.equal(t.sent.at(-1).method, "ping");
});

test("a request that never gets a reply times out", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t, requestTimeoutMs: 40 });
  await assert.rejects(c.request("tools/list", {}, { timeoutMs: 40 }), /timed out/);
});

test("a request inherits the client's default timeout", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t, requestTimeoutMs: 30 });
  await assert.rejects(c.request("tools/list"), /timed out/);
});

test("server errors reject with the server's code", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  const p = c.request("tools/call", { name: "x" });
  const id = t.sent.at(-1).id;
  t.replyError(id, { code: -32602, message: "Invalid arguments" });
  await assert.rejects(p, (err) => {
    const e = /** @type {Error & { code?: unknown }} */ (err);
    assert.match(e.message, /Invalid arguments/);
    assert.equal(e.code, -32602);
    return true;
  });
});

test("notifications are forwarded as a notification event once connected", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  c.connect();
  const seen = [];
  c.on("notification", (m) => seen.push(m));
  t.emitNotification("notifications/tools/list_changed", {});
  assert.deepEqual(seen.map((m) => m.method), ["notifications/tools/list_changed"]);
  assert.equal(t.sent.length, 0, "client does not answer notifications");
});

test("server-initiated requests get a method-not-found response", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  c.connect();
  t.emitServerRequest(7, "sampling/createMessage", {});
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.sent.at(-1), {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32601, message: "unsupported: sampling/createMessage" },
  });
});

test("close rejects pending requests and closes the transport", async () => {
  const t = fakeTransport();
  const c = new McpClient({ transport: t });
  const p = c.request("tools/list");
  c.close();
  await assert.rejects(p, /client closed/);
  assert.equal(t.closeCalls, 1);
  assert.equal(c.initialized, false);
  assert.equal(c.connected, false);
});

test("notify throws before connect", () => {
  const c = new McpClient({ transport: null, command: "x" });
  assert.throws(() => c.notify("notifications/x"), /not connected/);
});
