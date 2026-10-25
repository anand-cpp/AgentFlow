// `aflow models --detail` diagnostics.
//
// A real localhost server stands in for the gateway, so this exercises the
// command's actual fetch and rendering without a provider or a credential. The
// assertions are about provenance: static cost/limit/tool metadata must be
// distinguishable from dynamic, process-local cooldown state.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { modelsCommand } from "../src/commands/models.js";

function startCatalogue(models) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, owned_by: "test" })) }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {any} */ (server.address());
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

function captureOut() {
  let payload = null;
  let text = null;
  return {
    get payload() {
      return payload;
    },
    get text() {
      return text;
    },
    async init(next, render) {
      payload = next;
      text = render ? render(next) : null;
    },
  };
}

test("models --detail separates static policy metadata from dynamic health", async (t) => {
  const { server, baseUrl } = await startCatalogue(["groq/fast", "acme/paid", "ollama/local"]);
  t.after(() => closeServer(server));

  const out = captureOut();
  await modelsCommand.run({
    config: {
      baseUrl,
      apiKey: null,
      probeTimeoutMs: 2000,
      defaultModel: "ollama/local",
      preferFree: true,
      allowPaidFallback: false,
      modelHints: {
        "groq/fast": { toolCalling: true },
        "acme/paid": { costClass: "paid" },
      },
    },
    out,
    flags: { detail: true, limit: 10 },
    args: [],
    deps: {
      health: {
        getProviderStatus(provider) {
          if (provider === "groq") {
            return {
              circuitState: "closed",
              cooldownRemainingMs: 5_000,
              cooldownUntil: Date.now() + 5_000,
              cooldownReason: "rate_limited",
              cooldownSource: "retry-after:seconds",
            };
          }
          return { circuitState: "closed", cooldownRemainingMs: 0, cooldownUntil: null };
        },
      },
    },
  });

  const p = out.payload;
  assert.equal(p.modelsTotal, 3);
  assert.deepEqual(p.costCounts, { free: 1, "free-tier": 1, unknown: 0, paid: 1 });

  const byId = Object.fromEntries(p.models.map((m) => [m.id, m]));

  // Explicit intent is labelled before the anonymous ranking is consulted.
  assert.equal(byId["ollama/local"].selection, "explicit");
  assert.equal(byId["ollama/local"].costClass, "free");
  assert.equal(byId["ollama/local"].rank, 1, "free is first in the anonymous policy order");

  // Static metadata: request rate comes from the registry, not from a guess.
  assert.equal(byId["groq/fast"].costClass, "free-tier");
  assert.equal(byId["groq/fast"].selection, "ranked");
  assert.equal(byId["groq/fast"].rank, 2);
  assert.equal(byId["groq/fast"].requestLimit.perMinute, 30);
  assert.equal(byId["groq/fast"].requestLimit.kind, "request-rate");
  assert.equal(byId["groq/fast"].toolCalling, true);

  // Paid fallback is off, so the paid model is not silently ranked as a candidate.
  assert.equal(byId["acme/paid"].selection, "paid-disabled");
  assert.equal(byId["acme/paid"].rank, null);

  // Dynamic health is process-local and is reported separately.
  assert.equal(byId["groq/fast"].health.eligible, false);
  assert.equal(byId["groq/fast"].health.cooldownRemainingMs, 5_000);
  assert.equal(byId["groq/fast"].health.cooldownSource, "retry-after:seconds");
  assert.equal(byId["ollama/local"].health.eligible, true);

  assert.match(out.text, /cost classes: 1 free · 1 free-tier · 0 unknown · 1 paid/);
  assert.match(out.text, /groq\/fast/);
  assert.match(out.text, /30\/min/);
  assert.match(out.text, /cooling 5s/);
});

test("models rejects an unknown request-limit rather than inventing one", async (t) => {
  const { server, baseUrl } = await startCatalogue(["acme/mystery"]);
  t.after(() => closeServer(server));

  const out = captureOut();
  await modelsCommand.run({
    config: { baseUrl, apiKey: null, probeTimeoutMs: 2000, modelHints: {} },
    out,
    flags: { limit: 10 },
    args: [],
    deps: {},
  });

  const model = out.payload.models[0];
  assert.equal(model.costClass, "unknown");
  assert.equal(model.requestLimit.perMinute, null);
  assert.equal(model.requestLimit.kind, "unknown");
  assert.equal(model.toolCalling, "unknown");
  assert.equal(model.health, null, "no health state means unknown, not eligible");
});
