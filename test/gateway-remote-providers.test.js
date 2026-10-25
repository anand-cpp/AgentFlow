// Remote provider routing for the standalone gateway.
//
// Two layers are exercised and they fail differently:
//
//   1. Resolution. `resolveTargetProvider` is pure: given a model id and an
//      environment it must pick the right upstream, strip the prefix, and refuse
//      a remote provider whose key is missing -- a decision that must be right
//      *before* a byte moves, because a wrong guess silently routes the request
//      somewhere it was never meant to go.
//
//   2. Dispatch. A mock OpenAI-compatible provider (a real node:http server, not
//      a stubbed fetch) is stood up on a local port and the gateway is pointed at
//      it. That exercises the whole path -- header injection, model rewriting,
//      SSE pass-through, and error sanitization -- against real sockets.
//
// Secret safety is a first-class assertion here, not an afterthought: the raw
// key must never appear in a client response, a forwarded body, or an error
// message that quotes the request back.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GatewayServer,
  ProviderAuthMissingError,
  PROVIDERS,
  mergeProviders,
  resolveTargetProvider,
} from "../src/core/gateway-server.js";

import { VERSION } from "../src/core/version.js";
import { complete, GatewayError } from "../src/core/gateway.js";

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
 * A mock OpenAI-compatible remote provider.
 *
 * Records every request -- method, url, body, and headers -- so a test can prove
 * the gateway injected the right Authorization header and the stripped model id.
 */
function startMockProvider(routes) {
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
          res.end(JSON.stringify({ error: { message: "no mock route" } }));
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

/** Parse SSE text into the JSON payloads of its data: lines (excluding [DONE]). */
function parseSSE(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length))
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d));
}

// ---------------------------------------------------------------------------
// unit: registry shape
// ---------------------------------------------------------------------------

