import test from "node:test";
import assert from "node:assert/strict";
import { ProviderHealth, PROVIDER_STATUS, CIRCUIT_STATE, FAILURE_CLASS } from "../src/core/provider-health.js";

test("unknown initial state", () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  const s = ph.getProviderStatus("p1");
  assert.equal(s.status, PROVIDER_STATUS.UNKNOWN);
  assert.equal(s.circuitState, CIRCUIT_STATE.CLOSED);
});

test("successful provider becomes healthy", () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  ph.onSuccess("p1");
  const s = ph.getProviderStatus("p1");
  assert.equal(s.status, PROVIDER_STATUS.HEALTHY);
  assert.equal(s.circuitState, CIRCUIT_STATE.CLOSED);
  assert.equal(s.successCount, 1);
});

test("consecutive failures trigger OPEN", () => {
  const ph = new ProviderHealth({ openAfterFailures: 2, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.NETWORK);
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.CLOSED);
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(ph.getProviderStatus("p1").consecutiveFailures, 2);
});

test("OPEN blocks attempts before nextProbe", () => {
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.TIMEOUT);
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(ph.canAttempt("p1", 1000), false);
});

test("OPEN transitions to HALF_OPEN at probe time", () => {
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.TIMEOUT);
  assert.equal(ph.canAttempt("p1", 31000), true);
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.HALF_OPEN);
});

test("HALF_OPEN permits probe", () => {
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.TIMEOUT);
  ph.canAttempt("p1", 31000);
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.HALF_OPEN);
  assert.equal(ph.canAttempt("p1", 31000), true);
});

test("HALF_OPEN success returns CLOSED", () => {
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.TIMEOUT);
  ph.canAttempt("p1", 31000);
  ph.onSuccess("p1");
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.CLOSED);
  assert.equal(ph.getProviderStatus("p1").status, PROVIDER_STATUS.HEALTHY);
});

test("HALF_OPEN failure returns OPEN with increased backoff", () => {
  let t = 1000;
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, backoffMultiplier: 2, maxBackoffMs: 120000, now: () => t });
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  assert.equal(ph.canAttempt("p1", 31000), true);
  t = 31000;
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(ph.getProviderStatus("p1").backoffMs, 60000);
});

test("backoff capped", () => {
  let t = 1000;
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, backoffMultiplier: 2, maxBackoffMs: 60000, now: () => t });
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  assert.equal(ph.canAttempt("p1", 31000), true);
  t = 31000;
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  assert.equal(ph.getProviderStatus("p1").backoffMs, 60000);
  assert.equal(ph.canAttempt("p1", 31000 + 60000), true);
  t = 31000 + 60000;
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  assert.equal(ph.getProviderStatus("p1").backoffMs, 60000);
});

test("RATE_LIMITED/QUOTA map to DEGRADED", () => {
  const ph = new ProviderHealth({ openAfterFailures: 5, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.RATE_LIMITED);
  assert.equal(ph.getProviderStatus("p1").status, PROVIDER_STATUS.DEGRADED);
  ph.onFailure("p2", FAILURE_CLASS.QUOTA);
  assert.equal(ph.getProviderStatus("p2").status, PROVIDER_STATUS.DEGRADED);
});

test("NO_CREDENTIALS/UNAUTHENTICATED map to UNAUTHENTICATED", () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.NO_CREDENTIALS);
  assert.equal(ph.getProviderStatus("p1").status, PROVIDER_STATUS.UNAUTHENTICATED);
  ph.onFailure("p2", FAILURE_CLASS.UNAUTHENTICATED);
  assert.equal(ph.getProviderStatus("p2").status, PROVIDER_STATUS.UNAUTHENTICATED);
});

test("NETWORK/SERVER/TIMEOUT/EMPTY map to DEGRADED", () => {
  const ph = new ProviderHealth({ now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.NETWORK);
  assert.equal(ph.getProviderStatus("p1").status, PROVIDER_STATUS.DEGRADED);
  ph.onFailure("p2", FAILURE_CLASS.SERVER);
  assert.equal(ph.getProviderStatus("p2").status, PROVIDER_STATUS.DEGRADED);
  ph.onFailure("p3", FAILURE_CLASS.TIMEOUT);
  assert.equal(ph.getProviderStatus("p3").status, PROVIDER_STATUS.DEGRADED);
  ph.onFailure("p4", FAILURE_CLASS.EMPTY);
  assert.equal(ph.getProviderStatus("p4").status, PROVIDER_STATUS.DEGRADED);
});

test("bounded history", () => {
  const ph = new ProviderHealth({ maxHistory: 2, now: () => 1000 });
  ph.onSuccess("p1");
  ph.onFailure("p1", FAILURE_CLASS.NETWORK);
  ph.onSuccess("p1");
  const s = ph.getProviderStatus("p1");
  assert.equal(s.history.length, 2);
});

test("multiple providers isolated", () => {
  const ph = new ProviderHealth({ openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.SERVER);
  ph.onSuccess("p2");
  assert.equal(ph.getProviderStatus("p1").circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(ph.getProviderStatus("p2").circuitState, CIRCUIT_STATE.CLOSED);
  assert.equal(ph.getProviderStatus("p2").status, PROVIDER_STATUS.HEALTHY);
});

test("fromJSON/toJSON roundtrip", () => {
  const ph = new ProviderHealth({ maxHistory: 5, openAfterFailures: 1, baseBackoffMs: 30000, now: () => 1000 });
  ph.onFailure("p1", FAILURE_CLASS.RATE_LIMITED);
  const snap = ph.toJSON();
  const ph2 = new ProviderHealth({ maxHistory: 5, openAfterFailures: 1, baseBackoffMs: 30000 });
  ph2.fromJSON(snap);
  const s = ph2.getProviderStatus("p1");
  assert.equal(s.circuitState, CIRCUIT_STATE.OPEN);
  assert.equal(s.lastFailureType, FAILURE_CLASS.RATE_LIMITED);
  assert.ok(s.history.length > 0);
});
