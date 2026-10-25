// The Arena rubric (src/core/tournament/rubric.js): weights, scoring, ties.

import test from "node:test";
import assert from "node:assert/strict";

const r = await import("../src/core/tournament/rubric.js");

test("the rubric has five weighted criteria that sum to exactly one", () => {
  assert.deepEqual(
    r.CRITERIA.map((c) => c.id),
    ["correctness", "completeness", "robustness", "specificity", "clarity"],
  );
  const check = r.validateWeights();
  assert.equal(check.ok, true);
  assert.equal(check.total, 1);
});

test("every criterion is documented with anchors and a question", () => {
  for (const criterion of r.CRITERIA) {
    assert.ok(criterion.question.endsWith(".") || criterion.question.length > 20);
    assert.equal(criterion.anchors.length, 4);
    assert.deepEqual(
      criterion.anchors.map((a) => a.score),
      [10, 7, 4, 0],
    );
  }
});

test("weight validation rejects missing, extra, non-numeric, and non-normalised tables", () => {
  const missing = { ...r.RUBRIC_WEIGHTS };
  delete missing.clarity;
  assert.match(r.validateWeights(missing).errors.join(" "), /missing "clarity"/);

  const extra = { ...r.RUBRIC_WEIGHTS, style: 0.1 };
  assert.match(r.validateWeights(extra).errors.join(" "), /unknown weight "style"/);

  const wrongType = /** @type {Record<string, number>} */ (
    /** @type {unknown} */ ({ ...r.RUBRIC_WEIGHTS, clarity: "0.1" })
  );
  assert.match(r.validateWeights(wrongType).errors.join(" "), /must be a finite number/);

  const negative = { ...r.RUBRIC_WEIGHTS, clarity: -0.1, correctness: 0.5 };
  assert.match(r.validateWeights(negative).errors.join(" "), /greater than 0/);

  const unnormalised = { ...r.RUBRIC_WEIGHTS, correctness: 0.4 };
  const check = r.validateWeights(unnormalised);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /must sum to 1\.0/);
});

test("a valid score is weighted and published on a 0-100 scale", () => {
  const score = r.scoreCandidate({
    correctness: 10,
    completeness: 8,
    robustness: 9,
    specificity: 7,
    clarity: 8,
  });

  assert.equal(score.ok, true);
  // 10*.30 + 8*.25 + 9*.20 + 7*.15 + 8*.10 = 8.65
  assert.equal(score.weighted, 8.65);
  assert.equal(score.total, 86.5);
  assert.deepEqual(score.criteria, {
    correctness: 10,
    completeness: 8,
    robustness: 9,
    specificity: 7,
    clarity: 8,
  });
});

test("a zero is a score, not an error", () => {
  const score = r.scoreCandidate({
    correctness: 0,
    completeness: 0,
    robustness: 0,
    specificity: 0,
    clarity: 0,
  });
  assert.equal(score.ok, true);
  assert.equal(score.total, 0);
});

test("missing, unknown, non-numeric, and out-of-range criteria are rejected", () => {
  const valid = {
    correctness: 8,
    completeness: 8,
    robustness: 8,
    specificity: 8,
    clarity: 8,
  };

  const missing = { ...valid };
  delete missing.robustness;
  assert.match(r.scoreCandidate(missing).errors.join(" "), /missing "robustness"/);

  assert.match(
    r.scoreCandidate({ ...valid, style: 8 }).errors.join(" "),
    /unknown score "style"/,
  );

  for (const bad of ["8", null, undefined, NaN, Infinity]) {
    assert.equal(
      r.scoreCandidate({ ...valid, correctness: /** @type {number} */ (bad) }).ok,
      false,
      `expected ${String(bad)} to be rejected`,
    );
  }

  for (const bad of [-1, 10.1, 100]) {
    const check = r.scoreCandidate({ ...valid, correctness: bad });
    assert.equal(check.ok, false);
    assert.match(check.errors.join(" "), /between 0 and 10/);
  }
});

test("totals within the tie epsilon compare level", () => {
  assert.equal(r.compareTotals(80, 80), 0);
  assert.equal(r.compareTotals(80, 80.04), 0);
  assert.equal(r.compareTotals(80, 79.96), 0);
  assert.equal(r.compareTotals(80.06, 80), 1);
  assert.equal(r.compareTotals(79.94, 80), -1);
  assert.equal(r.TIE_EPSILON, 0.05);
});

test("the machine-readable rubric exposes the version and serious-defect threshold", () => {
  const schema = r.rubricSchema();
  assert.equal(schema.version, r.RUBRIC_VERSION);
  assert.equal(schema.serious_defect_score, 3);
  assert.equal(schema.criteria.length, 5);
  assert.match(r.rubricTable(), /correctness \(weight 0\.30\)/);
});