test("PROVIDERS declares the twelve upstreams with their env keys", () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), [
    "cerebras",
    "cloudflare",
    "deepinfra",
    "fireworks",
    "gemini",
    "groq",
    "hf",
    "mistral",
    "ollama",
    "openrouter",
    "sambanova",
    "together",
  ]);
  assert.equal(PROVIDERS.groq.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(PROVIDERS.cerebras.baseUrl, "https://api.cerebras.ai/v1");
  assert.equal(PROVIDERS.mistral.baseUrl, "https://api.mistral.ai/v1");
  assert.equal(PROVIDERS.gemini.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(PROVIDERS.openrouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(PROVIDERS.together.baseUrl, "https://api.together.xyz/v1");
  assert.equal(PROVIDERS.fireworks.baseUrl, "https://api.fireworks.ai/inference/v1");
  assert.equal(PROVIDERS.deepinfra.baseUrl, "https://api.deepinfra.com/v1/openai");
  assert.equal(PROVIDERS.sambanova.baseUrl, "https://api.sambanova.ai/v1");
  assert.equal(PROVIDERS.hf.baseUrl, "https://api-inference.huggingface.co/v1");
  assert.deepEqual(PROVIDERS.gemini.envKeys, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
  assert.deepEqual(PROVIDERS.hf.envKeys, ["HF_TOKEN"]);
  assert.equal(PROVIDERS.ollama.local, true);
  assert.deepEqual(PROVIDERS.ollama.envKeys, []);

  // Cloudflare is the only multiKey provider: a token alone cannot build its URL.
  assert.equal(PROVIDERS.cloudflare.multiKey, true);
  assert.deepEqual(PROVIDERS.cloudflare.envKeys, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
  assert.match(PROVIDERS.cloudflare.baseUrl, /\{CLOUDFLARE_ACCOUNT_ID\}/);

  // Every non-local provider must carry the wizard/doctor metadata or the setup
  // summary would silently under-report a provider's free tier.
  for (const [name, raw] of Object.entries(PROVIDERS)) {
    const spec = /** @type {any} */ (raw);
    if (spec.local) continue;
    assert.ok(spec.models.length > 0, `${name} must list at least one model`);
    assert.equal(typeof spec.label, "string", `${name} needs a label`);
    assert.match(spec.signupUrl, /^https:\/\//, `${name} needs an https signup URL`);
    assert.equal(typeof spec.freeTier, "string", `${name} needs a free-tier note`);
    assert.equal(typeof spec.creditCard, "boolean", `${name} must declare creditCard`);
  }
});

test("mergeProviders overrides one field without dropping the rest of the spec", () => {
  const merged = mergeProviders({ groq: { baseUrl: "http://127.0.0.1:9999" } });
  assert.equal(merged.groq.baseUrl, "http://127.0.0.1:9999");
  assert.deepEqual(merged.groq.envKeys, ["GROQ_API_KEY"], "env keys must survive the override");
  assert.ok(merged.groq.models.length > 0, "catalogue must survive the override");
  assert.equal(merged.cerebras.baseUrl, PROVIDERS.cerebras.baseUrl, "untouched providers are unchanged");
});

// ---------------------------------------------------------------------------
// unit: resolution
// ---------------------------------------------------------------------------

test("resolveTargetProvider strips a known remote prefix and resolves the key", () => {
  const env = { GROQ_API_KEY: "gsk-secret" };
  const t = resolveTargetProvider("groq/llama-3.3-70b-versatile", env);
  assert.equal(t.provider, "groq");
  assert.equal(t.model, "llama-3.3-70b-versatile", "the upstream must get the stripped model name");
  assert.equal(t.baseUrl, PROVIDERS.groq.baseUrl);
  assert.equal(t.apiKey, "gsk-secret");
  assert.equal(t.local, false);
});

test("resolveTargetProvider resolves every documented prefix", () => {
  const env = {
    GROQ_API_KEY: "k1",
    CEREBRAS_API_KEY: "k2",
    MISTRAL_API_KEY: "k3",
    GEMINI_API_KEY: "k4",
    OPENROUTER_API_KEY: "k5",
  };
  const cases = [
    ["cerebras/llama3.1-70b", "cerebras", "llama3.1-70b"],
    ["gemini/gemini-2.0-flash", "gemini", "gemini-2.0-flash"],
    ["mistral/mistral-small-latest", "mistral", "mistral-small-latest"],
    ["openrouter/auto", "openrouter", "auto"],
  ];
  for (const [id, provider, model] of cases) {
    const t = resolveTargetProvider(id, env);
    assert.equal(t.provider, provider, id);
    assert.equal(t.model, model, id);
    assert.equal(t.local, false, id);
  }
});

test("resolveTargetProvider resolves the six new prefixes", () => {
  const env = {
    TOGETHER_API_KEY: "t",
    FIREWORKS_API_KEY: "f",
    DEEPINFRA_API_KEY: "d",
    SAMBANOVA_API_KEY: "s",
    HF_TOKEN: "h",
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct-123",
  };
  const cases = [
    ["together/meta-llama/Llama-3.3-70B-Instruct-Turbo", "together", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    ["fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct", "fireworks", "accounts/fireworks/models/llama-v3p3-70b-instruct"],
    ["deepinfra/meta-llama/Llama-3.3-70B-Instruct", "deepinfra", "meta-llama/Llama-3.3-70B-Instruct"],
    ["sambanova/Meta-Llama-3.3-70B-Instruct", "sambanova", "Meta-Llama-3.3-70B-Instruct"],
    ["hf/meta-llama/Llama-3.1-8B-Instruct", "hf", "meta-llama/Llama-3.1-8B-Instruct"],
  ];
  for (const [id, provider, model] of cases) {
    const t = resolveTargetProvider(id, env);
    assert.equal(t.provider, provider, id);
    assert.equal(t.model, model, id);
    assert.equal(t.local, false, id);
  }
});

test("resolveTargetProvider builds Cloudflare's URL from its account id and requires both keys", () => {
  const full = resolveTargetProvider("cloudflare/@cf/meta/llama-3.1-8b-instruct", {
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ACCOUNT_ID: "acct-123",
  });
  assert.equal(full.provider, "cloudflare");
  assert.equal(full.model, "@cf/meta/llama-3.1-8b-instruct");
  assert.equal(
    full.baseUrl,
    "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1",
    "the {CLOUDFLARE_ACCOUNT_ID} placeholder must be substituted"
  );
  assert.equal(full.apiKey, "cf-token");

  // A token without the account id is not usable, and the message must say
  // "and" (both are required) rather than the "or" of an alternatives list.
  assert.throws(
    () => resolveTargetProvider("cloudflare/@cf/meta/llama-3.1-8b-instruct", { CLOUDFLARE_API_TOKEN: "cf-token" }),
    (err) => {
      assert.ok(err instanceof ProviderAuthMissingError);
      assert.equal(err.allRequired, true);
      assert.match(err.message, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
      return true;
    }
  );
});

test("resolveTargetProvider maps the new bare-id shapes", () => {
  assert.equal(
    resolveTargetProvider("@cf/meta/llama-3.1-8b-instruct", { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }).provider,
    "cloudflare"
  );
  assert.equal(resolveTargetProvider("Meta-Llama-3.3-70B-Instruct", { SAMBANOVA_API_KEY: "k" }).provider, "sambanova");
  // Shaped like sambanova but no key: stay local rather than guess.
  assert.equal(resolveTargetProvider("Meta-Llama-3.3-70B-Instruct", {}).provider, "ollama");
});

test("resolveTargetProvider treats ollama/ as local and strips its prefix", () => {
  const t = resolveTargetProvider("ollama/qwen2.5-coder", {});
  assert.equal(t.provider, "ollama");
  assert.equal(t.model, "qwen2.5-coder");
  assert.equal(t.local, true);
  assert.equal(t.apiKey, null);
});

test("resolveTargetProvider uses GOOGLE_API_KEY as a gemini fallback", () => {
  const t = resolveTargetProvider("gemini/gemini-2.0-flash", { GOOGLE_API_KEY: "gkey" });
  assert.equal(t.provider, "gemini");
  assert.equal(t.apiKey, "gkey");
});

test("resolveTargetProvider throws ProviderAuthMissingError for a keyless remote prefix", () => {
  assert.throws(
    () => resolveTargetProvider("groq/llama-3.3-70b-versatile", {}),
    (err) => {
      assert.ok(err instanceof ProviderAuthMissingError);
      assert.equal(err.code, "provider_auth_missing");
      assert.equal(err.provider, "groq");
      assert.equal(err.message, "Provider groq requires GROQ_API_KEY to be set in environment");
      return true;
    }
  );
});

test("ProviderAuthMissingError names both gemini env vars", () => {
  assert.throws(
    () => resolveTargetProvider("gemini/gemini-2.0-flash", {}),
    (err) => {
      assert.match(/** @type {Error} */ (err).message, /GEMINI_API_KEY \(or GOOGLE_API_KEY\)/);
      return true;
    }
  );
});

test("resolveTargetProvider maps a bare provider-shaped id when a key exists", () => {
  assert.equal(resolveTargetProvider("gemini-2.0-flash", { GEMINI_API_KEY: "k" }).provider, "gemini");
  assert.equal(resolveTargetProvider("llama-3.3-70b-versatile", { GROQ_API_KEY: "k" }).provider, "groq");
  assert.equal(resolveTargetProvider("mixtral-8x7b-32768", { GROQ_API_KEY: "k" }).provider, "groq");
});

test("resolveTargetProvider falls back to ollama for a shaped id with no key, and for unknown ids", () => {
  assert.equal(resolveTargetProvider("gemini-2.0-flash", {}).provider, "ollama");
  assert.equal(resolveTargetProvider("llama-3.3-70b-versatile", {}).provider, "ollama");
  assert.equal(resolveTargetProvider("qwen2.5-coder:7b", { GROQ_API_KEY: "k" }).provider, "ollama");
  // An unknown prefix is part of the local model name, not a provider selector.
  const t = resolveTargetProvider("oc/muse", { GROQ_API_KEY: "k" });
  assert.equal(t.provider, "ollama");
  assert.equal(t.model, "oc/muse");
});

// ---------------------------------------------------------------------------
// integration: non-streaming dispatch
// ---------------------------------------------------------------------------

test("POST /v1/chat/completions forwards a non-stream request to the remote provider", async () => {
  const REPLY = {
    id: "chatcmpl-upstream",
    object: "chat.completion",
    model: "llama-3.3-70b-versatile",
    choices: [{ index: 0, message: { role: "assistant", content: "Hi from Groq" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
  const mock = await startMockProvider({
    "POST /chat/completions": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(REPLY));
    },
  });
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "mock-groq-key" },
    providers: { groq: { baseUrl: mock.url } },
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "groq/llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });

    assert.equal(res.status, 200);
    // The client gets the provider's OpenAI body back unchanged.
    assert.deepEqual(await res.json(), REPLY);

    const forwarded = mock.requests.find((r) => r.url === "/chat/completions");
    assert.ok(forwarded, "the gateway must call the provider's chat endpoint");
    assert.equal(forwarded.headers.authorization, "Bearer mock-groq-key");
    assert.equal(forwarded.headers["user-agent"], `AgentFlow-Gateway/${VERSION}`);
    const sent = JSON.parse(forwarded.body);
    assert.equal(sent.model, "llama-3.3-70b-versatile", "the prefix must be stripped before forwarding");
    assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
  } finally {
    await gateway.close();
    await closeServer(mock.server);
  }
});

// ---------------------------------------------------------------------------
// integration: streaming dispatch
// ---------------------------------------------------------------------------

test("POST /v1/chat/completions passes a remote SSE stream through verbatim", async () => {
  const upstreamSSE =
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";

  const mock = await startMockProvider({
    "POST /chat/completions": (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Two flushes to exercise chunk boundaries, not one big string.
      res.write(upstreamSSE.slice(0, 50));
      res.write(upstreamSSE.slice(50));
      res.end();
    },
  });
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "mock-groq-key" },
    providers: { groq: { baseUrl: mock.url } },
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "groq/llama-3.3-70b-versatile",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(res.headers.get("cache-control") || "", /no-cache/);

    const text = await res.text();
    assert.equal(text, upstreamSSE, "a remote stream must be forwarded byte-for-byte");

    const chunks = parseSSE(text);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((c) => c.choices[0].delta), [
      { role: "assistant", content: "Hel" },
      { content: "lo" },
      {},
    ]);

    const forwarded = mock.requests.find((r) => r.url === "/chat/completions");
    assert.equal(forwarded.headers.authorization, "Bearer mock-groq-key");
    assert.equal(JSON.parse(forwarded.body).model, "llama-3.3-70b-versatile");
  } finally {
    await gateway.close();
    await closeServer(mock.server);
  }
});

// ---------------------------------------------------------------------------
// integration: credential guard
// ---------------------------------------------------------------------------

test("POST /v1/chat/completions rejects a remote model whose key is missing", async () => {
  const gateway = new GatewayServer({ port: 0, ollamaUrl: null, env: {} });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cerebras/llama3.1-70b", messages: [] }),
    });

    assert.ok(res.status === 400 || res.status === 401, `expected 400/401, got ${res.status}`);
    const body = /** @type {any} */ (await res.json());
    assert.equal(body.error.code, "provider_auth_missing");
    assert.equal(body.error.type, "auth_error");
    assert.match(body.error.message, /CEREBRAS_API_KEY/);
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------------------
// integration: error sanitization
// ---------------------------------------------------------------------------

test("a remote error body is sanitized before it reaches the client", async () => {
  // Built from parts so this source file never contains an sk-shaped literal: the
  // repo's own scan-secrets would (correctly) flag one, and the honest fix is a
  // synthetic token assembled at runtime, not an allowlist entry.
  const leakedToken = "sk-" + "abcdefghijklmnopqrstuvwxyz0123";
  const mock = await startMockProvider({
    "POST /chat/completions": (_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      // The provider leaks the key we sent, a token we never saw, and a query
      // secret. None of it may survive to the client.
      res.end(
        JSON.stringify({
          error: {
            message: `boom Bearer mock-groq-key ${leakedToken} https://api.groq.com/v1?api_key=topsecret123`,
          },
        })
      );
    },
  });
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "mock-groq-key" },
    providers: { groq: { baseUrl: mock.url } },
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "groq/llama-3.3-70b-versatile", messages: [] }),
    });

    assert.equal(res.status, 500, "the upstream status must be preserved");
    const body = /** @type {any} */ (await res.json());
    assert.equal(body.error.type, "upstream_error");

    const message = body.error.message;
    assert.ok(!message.includes("mock-groq-key"), "the injected key must never be echoed");
    assert.ok(!message.includes(leakedToken), "token patterns must be masked");
    assert.ok(!message.includes("topsecret123"), "query secrets must be masked");
    assert.match(message, /\*\*\*/, "something must visibly be redacted");
  } finally {
    await gateway.close();
    await closeServer(mock.server);
  }
});

