// Self-adversarial stage tests.
//
// These check the orchestration guarantees a caller relies on: every candidate
// is reviewed, the review gets the right candidate in an isolated prompt, a
// revision is re-reviewed, the loop is bounded, and a malformed review is
// reported rather than swallowed.

import test from "node:test";
import assert from "node:assert/strict";
import { runSelfAdversarialStage, STAGE_OUTCOME } from "../src/core/tribunal/stage.js";
import { SELF_REVIEW_SYSTEM_PROMPT } from "../src/core/tribunal/self-review.js";
import { SELF_REVIEW_SCHEMA_VERSION } from "../src/core/tribunal/review-schema.js";
import { DOWNGRADE_VERDICT } from "../src/core/tribunal/confidence.js";

function review(overrides = {}) {
  return {
    schemaVersion: SELF_REVIEW_SCHEMA_VERSION,
    candidateId: "c1",
    originalApproach: "approach",
    strongestCounterArgument: "counter",
    failureHypotheses: [
      { statement: "a", severity: "high", category: "correctness", evidence: "reproduced", reproduction: "repro" },
      { statement: "b", severity: "low", category: "edge_case", evidence: "hypothesis", reproduction: null },
      { statement: "c", severity: "low", category: "performance", evidence: "hypothesis", reproduction: null },
    ],
    assumptions: [],
    missingEvidence: [],
    securityWeaknesses: [],
    logicRisks: [],
    edgeCases: [],
    performanceConcerns: [],
    proposedTests: [],
    confidenceBefore: 0.8,
    confidenceAfter: 0.5,
    confidenceJustification: "reproduced failure",
    decision: "RETAIN_WITH_EVIDENCE",
    revisedApproach: null,
    ...overrides,
  };
}

function queueComplete(responses) {
  const calls = [];
  const fn = async (config, modelId, prompt, opts) => {
    calls.push({ modelId, prompt, system: opts?.system });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { text: typeof next === "string" ? next : JSON.stringify(next) };
  };
  return { fn, calls };
}

test("every candidate is reviewed, with the review system prompt", async () => {
  const { fn, calls } = queueComplete([review(), review()]);
  const result = await runSelfAdversarialStage({
    candidates: [
      { id: "c1", model: "m1", approach: "first" },
      { id: "c2", model: "m2", approach: "second" },
    ],
    complete: fn,
  });
  assert.equal(calls.length, 2);
  // Every review uses the base system prompt; personas append a modifier, so
  // the two candidates are reviewed through different lenses.
  assert.ok(calls.every((c) => c.system.startsWith(SELF_REVIEW_SYSTEM_PROMPT)));
  assert.notEqual(calls[0].system, calls[1].system, "distinct candidates get distinct persona modifiers");
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.reviewed, 2);
});

test("each review receives its own candidate, in isolation", async () => {
  const { fn, calls } = queueComplete([review({ candidateId: "c1" }), review({ candidateId: "c2" })]);
  const candidateA = { id: "c1", model: "m1", approach: "APPROACH_A", rationale: "ra" };
  const candidateB = { id: "c2", model: "m2", approach: "APPROACH_B", rationale: "rb" };
  const snapshotA = JSON.parse(JSON.stringify(candidateA));

  await runSelfAdversarialStage({ candidates: [candidateA, candidateB], complete: fn });

  assert.ok(calls[0].prompt.includes("APPROACH_A"));
  assert.ok(!calls[0].prompt.includes("APPROACH_B"));
  assert.ok(calls[1].prompt.includes("APPROACH_B"));
  assert.ok(!calls[1].prompt.includes("APPROACH_A"));
  assert.deepEqual(candidateA, snapshotA, "the stage must not mutate the caller's candidate");
});

