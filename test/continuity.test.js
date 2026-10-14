// Continuity primitive tests.
//
// These are the decisions that keep a continuation honest:
//
//   * a malformed request or a user cancellation never switches provider,
//   * a context overflow only switches to a candidate that can actually hold it,
//   * an unknown failure asks instead of guessing, and
//   * a dispatched-but-unrecorded non-idempotent tool call is never replayed.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_FAILURE,
  NON_IDEMPOTENT_SCOPES,
  TOOL_VERDICT,
  toHealthClass,
  classifyProviderFailure,
  fallbackEligibility,
  toolRecoverySituation,
  assertSafeContinuation,
  planContinuation,
} from "../src/core/continuity.js";
import { FAILURE_CLASS } from "../src/core/provider-health.js";

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

test("classifies the failure classes a continuation must distinguish", () => {
  assert.equal(classifyProviderFailure({ status: 429, message: "too many requests" }).failure, PROVIDER_FAILURE.RATE_LIMITED);
  assert.equal(classifyProviderFailure({ status: 401, message: "unauthorized" }).failure, PROVIDER_FAILURE.UNAUTHENTICATED);
  assert.equal(classifyProviderFailure({ message: "missing api key" }).failure, PROVIDER_FAILURE.NO_CREDENTIALS);
  assert.equal(classifyProviderFailure({ status: 403, message: "forbidden" }).failure, PROVIDER_FAILURE.AUTH);
  assert.equal(classifyProviderFailure({ message: "quota exceeded" }).failure, PROVIDER_FAILURE.QUOTA);
  assert.equal(classifyProviderFailure({ message: "prompt is too long: max context" }).failure, PROVIDER_FAILURE.CONTEXT_OVERFLOW);
  assert.equal(classifyProviderFailure({ status: 400, message: "invalid request" }).failure, PROVIDER_FAILURE.INVALID_REQUEST);
  assert.equal(classifyProviderFailure({ message: "request timed out" }).failure, PROVIDER_FAILURE.TIMEOUT);
  assert.equal(classifyProviderFailure({ message: "econnrefused" }).failure, PROVIDER_FAILURE.NETWORK);
  assert.equal(classifyProviderFailure({ status: 503, message: "service unavailable" }).failure, PROVIDER_FAILURE.SERVER);
  assert.equal(classifyProviderFailure({ message: "empty response" }).failure, PROVIDER_FAILURE.EMPTY);
});

test("a user cancellation is classified as cancelled, whatever the error says", () => {
  const r = classifyProviderFailure(new Error("network reset"), { cancelled: true });
  assert.equal(r.failure, PROVIDER_FAILURE.CANCELLED);
  assert.equal(r.switchable, false);
  assert.equal(classifyProviderFailure(Object.assign(new Error("x"), { name: "AbortError" })).failure, PROVIDER_FAILURE.CANCELLED);
});

test("an unclassifiable error is unknown and flagged uncertain", () => {
  const r = classifyProviderFailure(new Error("something odd happened"));
  assert.equal(r.failure, PROVIDER_FAILURE.UNKNOWN);
  assert.equal(r.uncertain, true);
});

test("a null error is unknown, not a crash", () => {
  assert.equal(classifyProviderFailure(null).failure, PROVIDER_FAILURE.UNKNOWN);
});

// ---------------------------------------------------------------------------
// health mapping
// ---------------------------------------------------------------------------

test("only provider-health facts reach the health engine", () => {
  assert.equal(toHealthClass(PROVIDER_FAILURE.RATE_LIMITED), FAILURE_CLASS.RATE_LIMITED);
  assert.equal(toHealthClass(PROVIDER_FAILURE.NETWORK), FAILURE_CLASS.NETWORK);
  // Request and user facts say nothing about provider health.
  assert.equal(toHealthClass(PROVIDER_FAILURE.INVALID_REQUEST), null);
  assert.equal(toHealthClass(PROVIDER_FAILURE.CONTEXT_OVERFLOW), null);
  assert.equal(toHealthClass(PROVIDER_FAILURE.CANCELLED), null);
});

// ---------------------------------------------------------------------------
// eligibility
// ---------------------------------------------------------------------------

test("invalid_request and cancellation are never switchable", () => {
  assert.equal(fallbackEligibility({ failureClass: PROVIDER_FAILURE.INVALID_REQUEST, candidates: 5 }).eligible, false);
  assert.equal(fallbackEligibility({ failureClass: PROVIDER_FAILURE.CANCELLED, candidates: 5 }).eligible, false);
});

test("context overflow only switches when a candidate can hold more", () => {
  assert.equal(
    fallbackEligibility({ failureClass: PROVIDER_FAILURE.CONTEXT_OVERFLOW, candidates: 3, candidateHasCapacity: false }).eligible,
    false,
  );
  assert.equal(
    fallbackEligibility({ failureClass: PROVIDER_FAILURE.CONTEXT_OVERFLOW, candidates: 3, candidateHasCapacity: true }).eligible,
    true,
  );
});

