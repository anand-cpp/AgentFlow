// Gateway client behaviour at the HTTP boundary, exercised against a real
// localhost server rather than a stubbed fetch.
//
// The point is that every distinct failure -- refused, timed out, cancelled,
// HTTP error, a mid-stream provider error -- stays distinct. Collapsing any of
// them into a generic "request failed" is what makes an operator unable to tell
// a wrong API key from a dead port.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  complete,
  listModels,
  probeModel,
  ping,
  streamComplete,
  getVersion,
  GatewayError,
} from "../src/core/gateway.js";

async function startServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const { port } = /** @type {any} */ (server.address());
  return { baseUrl: `http://127.0.0.1:${port}`, config: { baseUrl: `http://127.0.0.1:${port}`, apiKey: null, probeTimeoutMs: 2000 } };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("listModels maps the catalogue into id, owner and provider", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    if (req.url === "/v1/models") {
      return json(res, 200, { data: [{ id: "groq/llama-3", owned_by: "groq" }, { id: "plain" }, {}] });
    }
    return json(res, 404, { error: { message: "no route" } });
  });

  const models = await listModels(config);
  assert.deepEqual(models[0], { id: "groq/llama-3", ownedBy: "groq", provider: "groq" });
  assert.equal(models[1].provider, null, "an id with no provider prefix has no provider");
  assert.equal(models[2].id, undefined);
});

// Assembled from fragments: a credential-shaped literal would trip
// scripts/scan-secrets.mjs, which is the point of that scanner.
const LEAKY_KEY = "sk-" + "leak-1234567890";

test("an HTTP error carries the status, code and redacted detail", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    json(res, 401, { error: { message: "bad key", code: "invalid_api_key" }, apiKey: LEAKY_KEY });
  });

  await assert.rejects(complete(config, "groq/x", "hi"), (err) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.status, 401);
    assert.equal(err.code, "invalid_api_key");
    assert.equal(err.message, "bad key");
    assert.notEqual(err.detail.apiKey, LEAKY_KEY, "the error detail is redacted");
    return true;
  });
});

test("a refused connection is reported as unreachable, not timeout", async () => {
  // Reserve then release a port so nothing is listening on it.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = /** @type {import("node:net").AddressInfo} */ (probe.address()).port;
  await new Promise((r) => probe.close(r));

  await assert.rejects(getVersion({ baseUrl: `http://127.0.0.1:${port}`, probeTimeoutMs: 500 }), (err) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.code, "unreachable");
    assert.match(err.message, /cannot reach gateway/);
    return true;
  });
});

test("ping reports reachability without throwing", async (t) => {
  const { config } = await startServer(t, (req, res) => json(res, 200, { version: "1.0.0" }));

  const up = await ping(config);
  assert.equal(up.ok, true);

  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const deadPort = /** @type {import("node:net").AddressInfo} */ (probe.address()).port;
  await new Promise((r) => probe.close(r));

  const down = await ping({ baseUrl: `http://127.0.0.1:${deadPort}`, probeTimeoutMs: 500 });
  assert.equal(down.ok, false, "ping never throws; a dead gateway is a value");
  assert.equal(down.code, "unreachable");
});

test("probeModel distinguishes ok, empty and error", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    if (req.url !== "/v1/chat/completions") return json(res, 404, {});
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const model = JSON.parse(body || "{}").model;
      if (model === "good") return json(res, 200, { choices: [{ message: { content: "PONG" } }] });
      if (model === "blank") return json(res, 200, { choices: [{ message: { content: "   " } }] });
      return json(res, 500, { error: { message: "provider down" } });
    });
  });

  const ok = await probeModel(config, "good");
  assert.equal(ok.status, "ok");
  assert.equal(ok.reachable, true);
  assert.equal(ok.sample, "PONG");

  const empty = await probeModel(config, "blank");
  assert.equal(empty.status, "empty");
  assert.equal(empty.reachable, true, "reachable but useless is not unreachable");

  const bad = await probeModel(config, "boom");
  assert.equal(bad.status, "error");
  assert.equal(bad.reachable, false);
});

test("complete returns the trimmed assistant text", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => json(res, 200, { choices: [{ message: { content: "  hello world  " }, finish_reason: "stop" }] }));
  });

  const out = await complete(config, "groq/x", "prompt");
  assert.equal(out.text, "hello world");
  assert.equal(out.finishReason, "stop");
});

test("streamComplete streams SSE deltas and accumulates the full text", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });

  const tokens = [];
  const out = await streamComplete(config, "groq/x", [{ role: "user", content: "hi" }], {
    onToken: (chunk) => tokens.push(chunk),
  });

  assert.deepEqual(tokens, ["Hel", "lo"]);
  assert.equal(out.text, "Hello");
  assert.equal(out.streamed, true);
  assert.equal(out.finishReason, "stop");
});

test("a non-SSE response is accepted as a single non-streamed completion", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    json(res, 200, { choices: [{ message: { content: "plain answer" } }] });
  });

  const tokens = [];
  const out = await streamComplete(config, "groq/x", [{ role: "user", content: "hi" }], {
    onToken: (chunk) => tokens.push(chunk),
  });

  assert.equal(out.streamed, false);
  assert.equal(out.text, "plain answer");
  assert.deepEqual(tokens, ["plain answer"], "the whole answer is emitted once");
});

test("a mid-stream provider error aborts the read with its own code", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
    res.write('data: {"error":{"message":"upstream exploded","code":"upstream_error"}}\n\n');
    res.end();
  });

  await assert.rejects(
    streamComplete(config, "groq/x", [{ role: "user", content: "hi" }]),
    (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.code, "upstream_error");
      assert.equal(err.message, "upstream exploded");
      return true;
    },
  );
});

test("aborting mid-flight surfaces as cancelled, distinct from timeout", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    if (req.url === "/v1/chat/completions") return; // hang so the abort wins
    json(res, 404, {});
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(
    streamComplete(config, "groq/x", [{ role: "user", content: "hi" }], {
      signal: controller.signal,
      timeoutMs: 10000,
    }),
    (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.code, "cancelled");
      assert.equal(err.name, "AbortError");
      return true;
    },
  );
});

test("a hard timeout surfaces as timeout", async (t) => {
  const { config } = await startServer(t, (req, res) => {
    if (req.url === "/v1/chat/completions") return; // hang
    json(res, 404, {});
  });

  await assert.rejects(
    streamComplete({ ...config, probeTimeoutMs: 60 }, "groq/x", [{ role: "user", content: "hi" }], { timeoutMs: 60 }),
    (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.code, "timeout");
      return true;
    },
  );
});
