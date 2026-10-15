// The standalone in-repo gateway server.
//
// Two things are under test and they are different in kind:
//
//   1. Lifecycle. The server must bind, answer, and -- the part that is easy to
//      get wrong -- fully release the port on close so a restart or a test can
//      bind it again. A second server on a held port must fail with a *typed*
//      error (GatewayPortConflictError), not an unhandled 'error' event.
//
//   2. The boundary. /v1/models is normalized from Ollama's /api/tags, and
//      /v1/chat/completions is translated: the request into Ollama's native
//      contract, and the reply back into OpenAI's -- SSE when streaming,
//      chat.completion when not. A mock Ollama (a real node:http server, not a
//      stubbed fetch) is used so the whole path -- sockets, headers, stream
//      framing -- is exercised rather than simulated.
//
//   3. Auth and the bind guard. When an API key is configured, /v1/* requires a
//      Bearer token while health stays open, and binding 0.0.0.0 without a key
//      is refused.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import {
  GatewayServer,
  GatewayPortConflictError,
  GatewayInsecureError,
  normaliseOllamaModels,
  defaultServerDir,
  newCompletionId,
  toOllamaChatRequest,
  ollamaToOpenAIResponse,
  translateOllamaStreamToOpenAI,
} from "../src/core/gateway-server.js";

import { VERSION } from "../src/core/version.js";

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
      resolve({ server, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, requests });
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
// unit: OpenAI <-> Ollama translation
// ---------------------------------------------------------------------------

/** Collect an async iterable into an array. */
async function collect(iterable) {
  const out = [];
  for await (const v of iterable) out.push(v);
  return out;
}

/** Turn a list of Ollama chunk objects into an NDJSON async iterable. */
function ndjsonSource(objects) {
  const text = objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
  return (async function* () {
    yield text;
  })();
}

/** Parse SSE text into the JSON payloads of its data: lines (excluding [DONE]). */
function parseSSE(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d));
}

test("newCompletionId is a stable chatcmpl- id", () => {
  const a = newCompletionId();
  const b = newCompletionId();
  assert.match(a, /^chatcmpl-[0-9a-f]{24}$/);
  assert.notEqual(a, b, "each request must get a fresh id");
});

test("toOllamaChatRequest maps OpenAI knobs into Ollama options", () => {
  const body = toOllamaChatRequest({
    model: "qwen2.5",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 64,
    temperature: 0.2,
    top_p: 0.9,
    stop: ["\n"],
  });
  assert.equal(body.model, "qwen2.5");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.stream, false);
  assert.deepEqual(body.options, { temperature: 0.2, top_p: 0.9, num_predict: 64, stop: ["\n"] });
});

test("toOllamaChatRequest omits options when no generation knobs are given", () => {
  const body = toOllamaChatRequest({ model: "m", messages: [], stream: true });
  assert.deepEqual(body, { model: "m", messages: [], stream: true });
  assert.equal("options" in body, false);
});

test("ollamaToOpenAIResponse shapes a non-stream reply with usage", () => {
  const out = ollamaToOpenAIResponse(
    { message: { role: "assistant", content: "Hello" }, prompt_eval_count: 5, eval_count: 3, done: true },
    { model: "qwen2.5", id: "chatcmpl-fixed", created: 1000 }
  );
  assert.equal(out.id, "chatcmpl-fixed");
  assert.equal(out.object, "chat.completion");
  assert.equal(out.created, 1000);
  assert.equal(out.model, "qwen2.5");
  assert.deepEqual(out.choices, [
    { index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
  ]);
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
});

test("ollamaToOpenAIResponse defaults usage to zero and reason to stop", () => {
  const out = ollamaToOpenAIResponse({ message: { content: "x" } }, { model: "m" });
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.equal(out.choices[0].message.role, "assistant");
});

test("translateOllamaStreamToOpenAI emits SSE with role once, content, and [DONE]", async () => {
  const events = await collect(
    translateOllamaStreamToOpenAI(
      ndjsonSource([
        { model: "q", message: { role: "assistant", content: "Hel" }, done: false },
        { model: "q", message: { role: "assistant", content: "lo" }, done: false },
        { model: "q", message: { role: "assistant", content: "" }, done: true },
      ]),
      "q",
      { id: "chatcmpl-fixed", created: 42 }
    )
  );

  assert.ok(events.every((e) => e.startsWith("data: ")), "every event is an SSE data line");
  const done = events.at(-1);
  assert.equal(done, "data: [DONE]\n\n");

  const chunks = parseSSE(events.join(""));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].object, "chat.completion.chunk");
  assert.equal(chunks[0].id, "chatcmpl-fixed");
  assert.equal(chunks[0].created, 42);
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "Hel" });
  assert.deepEqual(chunks[1].choices[0].delta, { content: "lo" }, "role appears only on the first delta");
  assert.equal(chunks[1].choices[0].finish_reason, null);
  assert.deepEqual(chunks[2].choices[0].delta, {});
  assert.equal(chunks[2].choices[0].finish_reason, "stop");
});

