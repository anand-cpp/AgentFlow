// Self-adversarial review schema tests.
//
// These guard the boundary that keeps a fabricated defect from looking proven.
// The most important assertion here is not "valid reviews pass" -- it is that a
// finding labelled REPRODUCED without a reproduction is rejected, and is never
// counted as reproduced even if validation is skipped.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SELF_REVIEW_SCHEMA_VERSION,
  REVIEW_DECISION,
  EVIDENCE_KIND,
  validateSelfReview,
  classifyFindings,
} from "../src/core/tribunal/review-schema.js";

function validReview(overrides = {}) {
  return {
    schemaVersion: SELF_REVIEW_SCHEMA_VERSION,
    candidateId: "c1",
    originalApproach: "parse the input and return the first row",
    strongestCounterArgument: "empty input has no first row",
    failureHypotheses: [
      {
        statement: "empty input throws",
        severity: "high",
        category: "correctness",
        evidence: EVIDENCE_KIND.REPRODUCED,
        reproduction: "f('') -> TypeError: cannot read '0'",
      },
      {
        statement: "unicode headers may misalign columns",
        severity: "low",
        category: "edge_case",
        evidence: EVIDENCE_KIND.HYPOTHESIS,
        reproduction: null,
      },
      {
        statement: "re-scan is quadratic on wide rows",
        severity: "low",
        category: "performance",
        evidence: EVIDENCE_KIND.HYPOTHESIS,
        reproduction: null,
      },
    ],
    assumptions: ["input is utf-8"],
    missingEvidence: ["no benchmark"],
    securityWeaknesses: [],
    logicRisks: ["off-by-one on empty"],
    edgeCases: ["empty string"],
    performanceConcerns: [],
    proposedTests: [
      { description: "empty input is handled", expected: "pass", executed: true, passed: false, observed: "throws" },
    ],
    confidenceBefore: 0.8,
    confidenceAfter: 0.5,
    confidenceJustification: "a reproduced high-severity failure",
    decision: REVIEW_DECISION.REVISE,
    revisedApproach: "guard empty input before indexing",
    ...overrides,
  };
}

test("accepts a well-formed review", () => {
  const result = validateSelfReview(validReview());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("rejects unknown fields rather than dropping them", () => {
  const result = validateSelfReview(validReview({ vibe: "good" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown field "vibe"')));
});

test("rejects a wrong schema version", () => {
  const result = validateSelfReview(validReview({ schemaVersion: 2 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("schemaVersion")));
});

test("rejects an unknown decision", () => {
  const result = validateSelfReview(validReview({ decision: "rethink" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("decision")));
});

test("rejects a non-object", () => {
  assert.equal(validateSelfReview(null).ok, false);
  assert.equal(validateSelfReview("nope").ok, false);
  assert.equal(validateSelfReview([]).ok, false);
});

test("rejects confidence outside 0..1", () => {
  const result = validateSelfReview(validReview({ confidenceAfter: 1.4 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("confidenceAfter")));
});

test("requires revisedApproach when the decision is REVISE", () => {
  const result = validateSelfReview(validReview({ revisedApproach: null }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("revisedApproach")));
});

test("requires a rationale when fewer than three hypotheses are given", () => {
  const review = validReview();
  review.failureHypotheses = review.failureHypotheses.slice(0, 1);
  const result = validateSelfReview(review);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("failureHypothesesRationale")));
});

test("a REPRODUCED finding without a reproduction is invalid", () => {
  const review = validReview();
  review.failureHypotheses[0].reproduction = null;
  const result = validateSelfReview(review);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("reproduction")));
});

test("an unsupported accusation is never classified as reproduced", () => {
  const review = validReview();
  review.failureHypotheses = [
    {
      statement: "maybe corrupts on large input",
      severity: "critical",
      category: "correctness",
      evidence: EVIDENCE_KIND.REPRODUCED,
      reproduction: null,
    },
    {
      statement: "unicode edge",
      severity: "low",
      category: "edge_case",
      evidence: EVIDENCE_KIND.HYPOTHESIS,
      reproduction: null,
    },
    {
      statement: "slow",
      severity: "low",
      category: "performance",
      evidence: EVIDENCE_KIND.HYPOTHESIS,
      reproduction: null,
    },
  ];

  // Even if a caller skips validateSelfReview, the accusation must not count.
  const { reproduced, hypotheses, unverifiedAccusations } = classifyFindings(review);
  assert.equal(reproduced.length, 0);
  assert.equal(unverifiedAccusations.length, 1);
  assert.equal(hypotheses.length, 2);
});

test("classifies evidence-backed findings correctly", () => {
  const { reproduced, hypotheses, unverifiedAccusations } = classifyFindings(validReview());
  assert.equal(reproduced.length, 1);
  assert.equal(hypotheses.length, 2);
  assert.equal(unverifiedAccusations.length, 0);
  assert.equal(reproduced[0].severity, "high");
});

test("tolerates a missing failureHypotheses array without throwing", () => {
  const { reproduced, hypotheses, unverifiedAccusations } = classifyFindings({});
  assert.deepEqual(reproduced, []);
  assert.deepEqual(hypotheses, []);
  assert.deepEqual(unverifiedAccusations, []);
});