// ---------------------------------------------------------------------------
// integration: provider rate-limit feedback
// ---------------------------------------------------------------------------

test("a provider Retry-After is forwarded and parsed into the GatewayError", async () => {
  const mock = await startMockProvider({
    "POST /chat/completions": (_req, res) => {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "7",
      });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
    },
  });
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "mock-groq-key" },
    providers: { groq: { baseUrl: mock.url } },
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "groq/llama-3.3-70b-versatile", messages: [] }),
    });
    assert.equal(res.status, 429, "the upstream status must be preserved");
    assert.equal(res.headers.get("retry-after"), "7", "the header must reach the client");

    await assert.rejects(
      complete({ baseUrl: gateway.url(), apiKey: null, probeTimeoutMs: 2000 }, "groq/llama-3.3-70b-versatile", "hi"),
      (err) => {
        assert.ok(err instanceof GatewayError);
        assert.equal(err.status, 429);
        assert.equal(err.retryAfter, "7");
        assert.equal(err.retryAfterMs, 7_000);
        assert.equal(err.retryAfterSource, "seconds");
        return true;
      }
    );
  } finally {
    await gateway.close();
    await closeServer(mock.server);
  }
});

test("a 429 without Retry-After stays unknown rather than inventing a delay", async () => {
  const mock = await startMockProvider({
    "POST /chat/completions": (_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
    },
  });
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "mock-groq-key" },
    providers: { groq: { baseUrl: mock.url } },
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "groq/llama-3.3-70b-versatile", messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), null);

    await assert.rejects(
      complete({ baseUrl: gateway.url(), apiKey: null, probeTimeoutMs: 2000 }, "groq/llama-3.3-70b-versatile", "hi"),
      (err) => {
        const e = /** @type {Error & { retryAfter?: string|null; retryAfterMs?: number|null; retryAfterSource?: string|null }} */ (err);
        assert.equal(e.retryAfter, null);
        assert.equal(e.retryAfterMs, null);
        assert.equal(e.retryAfterSource, null);
        return true;
      }
    );
  } finally {
    await gateway.close();
    await closeServer(mock.server);
  }
});

