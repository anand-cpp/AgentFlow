// Unit tests for the MCP SSE transport, against a mock HTTP server.
//
// The mock speaks the two-endpoint MCP-over-SSE shape: GET /sse streams
// `event: endpoint` plus JSON-RPC responses as SSE frames, and POST to the
// endpoint URL carries outgoing JSON-RPC requests whose replies ride back
// over the GET stream.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SseTransport } from "../../src/core/mcp/transports/sse.js";
import { McpTransport } from "../../src/core/mcp/transports/base.js";

/**
 * Start a mock MCP-over-SSE server. Returns { url, close, broadcast }.
 * The endpoint is /messages; the SSE stream is /sse.
 */
function startServer() {
  const subscribers = new Set();
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n");
      subscribers.add(res);
      req.on("close", () => subscribers.delete(res));
      return;
    }
    if (req.method === "POST" && req.url === "/messages") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts.push(body);
        // every POST is answered 202 and echoed back over the SSE stream
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end('{"received":true}');
        for (const sub of subscribers) sub.write(`data: ${body}\n\n`);
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {{ port: number }} */ (server.address());
      resolve({
        url: `http://127.0.0.1:${addr.port}/sse`,
        posts,
        broadcast(text) { for (const sub of subscribers) sub.write(`data: ${text}\n\n`); },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** Wait until `predicate` is true, or fail after `timeoutMs`. */
async function until(predicate, { timeoutMs = 2000 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("SseTransport extends the transport base", () => {
  const t = new SseTransport({ url: "http://localhost/sse" });
  assert.ok(t instanceof McpTransport);
});

test("transport requires a url", () => {
  assert.throws(() => new SseTransport({}), /requires a url/);
});

test("endpoint event unlocks POST, messages ride the stream", async (t) => {
  const srv = await startServer();
  t.after(() => srv.close());

  const messages = [];
  const opens = [];
  const transport = new SseTransport({ url: srv.url });
  transport.on("message", (m) => messages.push(m));
  transport.on("open", (o) => opens.push(o));
  transport.connect();

  await until(() => transport.postUrl != null);
  await until(() => opens.length === 1);

  transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  await until(() => messages.length === 1);

  assert.match(transport.postUrl, /\/messages$/);
  assert.equal(messages[0].method, "ping");
  assert.equal(srv.posts.length, 1);
  assert.equal(JSON.parse(srv.posts[0]).method, "ping");
  transport.close();
});

test("event boundaries dispatch; an unterminated event stays buffered", () => {
  const t2 = new SseTransport({ url: "http://localhost:1/sse" });
  const messages = [];
  t2.on("message", (m) => messages.push(m));
  // a complete event ends at a blank line: dispatched without a flush
  t2._onSse('event: message\ndata: {"a":1}\n\n');
  assert.deepEqual(messages, [{ a: 1 }]);
  // a chunk whose event has no closing blank line is not dispatched yet
  t2._onSse('data: {"b":2}');
  assert.deepEqual(messages, [{ a: 1 }]);
  assert.equal(t2.buf, 'data: {"b":2}');
  // the closing boundary arrives in the next chunk and releases it
  t2._onSse("\n\n");
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test("multi-line data is joined with newlines", () => {
  const t2 = new SseTransport({ url: "http://localhost:1/sse" });
  t2._onSse('data: {"a":\ndata: 1}\n\n');
  assert.equal(t2.eventBuf, '');
});

test("malformed SSE data emits a parse error", () => {
  const t2 = new SseTransport({ url: "http://localhost:1/sse" });
  const errors = [];
  t2.on("error", (e) => errors.push(e));
  t2._onSse("event: message\ndata: not-json\n\n");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, "parse");
});

test("SSE comments (: ping) are ignored", () => {
  const t2 = new SseTransport({ url: "http://localhost:1/sse" });
  const messages = [];
  t2.on("message", (m) => messages.push(m));
  t2._onSse(': keep-alive\n\n');
  assert.equal(messages.length, 0);
});

test("non-endpoint events do not unlock send", () => {
  const t2 = new SseTransport({ url: "http://localhost:1/sse" });
  t2._onSse('event: message\ndata: {"a":1}\n\n');
  assert.equal(t2.postUrl, null);
  assert.throws(() => t2.send({ jsonrpc: "2.0" }), /not ready/);
});
