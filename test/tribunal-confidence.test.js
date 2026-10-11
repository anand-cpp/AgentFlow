// Confidence-downgrade policy tests.
//
// The policy is pure, so these are exhaustive and provider-free. The cases that
// matter most: a reproduced defect forces a lower number, a failing test beats
// any confidence value, and an unexplained increase is refused.

import test from "node:test";
import assert from "node:assert/strict";
import { assessDowngrade, DOWNGRADE_TRIGGER, DOWNGRADE_VERDICT, LOW_CONFIDENCE_THRESHOLD } from "../src/core/tribunal/confidence.js";
import { EVIDENCE_KIND, FINDING_CATEGORY, REVIEW_DECISION } from "../src/core/tribunal/review-schema.js";

function reproducedHigh() {
  return {
    statement: "throws on empty input",
    severity: "high",
    category: FINDING_CATEGORY.CORRECTNESS,
    evidence: EVIDENCE_KIND.REPRODUCED,
    reproduction: "f('') -> TypeError",
  };
}

test("a clean review with no movement is compliant", () => {
  const result = assessDowngrade({ before: 0.8, after: 0.8 });
  assert.equal(result.verdict, DOWNGRADE_VERDICT.OK);
  assert.equal(result.compliant, true);
  assert.equal(result.requiresDowngrade, false);
  assert.deepEqual(result.triggers, []);
});

test("a reproduced high-severity failure requires a downgrade", () => {
  const result = assessDowngrade({ before: 0.8, after: 0.8, findings: [reproducedHigh()] });
  assert.ok(result.triggers.includes(DOWNGRADE_TRIGGER.REPRODUCED_FAILURE));
  assert.equal(result.requiresDowngrade, true);
  assert.equal(result.verdict, DOWNGRADE_VERDICT.DOWNGRADE_REQUIRED);
  assert.equal(result.compliant, false);
});

test("lowering confidence to meet a reproduced failure is compliant", () => {
  const result = assessDowngrade({ before: 0.8, after: 0.5, findings: [reproducedHigh()] });
  assert.equal(result.requiresDowngrade, true);
  assert.equal(result.verdict, DOWNGRADE_VERDICT.OK);
  assert.equal(result.compliant, true);
  assert.ok(Math.abs(result.delta - -0.3) < 1e-9);
});

test("security, assumption, unverified-claim and compatibility findings each trigger", () => {
  const cases = [
    [FINDING_CATEGORY.SECURITY, DOWNGRADE_TRIGGER.SECURITY_ISSUE],
    [FINDING_CATEGORY.ASSUMPTION, DOWNGRADE_TRIGGER.NEW_ASSUMPTION],
    [FINDING_CATEGORY.UNVERIFIED_CLAIM, DOWNGRADE_TRIGGER.UNVERIFIED_CLAIM],
    [FINDING_CATEGORY.COMPATIBILITY, DOWNGRADE_TRIGGER.COMPATIBILITY_RISK],
    [FINDING_CATEGORY.PERFORMANCE, DOWNGRADE_TRIGGER.PERFORMANCE_RISK],
  ];
  for (const [category, trigger] of cases) {
    const result = assessDowngrade({
      before: 0.7,
      after: 0.7,
      findings: [{ statement: "x", severity: "low", category, evidence: EVIDENCE_KIND.HYPOTHESIS, reproduction: null }],
    });
    assert.ok(result.triggers.includes(trigger), `expected ${trigger}`);
    assert.equal(result.verdict, DOWNGRADE_VERDICT.DOWNGRADE_REQUIRED);
  }
});

test("a missing required test triggers a downgrade", () => {
  const result = assessDowngrade({
    before: 0.9,
    after: 0.9,
    tests: [{ description: "must pass", required: true, present: false }],
  });
  assert.ok(result.triggers.includes(DOWNGRADE_TRIGGER.MISSING_REQUIRED_TEST));
  assert.equal(result.verdict, DOWNGRADE_VERDICT.DOWNGRADE_REQUIRED);
});

test("a raised confidence with no justification is unjustified", () => {
  const result = assessDowngrade({ before: 0.5, after: 0.9 });
  assert.equal(result.verdict, DOWNGRADE_VERDICT.UNJUSTIFIED_INCREASE);
  assert.equal(result.compliant, false);
});

test("a raised confidence with a justification is allowed when nothing else demands a drop", () => {
  const result = assessDowngrade({ before: 0.5, after: 0.9, justification: "ran the missing test, it passes" });
  assert.equal(result.verdict, DOWNGRADE_VERDICT.OK);
  assert.equal(result.compliant, true);
});

test("a failing executed test overrides a high confidence", () => {
  const result = assessDowngrade({
    before: 0.5,
    after: 0.99,
    tests: [{ description: "counterexample", expected: "fail", executed: true, passed: false }],
  });
  assert.equal(result.blockingTestFailure, true);
  assert.equal(result.verdict, DOWNGRADE_VERDICT.TESTS_FAILED);
  assert.equal(result.compliant, false);
});

test("low confidence with nothing reproduced is inconclusive, not a verdict", () => {
  const result = assessDowngrade({
    before: 0.5,
    after: LOW_CONFIDENCE_THRESHOLD,
    findings: [{ statement: "not sure", severity: "low", category: FINDING_CATEGORY.OTHER, evidence: EVIDENCE_KIND.HYPOTHESIS, reproduction: null }],
  });
  assert.equal(result.inconclusive, true);
});

test("low confidence with a reproduced finding is not inconclusive", () => {
  const result = assessDowngrade({ before: 0.8, after: 0.3, findings: [reproducedHigh()] });
  assert.equal(result.inconclusive, false);
  assert.equal(result.verdict, DOWNGRADE_VERDICT.OK);
});

test("an explicit REJECT is a decision, not inconclusive, even at low confidence", () => {
  const result = assessDowngrade({ before: 0.5, after: 0.1, decision: REVIEW_DECISION.REJECT });
  assert.equal(result.inconclusive, false);
});

test("tolerates missing findings and tests without throwing", () => {
  const result = assessDowngrade({ before: 0.5, after: 0.5 });
  assert.equal(result.requiresDowngrade, false);
  assert.equal(result.blockingTestFailure, false);
});
