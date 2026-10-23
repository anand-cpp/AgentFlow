// Quota-aware routing: provider feedback, cooldowns, local limits, and ledger.
//
// Every transport is a stub. The clock is a number in the test, so a 30-second
// Retry-After is exercised instantly and deterministically.

import test from "node:test";
import assert from "node:assert/strict";

import { Router, FAILURE, buildNoRouteError } from "../src/core/routing.js";
import { ProviderHealth, FAILURE_CLASS } from "../src/core/provider-health.js";
import { RollingWindowLimiter } from "../src/core/rate-limit.js";
import { UsageLedger } from "../src/core/usage-ledger.js";

const ok = (text = "hello", usage = null) => ({ choices: [{ message: { content: text } }], usage });
const tiers = (...groups) => groups.map((models, i) => ({ name: `t${i + 1}`, models }));

test("a provider cooldown blocks attempts until its retry time", () => {
  let t = 1_000;
  const ph = new ProviderHealth({ now: () => t, maxCooldownMs: 60_000 });
  ph.setCooldown("p", { retryAfterMs: 5_000, source: "retry-after:seconds" });

  assert.equal(ph.canAttempt("p"), false);
  const status = ph.getProviderStatus("p");
  assert.equal(status.cooldownRemainingMs, 5_000);
  assert.equal(status.cooldownSource, "retry-after:seconds");
  assert.equal(status.cooldownUntil, 6_000);

  t = 6_000;
  assert.equal(ph.canAttempt("p"), true);
  assert.equal(ph.getCooldown("p").active, false);
  assert.equal(ph.getProviderStatus("p").cooldownUntil, null);
});

test("a cooldown round-trips through ProviderHealth persistence", () => {
  let t = 1_000;
  const ph = new ProviderHealth({ now: () => t, maxCooldownMs: 60_000 });
  ph.setCooldown("p", { retryAfterMs: 5_000, source: "retry-after:http-date" });
  const restored = new ProviderHealth({ now: () => t, maxCooldownMs: 60_000 }).fromJSON(ph.toJSON());
  assert.equal(restored.canAttempt("p"), false);
  t = 6_001;
  assert.equal(restored.canAttempt("p"), true);
});

test("an unreasonable cooldown is capped", () => {
  const ph = new ProviderHealth({ now: () => 1_000, maxCooldownMs: 10_000 });
  const result = ph.setCooldown("p", { retryAfterMs: 999_999_999 });
  assert.equal(result.until, 11_000);
  assert.equal(result.remainingMs, 10_000);
});

test("Router honors Retry-After and skips the rest of the provider", async () => {
  let t = 1_000;
  const ph = new ProviderHealth({ now: () => t, maxCooldownMs: 60_000 });
  const seen = [];
  const router = new Router({
    tiers: tiers(["p/a", "p/b", "q/ok"]),
    execute: async (id) => {
      seen.push(id);
      if (id === "p/a") {
        const err = /** @type {Error & { status?: number; retryAfterMs?: number; retryAfterSource?: string }} */ (
          new Error("429 too many requests")
        );
        err.status = 429;
        err.retryAfterMs = 30_000;
        err.retryAfterSource = "seconds";
        throw err;
      }
      return ok(id);
    },
    providerHealth: ph,
    now: () => t,
  });

  const receipt = await router.route();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.model, "q/ok");
  assert.deepEqual(seen, ["p/a", "q/ok"], "p/b must not be tried while p is cooling down");
  assert.deepEqual(receipt.cooldownProviders, ["p"]);
  assert.equal(receipt.attempts[0].outcome, FAILURE.RATE_LIMITED);
  assert.equal(receipt.attempts[0].retryAfterMs, 30_000);
  assert.equal(receipt.attempts[1].outcome, "provider_cooldown");
  assert.equal(ph.canAttempt("p"), false);

  t = 31_000;
  assert.equal(ph.canAttempt("p"), true);
});

test("an exhausted quota is permanent for the run and is not retried", async () => {
  const seen = [];
  const router = new Router({
    tiers: tiers(["p/a", "p/b", "q/ok"]),
    execute: async (id) => {
      seen.push(id);
      if (id.startsWith("p/")) {
        const err = /** @type {Error & { status?: number }} */ (
          new Error("insufficient_quota: free credits exhausted")
        );
        err.status = 429;
        throw err;
      }
      return ok(id);
    },
  });

  const receipt = await router.route();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.model, "q/ok");
  assert.deepEqual(seen, ["p/a", "q/ok"]);
  assert.equal(receipt.attempts[0].outcome, FAILURE.QUOTA);
  assert.deepEqual(receipt.skippedProviders, ["p"]);
});

test("invalid-request and auth failures are classified as permanent", async () => {
  const router = new Router({
    tiers: tiers(["p/a", "q/ok"]),
    execute: async (id) => {
      if (id === "p/a") {
        const err = /** @type {Error & { status?: number }} */ (
          new Error("400 invalid request: unknown parameter")
        );
        err.status = 400;
        throw err;
      }
      return ok(id);
    },
  });
  const receipt = await router.route();
  assert.equal(receipt.attempts[0].outcome, FAILURE.INVALID_REQUEST);
  assert.equal(receipt.ok, true);

  const auth = new Router({
    tiers: tiers(["p/a", "q/ok"]),
    execute: async (id) => {
      if (id === "p/a") {
        const err = /** @type {Error & { status?: number }} */ (
          new Error("403 forbidden")
        );
        err.status = 403;
        throw err;
      }
      return ok(id);
    },
  });
  const authReceipt = await auth.route();
  assert.equal(authReceipt.attempts[0].outcome, FAILURE.AUTH);
  assert.deepEqual(authReceipt.skippedProviders, ["p"]);
});