// ---------------------------------------------------------------------------
// integration: unreachable provider
// ---------------------------------------------------------------------------

test("POST /v1/chat/completions returns 502 when a remote provider is unreachable", async () => {
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "mock-groq-key" },
    providers: { groq: { baseUrl: "http://127.0.0.1:1" } },
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "groq/llama-3.3-70b-versatile", messages: [] }),
    });
    assert.equal(res.status, 502);
    const body = /** @type {any} */ (await res.json());
    assert.equal(body.error.code, "upstream_unreachable");
    assert.doesNotMatch(body.error.message, /mock-groq-key/);
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------------------
// integration: model aggregation
// ---------------------------------------------------------------------------

test("GET /v1/models aggregates only providers whose key is present", async () => {
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    env: { GROQ_API_KEY: "present" }, // CEREBRAS_API_KEY deliberately absent
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(res.status, 200);
    const body = /** @type {any} */ (await res.json());
    assert.equal(body.object, "list");

    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("groq/llama-3.3-70b-versatile"), "a keyed provider's catalogue must appear");
    assert.ok(!ids.some((id) => id.startsWith("cerebras/")), "an unkeyed provider must not appear");
    assert.ok(!ids.some((id) => id.startsWith("mistral/")), "other unkeyed providers must not appear");

    const groq = body.data.find((m) => m.id === "groq/llama-3.3-70b-versatile");
    assert.equal(groq.object, "model");
    assert.equal(groq.owned_by, "groq");
  } finally {
    await gateway.close();
  }
});

