// The exact confidence boundary: LOW_CONFIDENCE_THRESHOLD is inclusive.
//
// The general policy is covered in tribunal-confidence.test.js; this pins the
// single value where "inconclusive" flips, because an off-by-one here silently
// turns "we should verify more" into "we decided".

import test from "node:test";
import assert from "node:assert/strict";

import { assessDowngrade, LOW_CONFIDENCE_THRESHOLD } from "../src/core/tribunal/confidence.js";
import { EVIDENCE_KIND, FINDING_CATEGORY, REVIEW_DECISION } from "../src/core/tribunal/review-schema.js";

function hypothesis() {
  return [{
    statement: "unsure",
    severity: "low",
    category: FINDING_CATEGORY.OTHER,
    evidence: EVIDENCE_KIND.HYPOTHESIS,
    reproduction: null,
  }];
}

test("confidence exactly at the threshold is inconclusive", () => {
  const result = assessDowngrade({ before: 0.8, after: LOW_CONFIDENCE_THRESHOLD, findings: hypothesis() });
  assert.equal(result.inconclusive, true, "the threshold itself counts as low");
});

test("a hair above the threshold is a decision", () => {
  const result = assessDowngrade({
    before: 0.8,
    after: LOW_CONFIDENCE_THRESHOLD + 1e-6,
    findings: hypothesis(),
  });
  assert.equal(result.inconclusive, false);
});

test("a hair below the threshold is inconclusive", () => {
  const result = assessDowngrade({
    before: 0.8,
    after: LOW_CONFIDENCE_THRESHOLD - 1e-6,
    findings: hypothesis(),
  });
  assert.equal(result.inconclusive, true);
});

test("at the threshold a reproduced finding makes it a decision", () => {
  const result = assessDowngrade({
    before: 0.8,
    after: LOW_CONFIDENCE_THRESHOLD,
    findings: [{
      statement: "reproduced",
      severity: "high",
      category: FINDING_CATEGORY.CORRECTNESS,
      evidence: EVIDENCE_KIND.REPRODUCED,
      reproduction: "f('') -> throw",
    }],
  });
  assert.equal(result.inconclusive, false, "a reproduced defect is grounds for a verdict even at low confidence");
});

test("at the threshold an explicit REJECT overrides inconclusive", () => {
  const result = assessDowngrade({ before: 0.8, after: LOW_CONFIDENCE_THRESHOLD, decision: REVIEW_DECISION.REJECT });
  assert.equal(result.inconclusive, false);
});
