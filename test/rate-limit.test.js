// Rolling-window request limiter and Retry-After parsing.
//
// The limiter is tested with a fake clock and an injected sleep, so every
// boundary is deterministic: no real timers, no network, no provider.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RollingWindowLimiter,
  RateLimitWaitError,
  parseRetryAfter,
  rateLimitsFromRegistry,
  MAX_RETRY_AFTER_MS,
} from "../src/core/rate-limit.js";
import { PROVIDERS } from "../src/core/gateway-server.js";

function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    sleep: async (ms) => {
      t += ms;
    },
  };
}

test("Retry-After accepts delay-seconds", () => {
  const r = parseRetryAfter("30", 1_000);
  assert.equal(r.ms, 30_000);
  assert.equal(r.source, "seconds");
  assert.equal(r.clamped, false);
  assert.equal(r.expired, false);
});

test("Retry-After accepts an HTTP-date in the future", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const r = parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now);
  assert.equal(r.ms, 30_000);
  assert.equal(r.source, "http-date");
});

test("Retry-After treats a past date and zero as expired, not as a cooldown", () => {
  const now = Date.parse("2026-01-01T00:00:30Z");
  const past = parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now);
  assert.equal(past.ms, 0);
  assert.equal(past.expired, true);
  const zero = parseRetryAfter("0", now);
  assert.equal(zero.ms, 0);
  assert.equal(zero.expired, true);
});

test("Retry-After rejects missing, malformed, and negative values", () => {
  assert.equal(parseRetryAfter(null).ms, null);
  assert.equal(parseRetryAfter("").ms, null);
  assert.equal(parseRetryAfter("soon").ms, null);
  assert.equal(parseRetryAfter("-5").ms, null);
  assert.equal(parseRetryAfter("1.5").reason, "malformed");
});

test("Retry-After clamps an unreasonable delay instead of trusting it forever", () => {
  const r = parseRetryAfter("999999999", 0);
  assert.equal(r.ms, MAX_RETRY_AFTER_MS);
  assert.equal(r.clamped, true);
});

test("a rolling window admits the limit and rejects the next request", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000, maxWaitMs: 0 });
  limiter.setLimit("p", 2);

  const a = await limiter.acquire("p");
  a.dispatch();
  const b = await limiter.acquire("p");
  b.dispatch();

  await assert.rejects(limiter.acquire("p"), (err) => {
    assert.ok(err instanceof RateLimitWaitError);
    assert.equal(err.code, "rate_limit_wait_exceeded");
    assert.equal(err.retryAfterMs, 1_000);
    return true;
  });

  assert.equal(limiter.snapshot("p").used, 2);
  assert.equal(limiter.snapshot("p").remaining, 0);
});

test("the oldest dispatch expires at the window boundary", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000, maxWaitMs: 0 });
  limiter.setLimit("p", 1);

  (await limiter.acquire("p")).dispatch();
  clock.advance(999);
  assert.equal(limiter.availableIn("p"), 1);

  clock.advance(1);
  const next = await limiter.acquire("p");
  next.dispatch();
  assert.equal(limiter.snapshot("p").used, 1, "the expired request must not be counted twice");
});

test("concurrent reservations cannot oversubscribe the budget", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000, maxWaitMs: 0 });
  limiter.setLimit("p", 2);

  const a = await limiter.acquire("p");
  const b = await limiter.acquire("p");
  assert.equal(limiter.snapshot("p").pending, 2);
  assert.equal(limiter.snapshot("p").remaining, 0);

  await assert.rejects(limiter.acquire("p"), /local request limit/);

  // Releasing a reservation that never dispatched returns the slot.
  a.release("cancelled");
  const c = await limiter.acquire("p");
  assert.equal(limiter.snapshot("p").pending, 2, "the released slot was reused");
  b.release("cancelled");
  c.release("cancelled");
});

test("a request that never dispatched does not consume the window", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000, maxWaitMs: 0 });
  limiter.setLimit("p", 1);

  const first = await limiter.acquire("p");
  first.release("not_dispatched", { notDispatched: true });
  const second = await limiter.acquire("p");
  second.dispatch();
  assert.equal(limiter.snapshot("p").used, 1);
});

test("a request that failed after dispatch still consumes the window", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000, maxWaitMs: 0 });
  limiter.setLimit("p", 1);

  const first = await limiter.acquire("p");
  first.dispatch();
  first.complete("server");
  await assert.rejects(limiter.acquire("p"), /local request limit/);
});

test("a pre-dispatch failure can explicitly un-count a dispatched reservation", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000, maxWaitMs: 0 });
  limiter.setLimit("p", 1);

  const first = await limiter.acquire("p");
  first.dispatch();
  first.release("not_dispatched", { notDispatched: true });
  const second = await limiter.acquire("p");
  second.dispatch();
  assert.equal(limiter.snapshot("p").used, 1);
});

test("waiting is bounded by maxWaitMs and reports the next slot", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 60_000, maxWaitMs: 1_000 });
  limiter.setLimit("p", 1);
  (await limiter.acquire("p")).dispatch();

  await assert.rejects(limiter.acquire("p"), (err) => {
    const e = /** @type {Error & { code?: string; retryAfterMs?: number|null }} */ (err);
    assert.equal(e.code, "rate_limit_wait_exceeded");
    assert.equal(e.retryAfterMs, 60_000);
    return true;
  });
});

test("a waiting acquire succeeds when the fake clock reaches the next slot", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 100, maxWaitMs: 200 });
  limiter.setLimit("p", 1);
  (await limiter.acquire("p")).dispatch();

  const next = await limiter.acquire("p");
  assert.equal(clock.now(), 1_100);
  next.dispatch();
  assert.equal(limiter.snapshot("p").used, 1);
});

test("cancellation during a wait rejects distinctly and leaves no reservation", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 100, maxWaitMs: 200 });
  limiter.setLimit("p", 1);
  (await limiter.acquire("p")).dispatch();

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(limiter.acquire("p", { signal: controller.signal }), (err) => {
    const e = /** @type {Error & { code?: string }} */ (err);
    assert.equal(e.code, "rate_limit_cancelled");
    return true;
  });
  assert.equal(limiter.snapshot("p").pending, 0);
});

test("an unknown limit is unlimited locally, not exhausted", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep });
  const reservation = await limiter.acquire("unknown-provider");
  reservation.dispatch();
  reservation.complete("ok");
  assert.equal(limiter.getLimit("unknown-provider"), null);
  assert.equal(limiter.snapshot("unknown-provider").limited, false);
  assert.equal(limiter.snapshot("unknown-provider").remaining, null);
});

test("limiter state round-trips and drops timestamps outside the window", async () => {
  const clock = fakeClock();
  const limiter = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000 });
  limiter.setLimit("p", 2);
  (await limiter.acquire("p")).dispatch();
  const snap = limiter.toJSON();

  clock.advance(2_000);
  const restored = new RollingWindowLimiter({ now: clock.now, sleep: clock.sleep, windowMs: 1_000 });
  restored.fromJSON(snap);
  assert.equal(restored.snapshot("p").used, 0);
});

test("registry limits are taken only from a positive ratePerMin", () => {
  const limits = rateLimitsFromRegistry(PROVIDERS);
  assert.equal(limits.groq.limit, 30);
  assert.equal(limits.cerebras.limit, 30);
  assert.equal(limits.gemini.limit, 15);
  assert.equal(limits.mistral, undefined, "null ratePerMin must not invent a limit");
  assert.equal(limits.ollama, undefined);
});