test("GET /v1/models merges ollama models with keyed remote catalogues", async () => {
  const mock = await startMockProvider({
    "GET /api/tags": (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3:latest", model: "llama3:latest" }] }));
    },
  });
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: mock.url,
    env: { OPENROUTER_API_KEY: "present" },
  });
  await gateway.start();
  try {
    const body = /** @type {any} */ (await (await fetch(`${gateway.url()}/v1/models`)).json());
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("llama3:latest"), "local models must be preserved");
    assert.ok(ids.includes("openrouter/auto"), "the keyed remote catalogue must be merged in");
    assert.match(body.source, /remote/);
  } finally {
    await gateway.close();
    await closeServer(mock.server);
  }
});

test("GET /v1/models advertises a new provider once its key is present", async () => {
  const gateway = new GatewayServer({ port: 0, ollamaUrl: null, env: { TOGETHER_API_KEY: "present" } });
  await gateway.start();
  try {
    const body = /** @type {any} */ (await (await fetch(`${gateway.url()}/v1/models`)).json());
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("together/meta-llama/Llama-3.3-70B-Instruct-Turbo"));
    assert.ok(!ids.some((id) => id.startsWith("sambanova/")), "unkeyed new providers stay hidden");
  } finally {
    await gateway.close();
  }
});