test("translateOllamaStreamToOpenAI tolerates a split line, junk, and no done line", async () => {
  // One NDJSON object delivered across two chunks, plus a malformed line, and no
  // done:true -- the translator must still flush a terminator.
  const source = (async function* () {
    yield '{"message":{"content":"par';
    yield 't"},"done":false}\n';
    yield "not json at all\n";
  })();
  const events = await collect(translateOllamaStreamToOpenAI(source, "m", { id: "chatcmpl-x", created: 1 }));
  const chunks = parseSSE(events.join(""));
  assert.equal(chunks.length, 2, "one content chunk + one synthesized finish");
  assert.equal(chunks[0].choices[0].delta.content, "part");
  assert.equal(chunks[1].choices[0].finish_reason, "stop");
  assert.equal(events.at(-1), "data: [DONE]\n\n");
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
  assert.deepEqual(await res.json(), { version: VERSION, status: "ok" });

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
    const body = /** @type {any} */ (await health.json());
    assert.equal(body.status, "ok");
    assert.equal(typeof body.uptimeMs, "number");

    const missing = await fetch(`${server.url()}/nope`);
    assert.equal(missing.status, 404);
    assert.equal((/** @type {any} */ (await missing.json())).error.code, "not_found");
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
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url, env: {} });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(res.status, 200);
    const body = /** @type {any} */ (await res.json());
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
    env: {},
  });
  await gateway.start();
  try {
    const body = /** @type {any} */ (await (await fetch(`${gateway.url()}/v1/models`)).json());
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["oc/muse", "gem/gemini"]
    );
    assert.match(body.source, /fallback/);
  } finally {
    await gateway.close();
  }
});

