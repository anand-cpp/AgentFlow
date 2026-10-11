// The standalone in-repo gateway server.
//
// Two things are under test and they are different in kind:
//
//   1. Lifecycle. The server must bind, answer, and -- the part that is easy to
//      get wrong -- fully release the port on close so a restart or a test can
//      bind it again. A second server on a held port must fail with a *typed*
//      error (GatewayPortConflictError), not an unhandled 'error' event.
//
//   2. The proxy. /v1/models is normalized from Ollama's /api/tags, and
//      /v1/chat/completions is piped through byte-for-byte in both streaming
//      and non-streaming modes. A mock Ollama (a real node:http server, not a
//      stubbed fetch) is used so the whole path -- sockets, headers, stream
//      framing -- is exercised rather than simulated.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import {
  GatewayServer,
  GatewayPortConflictError,
  normaliseOllamaModels,
  defaultServerDir,
} from "../src/core/gateway-server.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Close an http server, forcing keep-alive sockets shut so the test cannot hang. */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/**
 * A mock Ollama instance.
 *
 * Records every request (method, url, body) so a test can assert the gateway
 * forwarded the client's body verbatim, and lets each route decide its reply.
 */
function startMockOllama(routes) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method, url: req.url, body, headers: req.headers });
        const handler = routes[`${req.method} ${req.url}`] || routes[req.url];
        if (!handler) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no mock route" }));
          return;
        }
        handler(req, res, body, requests);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}`, requests });
    });
  });
}

const TAGS_BODY = {
  models: [
    { name: "llama3:latest", model: "llama3:latest", modified_at: "2026-01-02T03:04:05.000Z", size: 123, digest: "abc" },
    { name: "qwen2.5-coder:7b", model: "qwen2.5-coder:7b", modified_at: "2026-02-03T00:00:00.000Z", size: 456, digest: "def" },
  ],
};

// ---------------------------------------------------------------------------
// unit: model normalisation
// ---------------------------------------------------------------------------

test("normaliseOllamaModels maps /api/tags entries into OpenAI list items", () => {
  const out = normaliseOllamaModels(TAGS_BODY);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    id: "llama3:latest",
    object: "model",
    created: Math.floor(Date.parse("2026-01-02T03:04:05.000Z") / 1000),
    owned_by: "ollama",
  });
  assert.equal(out[1].id, "qwen2.5-coder:7b");
});

test("normaliseOllamaModels tolerates junk without throwing", () => {
  assert.deepEqual(normaliseOllamaModels(null), []);
  assert.deepEqual(normaliseOllamaModels({}), []);
  assert.deepEqual(normaliseOllamaModels({ models: [{}, { name: "" }] }), []);
});

test("defaultServerDir honours AGENTFLOW_STATE_DIR", () => {
  const prev = process.env.AGENTFLOW_STATE_DIR;
  process.env.AGENTFLOW_STATE_DIR = path.join("tmp", "af-state");
  try {
    assert.equal(defaultServerDir(), path.join("tmp", "af-state", "server"));
  } finally {
    if (prev === undefined) delete process.env.AGENTFLOW_STATE_DIR;
    else process.env.AGENTFLOW_STATE_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

test("starts on an OS-assigned port, answers /api/version, and frees the port on close", async () => {
  const server = new GatewayServer({ port: 0, ollamaUrl: null });
  await server.start();

  const addr = server.address();
  assert.ok(addr.port > 0, "the OS must assign a real port");
  const url = server.url();

  const res = await fetch(`${url}/api/version`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  assert.deepEqual(await res.json(), { version: "0.1.0", status: "ok" });

  const port = addr.port;
  await server.close();
  assert.equal(server.listening, false);

  // The port must be bindable again -- that is what "freed" means.
  const again = new GatewayServer({ port, ollamaUrl: null });
  await again.start();
  assert.equal(again.address().port, port);
  await again.close();
});

test("answers /health and returns a JSON 404 for unknown routes", async () => {
  const server = new GatewayServer({ port: 0, ollamaUrl: null });
  await server.start();
  try {
    const health = await fetch(`${server.url()}/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptimeMs, "number");

    const missing = await fetch(`${server.url()}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "not_found");
  } finally {
    await server.close();
  }
});

test("a second server on a held port rejects with GatewayPortConflictError", async () => {
  const a = new GatewayServer({ port: 0, ollamaUrl: null });
  await a.start();
  const port = a.address().port;

  const b = new GatewayServer({ port, ollamaUrl: null });
  await assert.rejects(
    () => b.start(),
    (err) => {
      assert.ok(err instanceof GatewayPortConflictError, "must be the typed error, not a raw EADDRINUSE");
      assert.equal(err.code, "EADDRINUSE");
      assert.equal(err.port, port);
      return true;
    }
  );

  await a.close();
});

test("close() is idempotent and safe before start()", async () => {
  const server = new GatewayServer({ port: 0, ollamaUrl: null });
  await server.close(); // never started
  await server.start();
  await server.close();
  await server.close(); // second close
  assert.equal(server.listening, false);
});

// ---------------------------------------------------------------------------
// proxying
// ---------------------------------------------------------------------------

test("GET /v1/models returns normalized Ollama models", async () => {
  const ollama = await startMockOllama({
    "GET /api/tags": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(TAGS_BODY));
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["llama3:latest", "qwen2.5-coder:7b"]
    );
    assert.equal(body.data[0].object, "model");
    assert.equal(ollama.requests.filter((r) => r.url === "/api/tags").length, 1);
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

test("GET /v1/models falls back to static models when Ollama is unreachable", async () => {
  // Point at a port nobody is listening on.
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: "http://127.0.0.1:1",
    models: ["oc/muse", { id: "gem/gemini", owned_by: "static" }],
  });
  await gateway.start();
  try {
    const body = await (await fetch(`${gateway.url()}/v1/models`)).json();
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["oc/muse", "gem/gemini"]
    );
    assert.match(body.source, /fallback/);
  } finally {
    await gateway.close();
  }
});

test("POST /v1/chat/completions proxies a non-streaming completion and the body verbatim", async () => {
  const REPLY = { model: "llama3:latest", message: { role: "assistant", content: "Hello, world" }, done: true };
  const ollama = await startMockOllama({
    "GET /api/tags": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(TAGS_BODY));
    },
    "POST /api/chat": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(REPLY));
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url });
  await gateway.start();
  try {
    const payload = { model: "llama3:latest", messages: [{ role: "user", content: "hi" }], stream: false };
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.deepEqual(await res.json(), REPLY);

    const forwarded = ollama.requests.find((r) => r.url === "/api/chat");
    assert.ok(forwarded, "the gateway must call Ollama's chat endpoint");
    assert.deepEqual(JSON.parse(forwarded.body), payload, "the request body must be forwarded unchanged");
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

test("POST /v1/chat/completions streams chunks through without corruption", async () => {
  const lines = [
    { model: "llama3:latest", message: { role: "assistant", content: "Hel" }, done: false },
    { model: "llama3:latest", message: { role: "assistant", content: "lo" }, done: false },
    { model: "llama3:latest", message: { role: "assistant", content: "" }, done: true },
  ];
  const expected = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

  const ollama = await startMockOllama({
    "POST /api/chat": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      // Write in two flushes to exercise chunk boundaries, not one big string.
      res.write(expected.slice(0, 40));
      res.write(expected.slice(40));
      res.end();
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3:latest", messages: [{ role: "user", content: "hi" }], stream: true }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/x-ndjson/);

    const text = await res.text();
    assert.equal(text, expected, "stream framing must survive the proxy");

    const parsed = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(parsed, lines);
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

test("POST /v1/chat/completions rejects a malformed body with a JSON 400", async () => {
  const gateway = new GatewayServer({ port: 0, ollamaUrl: "http://127.0.0.1:1" });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_json");
  } finally {
    await gateway.close();
  }
});

test("POST /v1/chat/completions returns 502 when the local provider is down", async () => {
  const gateway = new GatewayServer({ port: 0, ollamaUrl: "http://127.0.0.1:1" });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "upstream_unreachable");
  } finally {
    await gateway.close();
  }
});
