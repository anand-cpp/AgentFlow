import test from "node:test";
import assert from "node:assert/strict";
import { Router, buildNoRouteError } from "../src/core/routing.js";
import { ProviderHealth, PROVIDER_STATUS, CIRCUIT_STATE, FAILURE_CLASS } from "../src/core/provider-health.js";

const ok = (text = "hello") => ({ choices: [{ message: { content: text } }] });
const tiers = (...groups) => groups.map((models, i) => ({ name: `t${i + 1}`, models }));

test("router without providerHealth is unchanged", async () => {
  const r = new Router({ tiers: tiers(["a", "b"]), execute: async (id) => ok(id) });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.deepEqual(res.blockedProviders, []);
});

test("open circuit blocks a provider without executing it", async () => {
  const seen = [];
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("down", FAILURE_CLASS.NETWORK);
  assert.equal(ph.getProviderStatus("down").circuitState, CIRCUIT_STATE.OPEN);

  const r = new Router({
    tiers: tiers(["down/m1", "down/m2", "up/ok"]),
    execute: async (id) => {
      seen.push(id);
      return ok(id);
    },
    providerHealth: ph,
    now: () => 1000,
  });
  const res = await r.route();

  assert.equal(res.ok, true);
  assert.equal(res.model, "up/ok");
  assert.deepEqual(seen, ["up/ok"], "blocked provider must not be executed");
  assert.equal(res.attempts[0].outcome, "provider_blocked");
  assert.equal(res.attempts[1].outcome, "provider_blocked");
  assert.deepEqual(res.blockedProviders, ["down"]);
});

test("success records provider health", async () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  const r = new Router({ tiers: tiers(["prov/m"]), execute: async (id) => ok(id), providerHealth: ph, now: () => 1000 });
  await r.route();
  assert.equal(ph.getProviderStatus("prov").status, PROVIDER_STATUS.HEALTHY);
  assert.equal(ph.getProviderStatus("prov").successCount, 1);
});

test("failures accumulate on provider health and open the circuit", async () => {
  const ph = new ProviderHealth({ openAfterFailures: 2, baseBackoffMs: 30000, now: () => 1000 });
  const r = new Router({
    tiers: tiers(["p/m1", "p/m2", "q/ok"]),
    execute: async (id) => {
      if (id.startsWith("q")) return ok(id);
      const err = new Error("503 bad gateway");
      err.status = 503;
      throw err;
    },
    providerHealth: ph,
    now: () => 1000,
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "q/ok");
  assert.equal(ph.getProviderStatus("p").consecutiveFailures, 2);
  assert.equal(ph.getProviderStatus("p").circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(ph.getProviderStatus("p").lastFailureType, FAILURE_CLASS.SERVER);
});

test("half-open probe succeeds and closes the circuit", async () => {
  let t = 1000;
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => t });
  ph.onFailure("p", FAILURE_CLASS.SERVER);
  assert.equal(ph.getProviderStatus("p").circuitState, CIRCUIT_STATE.OPEN);

  t = 31000;
  const r = new Router({ tiers: tiers(["p/m"]), execute: async (id) => ok(id), providerHealth: ph, now: () => t });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(ph.getProviderStatus("p").circuitState, CIRCUIT_STATE.CLOSED);
  assert.equal(ph.getProviderStatus("p").status, PROVIDER_STATUS.HEALTHY);
});

test("half-open probe failure reopens with harsher backoff", async () => {
  let t = 1000;
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, backoffMultiplier: 2, maxBackoffMs: 600000, now: () => t });
  ph.onFailure("p", FAILURE_CLASS.SERVER);

  t = 31000;
  const r = new Router({
    tiers: tiers(["p/m"]),
    execute: async () => {
      throw new Error("500 server error");
    },
    providerHealth: ph,
    now: () => t,
  });
  await r.route();
  assert.equal(ph.getProviderStatus("p").circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(ph.getProviderStatus("p").backoffMs, 60000);
});

test("no-credentials failure counts toward provider health but is skipped by HealthCache", async () => {
  const ph = new ProviderHealth({ openAfterFailures: 3, now: () => 1000 });
  const r = new Router({
    tiers: tiers(["n/c1", "n/c2", "n/c3", "ok/m"]),
    execute: async (id) => {
      if (id === "ok/m") return ok(id);
      const err = new Error("missing api key");
      err.status = 401;
      throw err;
    },
    providerHealth: ph,
    now: () => 1000,
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "ok/m");
  assert.deepEqual(res.skippedProviders, ["n"]);
});

test("buildNoRouteError surfaces an open circuit", () => {
  const err = buildNoRouteError([
    { model: "p/m", provider: "p", outcome: "provider_blocked", reason: "circuit_open" },
  ]);
  assert.match(err.message, /provider circuit open/);
});