test("POST /v1/chat/completions translates a non-stream reply and sends Ollama the native request", async () => {
  const REPLY = {
    model: "llama3:latest",
    message: { role: "assistant", content: "Hello, world" },
    done: true,
    prompt_eval_count: 7,
    eval_count: 4,
  };
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

    // The caller sees OpenAI, never Ollama.
    const body = /** @type {any} */ (await res.json());
    assert.equal(body.object, "chat.completion");
    assert.match(body.id, /^chatcmpl-/);
    assert.equal(body.model, "llama3:latest");
    assert.deepEqual(body.choices, [
      { index: 0, message: { role: "assistant", content: "Hello, world" }, finish_reason: "stop" },
    ]);
    assert.deepEqual(body.usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });

    // The upstream sees Ollama's native contract.
    const forwarded = ollama.requests.find((r) => r.url === "/api/chat");
    assert.ok(forwarded, "the gateway must call Ollama's chat endpoint");
    assert.deepEqual(JSON.parse(forwarded.body), { model: "llama3:latest", messages: payload.messages, stream: false });
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

test("POST /v1/chat/completions streams Ollama NDJSON back as OpenAI SSE", async () => {
  const lines = [
    { model: "llama3:latest", message: { role: "assistant", content: "Hel" }, done: false },
    { model: "llama3:latest", message: { role: "assistant", content: "lo" }, done: false },
    { model: "llama3:latest", message: { role: "assistant", content: "" }, done: true },
  ];
  const ndjson = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

  const ollama = await startMockOllama({
    "POST /api/chat": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      // Write in two flushes to exercise chunk boundaries, not one big string.
      res.write(ndjson.slice(0, 40));
      res.write(ndjson.slice(40));
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
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(res.headers.get("cache-control") || "", /no-cache/);

    const text = await res.text();
    assert.ok(text.endsWith("data: [DONE]\n\n"), "the stream must terminate with [DONE]");

    const chunks = parseSSE(text);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((c) => c.choices[0].delta), [
      { role: "assistant", content: "Hel" },
      { content: "lo" },
      {},
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
    // One id for the whole stream.
    assert.equal(new Set(chunks.map((c) => c.id)).size, 1);
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
    assert.equal((/** @type {any} */ (await res.json())).error.code, "invalid_json");
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
    assert.equal((/** @type {any} */ (await res.json())).error.code, "upstream_unreachable");
  } finally {
    await gateway.close();
  }
});

test("POST /v1/chat/completions maps an upstream error into an OpenAI error envelope", async () => {
  const ollama = await startMockOllama({
    "POST /api/chat": (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "model 'nope' not found" }));
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nope", messages: [] }),
    });
    assert.equal(res.status, 404, "the upstream status must be preserved");
    const body = /** @type {any} */ (await res.json());
    assert.equal(body.error.type, "upstream_error");
    assert.match(body.error.message, /not found/);
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

test("auth: /v1/* requires a Bearer key when configured, health stays open", async () => {
  const gateway = new GatewayServer({ port: 0, ollamaUrl: null, models: ["oc/muse"], apiKey: "s3cret-key" });
  await gateway.start();
  try {
    // Health and version remain open so liveness probes need no credential.
    assert.equal((await fetch(`${gateway.url()}/api/version`)).status, 200);
    assert.equal((await fetch(`${gateway.url()}/health`)).status, 200);

    const noAuth = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(noAuth.status, 401);
    assert.deepEqual(await noAuth.json(), {
      error: { message: "Invalid API key", type: "auth_error", code: "invalid_api_key" },
    });
    assert.equal(noAuth.headers.get("www-authenticate"), 'Bearer realm="agentflow"');

    const wrong = await fetch(`${gateway.url()}/v1/models`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${gateway.url()}/v1/models`, { headers: { Authorization: "Bearer s3cret-key" } });
    assert.equal(ok.status, 200);
  } finally {
    await gateway.close();
  }
});

test("auth: a null key disables auth, preserving local-only behaviour", async () => {
  const gateway = new GatewayServer({ port: 0, ollamaUrl: null, models: ["oc/muse"] });
  await gateway.start();
  try {
    assert.equal((await fetch(`${gateway.url()}/v1/models`)).status, 200);
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------------------
// bind guards
// ---------------------------------------------------------------------------

test("refuses to bind 0.0.0.0 without an API key", async () => {
  const server = new GatewayServer({ port: 0, host: "0.0.0.0", ollamaUrl: null });
  await assert.rejects(
    () => server.start(),
    (err) => {
      assert.ok(err instanceof GatewayInsecureError, "must be the typed error");
      assert.equal(err.code, "insecure_bind");
      assert.match(err.message, /Refusing to bind 0\.0\.0\.0 without an API key/);
      return true;
    }
  );
  assert.equal(server.listening, false, "no socket may have been opened");
});

test("warns when an API key is set but the server is bound to loopback", async () => {
  const warns = [];
  const server = new GatewayServer({
    port: 0,
    host: "127.0.0.1",
    apiKey: "k",
    ollamaUrl: null,
    logger: { warn: (m) => warns.push(m) },
  });
  await server.start();
  try {
    assert.equal(warns.length, 1);
    assert.match(warns[0], /bound to loopback/);
  } finally {
    await server.close();
  }
});

test("binds 0.0.0.0 when an API key is provided", async () => {
  const server = new GatewayServer({ port: 0, host: "0.0.0.0", apiKey: "k", ollamaUrl: null });
  await server.start();
  try {
    assert.equal(server.listening, true);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// graceful shutdown
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("graceful close lets an in-flight request finish before releasing the port", async () => {
  // An Ollama that is slow enough that the request is still running when close()
  // is called -- the exact window a SIGTERM drain must protect.
  const ollama = await startMockOllama({
    "GET /api/tags": (req, res, body, requests) => {
      void body;
      void requests;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(TAGS_BODY));
      }, 150);
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url });
  await gateway.start();
  const url = gateway.url();
  const port = gateway.address().port;

  // Fire the request but do not await it yet, so close() lands mid-flight.
  // Connection: close keeps the socket from pooling, so once the drained
  // response is sent the listener can release immediately rather than waiting
  // out the grace window for an idle keep-alive socket.
  const pending = fetch(`${url}/v1/models`, { headers: { connection: "close" } });
  await delay(40);
  const closing = gateway.close({ graceMs: 2000 });

  const res = await pending;
  assert.equal(res.status, 200, "the in-flight request must be drained, not aborted");
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.object, "list");
  assert.equal(body.data.length, TAGS_BODY.models.length);

  await closing;
  assert.equal(gateway.listening, false);

  // The port must be fully released: a fresh server can take it.
  const again = new GatewayServer({ port, ollamaUrl: null });
  await again.start();
  assert.equal(again.address().port, port);
  await again.close();
  await closeServer(ollama.server);
});

test("graceful close enforces the deadline on a request that overruns it", async () => {
  // Ollama slower than the grace window. The request cannot finish in time, so
  // the drain must give up, force-close, and let close() resolve on schedule.
  const ollama = await startMockOllama({
    "GET /api/tags": (req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(TAGS_BODY));
      }, 1000);
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url });
  await gateway.start();
  const url = gateway.url();

  const pending = fetch(`${url}/v1/models`);
  await delay(40);

  const started = Date.now();
  await gateway.close({ graceMs: 150 });
  const elapsed = Date.now() - started;

  // close() waits no longer than the grace window (plus scheduling slack).
  assert.ok(elapsed < 900, `close() must not wait for the slow request (waited ${elapsed}ms)`);
  assert.equal(gateway.listening, false);

  // The overrun request is terminated rather than left hanging.
  await assert.rejects(() => pending);

  await closeServer(ollama.server);
});


// ---------------------------------------------------------------------------
// /v1/models listing cache
// ---------------------------------------------------------------------------

test("caches the /v1/models listing for modelsCacheMs", async () => {
  const ollama = await startMockOllama({
    "GET /api/tags": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(TAGS_BODY));
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url, modelsCacheMs: 60_000 });
  await gateway.start();
  try {
    const first = await (await fetch(`${gateway.url()}/v1/models`)).json();
    const second = await (await fetch(`${gateway.url()}/v1/models`)).json();

    assert.deepEqual(second, first, "the cached reply must be identical");
    assert.equal(
      ollama.requests.filter((r) => r.url === "/api/tags").length,
      1,
      "the second list must be served from cache, not re-query Ollama"
    );
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

test("a modelsCacheMs of 0 disables the cache", async () => {
  const ollama = await startMockOllama({
    "GET /api/tags": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(TAGS_BODY));
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url, modelsCacheMs: 0 });
  await gateway.start();
  try {
    await fetch(`${gateway.url()}/v1/models`);
    await fetch(`${gateway.url()}/v1/models`);
    assert.equal(
      ollama.requests.filter((r) => r.url === "/api/tags").length,
      2,
      "with the cache disabled every list must reach Ollama"
    );
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});

test("the /v1/models cache expires and re-queries upstream", async () => {
  const ollama = await startMockOllama({
    "GET /api/tags": (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(TAGS_BODY));
    },
  });
  const gateway = new GatewayServer({ port: 0, ollamaUrl: ollama.url, modelsCacheMs: 60 });
  await gateway.start();
  try {
    await fetch(`${gateway.url()}/v1/models`);
    await new Promise((r) => setTimeout(r, 90)); // past the 60ms window
    await fetch(`${gateway.url()}/v1/models`);
    assert.equal(
      ollama.requests.filter((r) => r.url === "/api/tags").length,
      2,
      "an expired cache must re-query Ollama"
    );
  } finally {
    await gateway.close();
    await closeServer(ollama.server);
  }
});