test("an unknown failure is eligible but uncertain", () => {
  const r = fallbackEligibility({ failureClass: PROVIDER_FAILURE.UNKNOWN, candidates: 2 });
  assert.equal(r.eligible, true);
  assert.equal(r.uncertain, true);
});

test("no candidates means no switch for any class", () => {
  for (const cls of Object.values(PROVIDER_FAILURE)) {
    assert.equal(fallbackEligibility({ failureClass: cls, candidates: 0 }).eligible, false, cls);
  }
});

test("transient provider failures are switchable", () => {
  for (const cls of [PROVIDER_FAILURE.RATE_LIMITED, PROVIDER_FAILURE.QUOTA, PROVIDER_FAILURE.SERVER, PROVIDER_FAILURE.NETWORK, PROVIDER_FAILURE.EMPTY, PROVIDER_FAILURE.TIMEOUT]) {
    assert.equal(fallbackEligibility({ failureClass: cls, candidates: 1 }).eligible, true, cls);
  }
});

// ---------------------------------------------------------------------------
// tool recovery
// ---------------------------------------------------------------------------

test("a recorded outcome is certain and never replayed", () => {
  const done = toolRecoverySituation({ tool: "filesystem.write", scope: "write", dispatched: true, recorded: { status: "ok" } });
  assert.equal(done.situation, TOOL_VERDICT.CERTAIN);
  assert.equal(done.canReplay, false);
  assert.equal(done.complete, true);
});

test("a call that was never dispatched is safe to attempt", () => {
  const fresh = toolRecoverySituation({ tool: "shell.execute", scope: "shell", dispatched: false });
  assert.equal(fresh.situation, TOOL_VERDICT.NOT_EXECUTED);
  assert.equal(fresh.canReplay, true);
});

test("a dispatched, unrecorded read may be retried; a write may not", () => {
  const read = toolRecoverySituation({ tool: "filesystem.read", scope: "read", dispatched: true });
  assert.equal(read.situation, TOOL_VERDICT.UNCERTAIN);
  assert.equal(read.canReplay, true);
  assert.equal(read.action, "retry");

  const write = toolRecoverySituation({ tool: "filesystem.write", scope: "write", dispatched: true });
  assert.equal(write.situation, TOOL_VERDICT.UNCERTAIN);
  assert.equal(write.canReplay, false);
  assert.equal(write.action, "require_approval");
});

test("an unknown scope is treated as non-idempotent", () => {
  const r = toolRecoverySituation({ tool: "mystery.tool", scope: null, dispatched: true });
  assert.equal(r.canReplay, false);
  assert.equal(r.action, "require_approval");
  assert.ok(NON_IDEMPOTENT_SCOPES.has("shell"));
  assert.ok(NON_IDEMPOTENT_SCOPES.has("write"));
  assert.ok(!NON_IDEMPOTENT_SCOPES.has("read"));
});

test("a batch with an uncertain write is not safe to continue automatically", () => {
  const verdict = assertSafeContinuation({
    toolCalls: [
      { tool: "filesystem.read", scope: "read", dispatched: true },
      { tool: "filesystem.write", scope: "write", dispatched: true },
    ],
  });
  assert.equal(verdict.safe, false);
  assert.equal(verdict.requireApproval.length, 1);
  assert.equal(verdict.requireApproval[0].tool, "filesystem.write");
  assert.equal(verdict.canRetryIdempotent.length, 1);
});

test("a batch with only recorded calls is safe", () => {
  const verdict = assertSafeContinuation({
    toolCalls: [
      { tool: "filesystem.write", scope: "write", dispatched: true, recorded: { status: "ok" } },
    ],
  });
  assert.equal(verdict.safe, true);
  assert.equal(verdict.requireApproval.length, 0);
});

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

test("planContinuation stops with no candidate", () => {
  assert.equal(planContinuation({ failureClass: PROVIDER_FAILURE.RATE_LIMITED, candidates: 0 }).action, "stop");
});

test("planContinuation stops on cancellation and malformed requests", () => {
  assert.equal(planContinuation({ failureClass: PROVIDER_FAILURE.CANCELLED, candidates: 3 }).action, "stop");
  assert.equal(planContinuation({ failureClass: PROVIDER_FAILURE.INVALID_REQUEST, candidates: 3 }).action, "stop");
});

test("planContinuation attempts a switch on a transient failure", () => {
  const plan = planContinuation({ failureClass: PROVIDER_FAILURE.RATE_LIMITED, candidates: 2 });
  assert.equal(plan.action, "attempt_switch");
  assert.equal(plan.reason, "different_provider_may_succeed");
});

test("planContinuation asks before replaying an uncertain tool outcome", () => {
  const plan = planContinuation({ failureClass: PROVIDER_FAILURE.RATE_LIMITED, candidates: 2, dispatchUncertainties: 1 });
  assert.equal(plan.action, "require_approval");
  assert.equal(plan.reason, "uncertain_tool_outcomes");
});

test("planContinuation asks on an unknown failure rather than guessing", () => {
  const plan = planContinuation({ failureClass: PROVIDER_FAILURE.UNKNOWN, candidates: 2 });
  assert.equal(plan.action, "require_approval");
});
