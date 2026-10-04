// Routing policy engine tests.
//
// The router is a pure decision layer with an injected `execute`, so these need
// no network and no gateway. The cases that matter are the failure
// classifications and the cascade orderings, because those are what stop a
// request from hammering a dead provider.

import test from "node:test";
import assert from "node:assert/strict";
import {
  Router,
  HealthCache,
  FAILURE,
  classifyFailure,
  dispositionFor,
  parseModelId,
  orderCandidates,
  isEmptyResult,
  buildNoRouteError,
  tiersFromList,
} from "../src/core/routing.js";
import { EventLog, EVENTS } from "../src/core/events.js";

const ok = (text = "hello") => ({ choices: [{ message: { content: text } }] });

function tiers(...groups) {
  return groups.map((models, i) => ({ name: `t${i + 1}`, models }));
}

test("returns the first model that works", async () => {
  const r = new Router({
    tiers: tiers(["best", "backup"]),
    execute: async (id) => ok(`${id} reply`),
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "best");
  assert.equal(res.attempts.length, 1);
});

test("falls through to the next candidate on failure", async () => {
  const seen = [];
  const r = new Router({
    tiers: tiers(["a", "b", "c"]),
    execute: async (id) => {
      seen.push(id);
      if (id === "c") return ok();
      throw new Error("boom");
    },
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "c");
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.equal(res.attempts.length, 3);
});

test("a 200 with no content counts as a failure, not a success", async () => {
  // The single most common way a free tier fails. Treating it as success is
  // the bug this whole module exists to prevent.
  let calls = 0;
  const r = new Router({
    tiers: tiers(["empty", "real"]),
    execute: async (id) => {
      calls += 1;
      if (id === "empty") return ok(""); // 200, zero tokens
      return ok("actual content");
    },
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "real");
  assert.equal(calls, 2, "must not stop at the empty response");
  assert.equal(res.attempts[0].outcome, FAILURE.EMPTY);
});

test("stops trying a provider once credentials are proven missing", async () => {
  const seen = [];
  const r = new Router({
    tiers: tiers(["prov1/m1", "prov1/m2", "prov1/m3", "prov2/ok"]),
    execute: async (id) => {
      seen.push(id);
      if (id.startsWith("prov1")) throw new Error("Missing API key");
      return ok();
    },
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "prov2/ok");
  // Only one prov1 model should be attempted, not all three.
  assert.equal(seen.filter((s) => s.startsWith("prov1")).length, 1, "should not retry a credential-less provider");
  assert.ok(res.skippedProviders.includes("prov1"));
});

test("rate limiting falls through without penalising the provider", async () => {
  const r = new Router({
    tiers: tiers(["a", "b"]),
    execute: async (id) => {
      if (id === "a") {
        const e = new Error("429 rate limit exceeded");
        e.status = 429;
        throw e;
      }
      return ok();
    },
  });
  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "b");
  assert.equal(res.attempts[0].outcome, FAILURE.RATE_LIMITED);
  assert.equal(dispositionFor(FAILURE.RATE_LIMITED).penaliseProvider, false);
});

test("health memory keeps a known-dead candidate last on later calls", async () => {
  let failFirst = true;
  const counts = new Map();
  const r = new Router({
    tiers: tiers(["bad", "good"]),
    execute: async (id) => {
      counts.set(id, (counts.get(id) || 0) + 1);
      if (id === "bad" && failFirst) throw new Error("server error");
      return ok();
    },
  });

  await r.route();
  failFirst = false;
  counts.clear();

  const res = await r.route();
  assert.equal(res.ok, true);
  assert.equal(res.model, "good", "known-bad candidate should be tried last");
  assert.equal(counts.has("bad"), false, "a model that just failed is not retried once a healthy one answers");
});

test("health entries expire so a recovered provider is retried", async () => {
  let now = 1_000_000;
  const health = new HealthCache({ ttlMs: 100, now: () => now });
  health.markFailure("a", FAILURE.SERVER);

  assert.ok(health.get("a"), "fresh entry is visible");
  now += 200;
  assert.equal(health.get("a"), null, "stale entry expires");
});

test("skipped providers are remembered across routes", async () => {
  const health = new HealthCache();
  const r = new Router({
    tiers: tiers(["nokey/m1", "ok/m1"]),
    execute: async (id) => {
      if (id.startsWith("nokey")) throw new Error("Missing API key");
      return ok();
    },
    health,
  });

  await r.route();
  assert.equal(health.isProviderSkipped("nokey"), true);
  assert.equal(health.isProviderSkipped("ok"), false);
});

test("exhausting every candidate reports actionable failure kinds", async () => {
  const r = new Router({
    tiers: tiers(["a/m", "b/m"]),
    execute: async (id) => {
      if (id.startsWith("a")) throw new Error("Missing API key");
      return ok(""); // empty
    },
  });
  const res = await r.route();
  assert.equal(res.ok, false);
  assert.ok(res.failureKinds.includes(FAILURE.NO_CREDENTIALS));
  assert.ok(res.failureKinds.includes(FAILURE.EMPTY));
  assert.match(res.error.message, /credentials/);
  assert.match(res.error.message, /no content/);
});

test("a receipt explains every attempt, not just the winner", async () => {
  const r = new Router({
    tiers: tiers(["x/m", "y/m"]),
    execute: async (id) => {
      if (id === "x/m") throw new Error("500 upstream");
      return ok();
    },
  });
  const res = await r.route();
  assert.equal(res.attempts.length, 2);
  assert.equal(res.attempts[0].model, "x/m");
  assert.equal(res.attempts[0].outcome, FAILURE.SERVER);
  assert.ok(res.attempts[0].elapsedMs >= 0);
  assert.equal(res.attempts[1].outcome, "ok");
});

test("onAttempt fires per try and cannot break routing", async () => {
  const seen = [];
  const r = new Router({
    tiers: tiers(["a", "b"]),
    execute: async (id) => {
      if (id === "a") throw new Error("boom");
      return ok();
    },
  });
  const res = await r.route({ onAttempt: (rec) => { seen.push(rec.model); if (rec.model === "a") throw new Error("callback exploded"); } });
  assert.equal(res.ok, true, "a throwing callback must not fail the route");
  assert.deepEqual(seen, ["a", "b"], "callback fires for every attempt, including the winner");
});

test("emits structured events for attempts, fallbacks, and the decision", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aflow-rt-")), "log.jsonl");
  const log = new EventLog({ file });

  const r = new Router({
    tiers: tiers(["a/m", "b/m"]),
    execute: async (id) => (id === "a/m" ? (() => { throw new Error("Missing API key"); })() : ok()),
    log,
  });
  await r.route();

  const { readEvents } = await import("../src/core/events.js");
  const types = readEvents({ file, limit: 0 }).events.map((e) => e.type);
  assert.ok(types.includes(EVENTS.ROUTE_ATTEMPT));
  assert.ok(types.includes(EVENTS.ROUTE_FALLBACK));
  assert.ok(types.includes(EVENTS.ROUTE_DECISION));
});

test("classifyFailure separates fixable from hopeless", () => {
  assert.equal(classifyFailure(new Error("Missing API key")), FAILURE.NO_CREDENTIALS);
  assert.equal(classifyFailure({ status: 401, message: "unauthorized" }), FAILURE.NO_CREDENTIALS);
  assert.equal(classifyFailure({ status: 429, message: "slow down" }), FAILURE.RATE_LIMITED);
  assert.equal(classifyFailure(new Error("AbortError: timeout")), FAILURE.TIMEOUT);
  assert.equal(classifyFailure(new Error("fetch failed")), FAILURE.NETWORK);
  assert.equal(classifyFailure({ status: 503, message: "unavailable" }), FAILURE.SERVER);
  assert.equal(classifyFailure(null), FAILURE.UNKNOWN);
  assert.equal(dispositionFor(FAILURE.NO_CREDENTIALS).skipProvider, true);
});

test("isEmptyResult handles every response shape we actually see", () => {
  assert.equal(isEmptyResult(null), true);
  assert.equal(isEmptyResult(""), true);
  assert.equal(isEmptyResult("   "), true);
  assert.equal(isEmptyResult("hi"), false);
  assert.equal(isEmptyResult({ choices: [] }), true);
  assert.equal(isEmptyResult({ choices: [{ message: { content: "" } }] }), true);
  assert.equal(isEmptyResult({ choices: [{ message: { content: "x" } }] }), false);
  assert.equal(isEmptyResult({ content: "" }), true);
  assert.equal(isEmptyResult({ error: { message: "bad" } }), true);
});

test("parseModelId handles both qualified and bare ids", () => {
  assert.deepEqual(parseModelId("oc/model-x"), { provider: "oc", model: "model-x", raw: "oc/model-x" });
  assert.deepEqual(parseModelId("bare"), { provider: "bare", model: "bare", raw: "bare" });
  assert.deepEqual(parseModelId(""), { provider: "", model: "", raw: "" });
});

test("orderCandidates prefers healthy, then unknown, then failing", () => {
  const h = new HealthCache();
  h.markOk("good");
  h.markFailure("bad", FAILURE.SERVER);
  const out = orderCandidates(["bad", "unknown1", "good", "unknown2"], h);
  assert.equal(out[0], "good");
  assert.deepEqual(out.slice(1, 3), ["unknown1", "unknown2"], "unknowns keep caller order");
  assert.equal(out.at(-1), "bad");
});

test("HealthCache bounds its own size", () => {
  const h = new HealthCache({ maxEntries: 3 });
  for (let i = 0; i < 10; i++) h.markFailure(`m${i}`, FAILURE.SERVER);
  assert.equal(h.map.size, 3);
  assert.ok(h.stats().failed > 0);
});

test("a success clears prior failures", () => {
  const h = new HealthCache();
  h.markFailure("m", FAILURE.SERVER);
  h.markOk("m");
  assert.equal(h.get("m").ok, true);
});

test("Router validates its inputs", () => {
  assert.throws(() => new Router({ execute: async () => ok() }), /tier/);
  assert.throws(() => new Router({ tiers: tiers(["a"]) }), /execute/);
});

test("tiersFromList gives the first model its own tier", () => {
  const t = tiersFromList(["a", "b", "c"], { size: 2 });
  assert.deepEqual(t[0], { name: "tier1", models: ["a", "b"] });
  assert.deepEqual(t[1], { name: "tier2", models: ["c"] });
});

test("buildNoRouteError attaches attempts for programmatic handling", () => {
  const attempts = [{ model: "a", outcome: FAILURE.RATE_LIMITED }];
  const err = buildNoRouteError(attempts);
  assert.equal(err.attempts.length, 1);
  assert.ok(err.failureKinds.includes(FAILURE.RATE_LIMITED));
});