test("a revised candidate is assessed again", async () => {
  const { fn, calls } = queueComplete([
    review({ decision: "REVISE", revisedApproach: "REVISED_APPROACH_MARKER" }),
    review({ decision: "RETAIN_WITH_EVIDENCE", revisedApproach: null }),
  ]);
  const result = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "original" }],
    complete: fn,
    maxRevisions: 2,
  });

  assert.equal(calls.length, 2, "the revision must be reviewed again");
  assert.ok(calls[1].prompt.includes("REVISED_APPROACH_MARKER"));
  assert.equal(result.candidates[0].iterations, 2);
  assert.equal(result.candidates[0].outcome, STAGE_OUTCOME.REVIEWED);
});

test("the revision loop is bounded even when the reviewer never agrees", async () => {
  const { fn, calls } = queueComplete([review({ decision: "REVISE", revisedApproach: "again" })]);
  const result = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "original" }],
    complete: fn,
    maxRevisions: 1,
  });

  assert.equal(calls.length, 2, "one initial review plus one revision");
  assert.equal(result.candidates[0].outcome, STAGE_OUTCOME.REVISION_LIMIT);
  assert.equal(result.summary.limited, 1);
});

test("a malformed review is reported, not swallowed", async () => {
  const { fn } = queueComplete(["not json at all"]);
  const result = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "x" }],
    complete: fn,
  });

  assert.equal(result.candidates[0].ok, false);
  assert.equal(result.candidates[0].outcome, STAGE_OUTCOME.INVALID_REVIEW);
  assert.equal(result.summary.invalid, 1);
});

test("a reproduced defect lowers confidence through the stage", async () => {
  const { fn } = queueComplete([review({ confidenceBefore: 0.9, confidenceAfter: 0.4 })]);
  const result = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "x" }],
    complete: fn,
  });
  const { assessment, classification } = result.candidates[0];
  assert.equal(classification.reproduced.length, 1);
  assert.equal(assessment.requiresDowngrade, true);
  assert.equal(assessment.compliant, true);
});

test("a failing test overrides confidence through the stage", async () => {
  const { fn } = queueComplete([
    review({
      confidenceAfter: 0.99,
      proposedTests: [{ description: "counterexample", expected: "fail", executed: true, passed: false, observed: "failed" }],
    }),
  ]);
  const result = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "x" }],
    complete: fn,
  });
  assert.equal(result.candidates[0].assessment.verdict, DOWNGRADE_VERDICT.TESTS_FAILED);
  assert.equal(result.candidates[0].assessment.compliant, false);
});

test("an empty candidate list is a clean no-op", async () => {
  const result = await runSelfAdversarialStage({ candidates: [], complete: async () => ({ text: "{}" }) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.summary.total, 0);
});

test("depth caps the number of candidates Forge reviews", async () => {
  const responses = [review(), review(), review(), review()];
  const { fn, calls } = queueComplete(responses);
  const depth = { models: 2, rounds: 1, oracleMode: "lite", earlyTermination: false, hardTimeoutMs: null };
  const result = await runSelfAdversarialStage({
    candidates: [
      { id: "c1", model: "m1", approach: "one" },
      { id: "c2", model: "m2", approach: "two" },
      { id: "c3", model: "m3", approach: "three" },
      { id: "c4", model: "m4", approach: "four" },
    ],
    complete: fn,
    depth,
  });
  assert.equal(calls.length, 2, "depth.models=2 caps Forge to two candidates");
  assert.equal(result.summary.total, 2);
});

test("depth models null means no cap", async () => {
  const responses = [review(), review(), review(), review()];
  const { fn, calls } = queueComplete(responses);
  const depth = { models: null, rounds: 3, oracleMode: "full", earlyTermination: false, hardTimeoutMs: null };
  const result = await runSelfAdversarialStage({
    candidates: [
      { id: "c1", model: "m1", approach: "one" },
      { id: "c2", model: "m2", approach: "two" },
      { id: "c3", model: "m3", approach: "three" },
      { id: "c4", model: "m4", approach: "four" },
    ],
    complete: fn,
    depth,
  });
  assert.equal(calls.length, 4, "depth.models=null reviews every candidate");
  assert.equal(result.summary.total, 4);
});