test("a full local window excludes a candidate without executing it", async () => {
  let t = 1_000;
  const limiter = new RollingWindowLimiter({ now: () => t, windowMs: 60_000, maxWaitMs: 0 });
  limiter.setLimit("p", 1);
  (await limiter.acquire("p")).dispatch();

  const seen = [];
  const router = new Router({
    tiers: tiers(["p/a", "q/ok"]),
    execute: async (id) => {
      seen.push(id);
      return ok(id);
    },
    limiter,
    limiterWaitMs: 0,
    now: () => t,
  });

  const receipt = await router.route();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.model, "q/ok");
  assert.deepEqual(seen, ["q/ok"]);
  assert.equal(receipt.attempts[0].outcome, "provider_throttled");
  assert.deepEqual(receipt.blockedProviders, ["p"]);
});

test("all candidates throttled produces an actionable error, not a hang", async () => {
  let t = 1_000;
  const limiter = new RollingWindowLimiter({ now: () => t, windowMs: 60_000, maxWaitMs: 0 });
  limiter.setLimit("p", 1);
  (await limiter.acquire("p")).dispatch();

  const router = new Router({
    tiers: tiers(["p/a"]),
    execute: async () => ok(),
    limiter,
    limiterWaitMs: 0,
    now: () => t,
  });

  const receipt = await router.route();
  assert.equal(receipt.ok, false);
  assert.equal(receipt.error.failureKinds.includes("provider_throttled"), true);
  assert.match(receipt.error.message, /local request-rate limit/);
});

test("cancellation during a limiter wait returns a cancelled receipt", async () => {
  let t = 1_000;
  const limiter = new RollingWindowLimiter({ now: () => t, windowMs: 60_000, maxWaitMs: 5_000 });
  limiter.setLimit("p", 1);
  (await limiter.acquire("p")).dispatch();

  const controller = new AbortController();
  controller.abort();
  const router = new Router({
    tiers: tiers(["p/a"]),
    execute: async () => ok(),
    limiter,
    limiterWaitMs: 5_000,
    now: () => t,
  });
  const receipt = await router.route({ signal: controller.signal });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.cancelled, true);
});

test("Router records one ledger row per dispatched attempt", async () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  const router = new Router({
    tiers: tiers(["p/a", "q/ok"]),
    execute: async (id) => {
      if (id === "p/a") {
        const err = /** @type {Error & { status?: number }} */ (
          new Error("500 server error")
        );
        err.status = 500;
        throw err;
      }
      return ok(id, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    },
    ledger,
    now: () => 1_000,
  });

  await router.route();
  const records = ledger.records();
  assert.equal(records.length, 2);
  assert.equal(records[0].outcome, FAILURE.SERVER);
  assert.equal(records[0].retryCount, 0);
  assert.equal(records[1].outcome, "ok");
  assert.equal(records[1].retryCount, 1);
  assert.deepEqual(records[1].tokens, { prompt: 10, completion: 5, total: 15 });
  assert.equal(records[1].usageSource, "provider");
  assert.equal(ledger.summary().tokens.total, 15);
});

test("a pre-dispatch failure is recorded as not dispatched", async () => {
  const ledger = new UsageLedger({ now: () => 1_000 });
  const router = new Router({
    tiers: tiers(["p/a", "q/ok"]),
    execute: async (id) => {
      if (id === "p/a") {
        const err = /** @type {Error & { code?: string; dispatched?: boolean }} */ (
          new Error("no such model")
        );
        err.code = "not_dispatched";
        err.dispatched = false;
        throw err;
      }
      return ok(id);
    },
    ledger,
    now: () => 1_000,
  });

  await router.route();
  assert.equal(ledger.records()[0].dispatched, false);
  assert.equal(ledger.summary().notDispatched, 1);
});

test("buildNoRouteError surfaces cooldown evidence and the earliest retry", () => {
  const err = buildNoRouteError(
    [{ model: "p/a", provider: "p", outcome: "provider_cooldown", reason: "cooldown", cooldownUntil: 6_000 }],
    1_000
  );
  assert.match(err.message, /cooling down/);
  assert.match(err.message, /earliest retry in 5s/);
  assert.equal(err.retryAt, 6_000);
});

test("provider health keeps cooldown separate from the circuit breaker", () => {
  let t = 1_000;
  const ph = new ProviderHealth({ now: () => t, openAfterFailures: 99 });
  ph.setCooldown("p", { retryAfterMs: 1_000 });
  assert.equal(ph.canAttempt("p"), false);
  assert.equal(ph.getProviderStatus("p").circuitState, "closed");
  ph.onFailure("p", FAILURE_CLASS.NETWORK);
  assert.equal(ph.getProviderStatus("p").circuitState, "closed");
  t = 2_000;
  assert.equal(ph.canAttempt("p"), true);
});
