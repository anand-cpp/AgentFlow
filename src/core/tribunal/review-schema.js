// Self-adversarial review schema (v1).
//
// The tribunal's self-critique stage asks the model that produced a proposal to
// return a hostile review of it. For that to be more than vibes, the review has
// to be a checkable shape: the same validator runs whether the bytes came from a
// local model, a test double, or a hand-written fixture.
//
// Two rules shape this module.
//
// The schema is a closed vocabulary. `decision: "revise"` is checkable;
// `decision: "rethink"` is a typo that silently never matches and shows up three
// layers away as "the stage never revises anything". Unknown values and unknown
// fields are rejected where the mistake is, the same way the agent registry and
// the Blackboard reject them.
//
// A finding is not "reproduced" until there is a reproduction. The single most
// dangerous failure of a self-adversarial reviewer is inventing a defect and
// labelling it proven. So REPRODUCED without a concrete reproduction is an
// invalid review, not a high-severity finding -- and classifyFindings() refuses
// to count such an accusation as reproduced even if a caller skips validation.

import { SEVERITY } from "../blackboard.js";

export const SELF_REVIEW_SCHEMA_VERSION = 1;

/**
 * What the reviewer decided to do with the candidate it was handed.
 *
 * There is deliberately no "defend" or "approve as-is" option: silence is not a
 * decision. A model that cannot name a defect still has to say why, and choose
 * between keeping the proposal with evidence or rejecting it.
 */
export const REVIEW_DECISION = {
  REVISE: "REVISE",
  REJECT: "REJECT",
  RETAIN_WITH_EVIDENCE: "RETAIN_WITH_EVIDENCE",
};

/**
 * Whether a named failure was actually demonstrated or is still a suspicion.
 *
 * The distinction is the whole point of the stage. A HYPOTHESIS is a legitimate
 * output -- "this looks racy, I have not shown it" -- and must not be laundered
 * into a reproduced finding just because it sounds serious.
 */
export const EVIDENCE_KIND = {
  REPRODUCED: "reproduced",
  HYPOTHESIS: "hypothesis",
};

/**
 * Where a finding lives. Closed set so downgrade policy can key off it
 * (a security weakness and a performance concern trigger the same rule, a
 * styling preference does not trigger anything).
 */
export const FINDING_CATEGORY = {
  CORRECTNESS: "correctness",
  LOGIC: "logic",
  EDGE_CASE: "edge_case",
  SECURITY: "security",
  ASSUMPTION: "assumption",
  MISSING_EVIDENCE: "missing_evidence",
  UNVERIFIED_CLAIM: "unverified_claim",
  COMPATIBILITY: "compatibility",
  PERFORMANCE: "performance",
  OTHER: "other",
};

/**
 * What a proposed test is expected to show. A counterexample is a test the
 * candidate should fail; anything else is a regression guard.
 */
export const TEST_EXPECTATION = {
  PASS: "pass",
  FAIL: "fail",
};

// Below this many failure hypotheses we require the reviewer to justify the
// shortfall. The reviewer is asked for at least three meaningful hypotheses, but
// "meaningful" is the operative word: the rationale field exists so a reviewer
// with genuinely nothing to add says so instead of padding the list with
// invented defects to reach a count.
export const MIN_MEANINGFUL_HYPOTHESES = 3;

const DECISIONS = new Set(Object.values(REVIEW_DECISION));
const EVIDENCE_KINDS = new Set(Object.values(EVIDENCE_KIND));
const CATEGORIES = new Set(Object.values(FINDING_CATEGORY));
const SEVERITIES = new Set(Object.values(SEVERITY));
const EXPECTATIONS = new Set(Object.values(TEST_EXPECTATION));

/**
 * The full field list. Exported so callers, fixtures, and docs share one source
 * of truth instead of re-listing the shape and drifting.
 */
export const REVIEW_FIELDS = Object.freeze([
  { name: "schemaVersion", type: "number", required: true },
  { name: "candidateId", type: "string", required: true },
  { name: "originalApproach", type: "string", required: true },
  { name: "strongestCounterArgument", type: "string", required: true },
  { name: "failureHypotheses", type: "array<finding>", required: true },
  { name: "failureHypothesesRationale", type: "string", required: "when fewer than 3 hypotheses" },
  { name: "assumptions", type: "array<string>", required: true },
  { name: "missingEvidence", type: "array<string>", required: true },
  { name: "securityWeaknesses", type: "array<string>", required: true },
  { name: "logicRisks", type: "array<string>", required: true },
  { name: "edgeCases", type: "array<string>", required: true },
  { name: "performanceConcerns", type: "array<string>", required: true },
  { name: "proposedTests", type: "array<test>", required: true },
  { name: "confidenceBefore", type: "number", required: true },
  { name: "confidenceAfter", type: "number", required: true },
  { name: "confidenceJustification", type: "string", required: true },
  { name: "decision", type: "enum", required: true },
  { name: "revisedApproach", type: "string|null", required: "when decision is REVISE" },
]);

const FIELD_NAMES = new Set(REVIEW_FIELDS.map((f) => f.name));
const STRING_LIST_FIELDS = [
  "assumptions",
  "missingEvidence",
  "securityWeaknesses",
  "logicRisks",
  "edgeCases",
  "performanceConcerns",
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addString(errors, object, key) {
  if (!isNonEmptyString(object[key])) errors.push(`${key} must be a non-empty string`);
}

function addConfidence(errors, object, key) {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    errors.push(`${key} must be a number between 0 and 1`);
  }
}