test("GET /v1/models hides a multiKey provider that is only half configured", async () => {
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    // Token present, account id missing: the provider cannot authenticate, so
    // listing its models would only turn every selection into a 400.
    env: { CLOUDFLARE_API_TOKEN: "only-half" },
  });
  await gateway.start();
  try {
    const body = /** @type {any} */ (await (await fetch(`${gateway.url()}/v1/models`)).json());
    assert.ok(!body.data.some((m) => m.id.startsWith("cloudflare/")));
  } finally {
    await gateway.close();
  }
});

// ---------------------------------------------------------------------------
// integration: keys.env auto-loading
// ---------------------------------------------------------------------------

test("GatewayServer loads keys from a keys file, with process.env winning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-keys-"));
  const keysFile = path.join(dir, "keys.env");
  // Written by hand rather than through the module so the test proves the
  // gateway parses the on-disk format, not that it can round-trip its own.
  fs.writeFileSync(
    keysFile,
    ["# aflow keys", "GROQ_API_KEY=from-file", "CEREBRAS_API_KEY=from-file-cerebras", ""].join("\n")
  );

  try {
    const gateway = new GatewayServer({
      port: 0,
      ollamaUrl: null,
      keysFile,
      // GROQ is overridden in the real environment; CEREBRAS comes only from the file.
      env: { GROQ_API_KEY: "from-env" },
    });
    await gateway.start();
    try {
      const body = /** @type {any} */ (await (await fetch(`${gateway.url()}/v1/models`)).json());
      const ids = body.data.map((m) => m.id);
      assert.ok(ids.some((id) => id.startsWith("groq/")), "a file key must be loaded");
      assert.ok(ids.some((id) => id.startsWith("cerebras/")), "a file-only key must be loaded");

      // The env value must be what actually authenticates, not the file value.
      const t = resolveTargetProvider("groq/llama-3.3-70b-versatile", gateway.env);
      assert.equal(t.apiKey, "from-env", "process.env must take precedence over the file");
    } finally {
      await gateway.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("GatewayServer starts with no keys file and an empty environment", async () => {
  const gateway = new GatewayServer({
    port: 0,
    ollamaUrl: null,
    keysFile: path.join(os.tmpdir(), "af-does-not-exist-keys.env"),
    env: {},
  });
  await gateway.start();
  try {
    const res = await fetch(`${gateway.url()}/v1/models`);
    assert.equal(res.status, 200, "a missing keys file must not stop the gateway from starting");
  } finally {
    await gateway.close();
  }
});