function addStringList(errors, object, key) {
  const value = object[key];
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array of strings`);
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) errors.push(`${key}[${index}] must be a non-empty string`);
  });
}

function addFindings(errors, value) {
  if (!Array.isArray(value)) {
    errors.push("failureHypotheses must be an array");
    return;
  }
  value.forEach((finding, index) => {
    const where = `failureHypotheses[${index}]`;
    if (!isPlainObject(finding)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!isNonEmptyString(finding.statement)) errors.push(`${where}.statement must be a non-empty string`);
    if (!SEVERITIES.has(finding.severity)) errors.push(`${where}.severity must be one of ${[...SEVERITIES].join(", ")}`);
    if (!CATEGORIES.has(finding.category)) errors.push(`${where}.category must be one of ${[...CATEGORIES].join(", ")}`);
    if (!EVIDENCE_KINDS.has(finding.evidence)) {
      errors.push(`${where}.evidence must be one of ${[...EVIDENCE_KINDS].join(", ")}`);
      return;
    }
    if (finding.evidence === EVIDENCE_KIND.REPRODUCED && !isNonEmptyString(finding.reproduction)) {
      errors.push(`${where}.reproduction is required when evidence is "reproduced"`);
    }
    if (finding.reproduction !== undefined && finding.reproduction !== null && !isNonEmptyString(finding.reproduction)) {
      errors.push(`${where}.reproduction must be a non-empty string or null`);
    }
  });
}

function addProposedTests(errors, value) {
  if (!Array.isArray(value)) {
    errors.push("proposedTests must be an array");
    return;
  }
  value.forEach((item, index) => {
    const where = `proposedTests[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${where} must be an object`);
      return;
    }
    if (!isNonEmptyString(item.description)) errors.push(`${where}.description must be a non-empty string`);
    if (!EXPECTATIONS.has(item.expected)) errors.push(`${where}.expected must be one of ${[...EXPECTATIONS].join(", ")}`);
    if (typeof item.executed !== "boolean") errors.push(`${where}.executed must be a boolean`);
    // `passed` is the machine-checkable outcome; `observed` is the human note.
    // A test that ran must carry a boolean verdict, because "did it pass?" is
    // exactly the fact confidence is not allowed to overrule.
    if (item.executed === true && typeof item.passed !== "boolean") {
      errors.push(`${where}.passed must be a boolean when executed is true`);
    }
    if (item.executed === false && item.passed !== null && item.passed !== undefined && typeof item.passed !== "boolean") {
      errors.push(`${where}.passed must be null when executed is false`);
    }
    if (item.observed !== undefined && item.observed !== null && typeof item.observed !== "string") {
      errors.push(`${where}.observed must be a string or null`);
    }
  });
}

/**
 * Validate a self-review object. Fail-closed and non-throwing: a parser is
 * already the caller's worry, and a malformed review must be reported as
 * malformed rather than thrown past a stage that is trying to record it.
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSelfReview(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["review must be an object"] };

  for (const key of Object.keys(value)) {
    if (!FIELD_NAMES.has(key)) errors.push(`unknown field "${key}"`);
  }

  if (value.schemaVersion !== SELF_REVIEW_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SELF_REVIEW_SCHEMA_VERSION}`);
  }

  addString(errors, value, "candidateId");
  addString(errors, value, "originalApproach");
  addString(errors, value, "strongestCounterArgument");
  addString(errors, value, "confidenceJustification");

  addConfidence(errors, value, "confidenceBefore");
  addConfidence(errors, value, "confidenceAfter");

  for (const key of STRING_LIST_FIELDS) addStringList(errors, value, key);

  if (!DECISIONS.has(value.decision)) {
    errors.push(`decision must be one of ${[...DECISIONS].join(", ")}`);
  }

  addFindings(errors, value.failureHypotheses);

  if (Array.isArray(value.failureHypotheses) && value.failureHypotheses.length < MIN_MEANINGFUL_HYPOTHESES) {
    addString(errors, value, "failureHypothesesRationale");
  }

  addProposedTests(errors, value.proposedTests);

  if (value.decision === REVIEW_DECISION.REVISE) {
    addString(errors, value, "revisedApproach");
  } else if (value.revisedApproach !== undefined && value.revisedApproach !== null && typeof value.revisedApproach !== "string") {
    errors.push("revisedApproach must be a string or null");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Partition a review's failure hypotheses by whether the reviewer actually
 * reproduced them.
 *
 * Validation already rejects REPRODUCED findings with no reproduction. This
 * function is the belt-and-braces check for callers that hand it unvalidated
 * data (tests, fixtures, a future external examiner): an accusation marked
 * reproduced but carrying no reproduction lands in `unverifiedAccusations`, never
 * in `reproduced`.
 */
export function classifyFindings(review) {
  const findings = Array.isArray(review?.failureHypotheses) ? review.failureHypotheses : [];
  const reproduced = [];
  const hypotheses = [];
  const unverifiedAccusations = [];

  for (const finding of findings) {
    const hasReproduction = isNonEmptyString(finding?.reproduction);
    if (finding?.evidence === EVIDENCE_KIND.REPRODUCED) {
      if (hasReproduction) reproduced.push(finding);
      else unverifiedAccusations.push(finding);
    } else {
      hypotheses.push(finding);
    }
  }

  return { reproduced, hypotheses, unverifiedAccusations };
}

export default {
  SELF_REVIEW_SCHEMA_VERSION,
  REVIEW_DECISION,
  EVIDENCE_KIND,
  FINDING_CATEGORY,
  TEST_EXPECTATION,
  MIN_MEANINGFUL_HYPOTHESES,
  REVIEW_FIELDS,
  validateSelfReview,
  classifyFindings,
};
