// Confidence-downgrade policy.
//
// The self-adversarial stage is only meaningful if finding a defect actually
// moves a number. This module is that policy, kept separate from the model call
// so it can be tested exhaustively with plain objects and no provider.
//
// The rules, stated once:
//
//   * A reproduced high/critical failure, a security weakness, a missed required
//     test, a fresh assumption, an unverified claim, or a compatibility or
//     performance risk all *require* the reviewer to lower its confidence.
//   * Confidence may never rise for repetition. Re-raising a number without new
//     evidence is the exact self-defence the stage exists to prevent, so any
//     increase demands a non-empty justification.
//   * A failing test overrides confidence entirely. No model is allowed to be
//     0.99 confident that a red test is green.
//   * Low confidence with nothing reproduced is not a verdict, it is
//     inconclusive: more verification, not a decision.
//
// Nothing here knows about models. It takes plain findings, tests, and two
// numbers, and returns a verdict.

import { EVIDENCE_KIND, FINDING_CATEGORY, REVIEW_DECISION } from "./review-schema.js";
import { SEVERITY } from "../blackboard.js";

/**
 * Why a downgrade is being demanded. Exported so a caller can report *which*
 * rule fired rather than a bare boolean.
 */
export const DOWNGRADE_TRIGGER = {
  REPRODUCED_FAILURE: "reproduced_failure",
  SECURITY_ISSUE: "security_issue",
  UNVERIFIED_CLAIM: "unverified_claim",
  NEW_ASSUMPTION: "new_assumption",
  MISSING_REQUIRED_TEST: "missing_required_test",
  COMPATIBILITY_RISK: "compatibility_risk",
  PERFORMANCE_RISK: "performance_risk",
};

export const DOWNGRADE_VERDICT = {
  OK: "OK",
  DOWNGRADE_REQUIRED: "downgrade_required",
  UNJUSTIFIED_INCREASE: "unjustified_increase",
  TESTS_FAILED: "tests_failed",
};

// At or below this, a review with no reproduced finding is not a decision.
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

const HIGH_SEVERITIES = new Set([SEVERITY.HIGH, SEVERITY.CRITICAL]);

function findingsFor(findings, categories) {
  const wanted = new Set(categories);
  return findings.some((f) => wanted.has(f?.category));
}

function hasReproducedHighSeverity(findings) {
  return findings.some(
    (f) => f?.evidence === EVIDENCE_KIND.REPRODUCED && HIGH_SEVERITIES.has(f?.severity),
  );
}

/**
 * Assess whether a review's confidence movement is warranted by its findings.
 *
 * @param {object} input
 * @param {number} [input.before]       confidence the author stated for the proposal
 * @param {number} [input.after]        confidence the reviewer states after review
 * @param {Array}  [input.findings]   failure hypotheses (category + evidence + severity)
 * @param {Array}  [input.tests]      proposed/observed tests; each may carry
 *                                     `required`, `present`, `executed`, `passed`
 * @param {string} [input.decision]   REVIEW_DECISION taken by the reviewer
 * @param {string} [input.justification] reason given for the movement
 * @returns {{
 *   triggers: string[], requiresDowngrade: boolean, delta: number,
 *   verdict: string, compliant: boolean,
 *   blockingTestFailure: boolean, inconclusive: boolean,
 * }}
 */
export function assessDowngrade({
  before,
  after,
  findings = [],
  tests = [],
  decision = null,
  justification = "",
} = {}) {
  const triggers = [];
  const list = Array.isArray(findings) ? findings : [];
  const testList = Array.isArray(tests) ? tests : [];

  if (hasReproducedHighSeverity(list)) triggers.push(DOWNGRADE_TRIGGER.REPRODUCED_FAILURE);
  if (findingsFor(list, [FINDING_CATEGORY.SECURITY])) triggers.push(DOWNGRADE_TRIGGER.SECURITY_ISSUE);
  if (findingsFor(list, [FINDING_CATEGORY.UNVERIFIED_CLAIM])) triggers.push(DOWNGRADE_TRIGGER.UNVERIFIED_CLAIM);
  if (findingsFor(list, [FINDING_CATEGORY.ASSUMPTION])) triggers.push(DOWNGRADE_TRIGGER.NEW_ASSUMPTION);
  if (findingsFor(list, [FINDING_CATEGORY.COMPATIBILITY])) triggers.push(DOWNGRADE_TRIGGER.COMPATIBILITY_RISK);
  if (findingsFor(list, [FINDING_CATEGORY.PERFORMANCE])) triggers.push(DOWNGRADE_TRIGGER.PERFORMANCE_RISK);
  if (testList.some((t) => t?.required === true && t?.present === false)) {
    triggers.push(DOWNGRADE_TRIGGER.MISSING_REQUIRED_TEST);
  }

  const requiresDowngrade = triggers.length > 0;
  const delta = after - before;
  const blockingTestFailure = testList.some(
    (t) => t?.executed === true && t?.passed === false,
  );

  // A failing test is the floor of the policy: it outranks everything else.
  if (blockingTestFailure) {
    return {
      triggers,
      requiresDowngrade,
      delta,
      verdict: DOWNGRADE_VERDICT.TESTS_FAILED,
      compliant: false,
      blockingTestFailure: true,
      inconclusive: false,
    };
  }

  let verdict = DOWNGRADE_VERDICT.OK;
  let compliant = true;

  if (requiresDowngrade && !(after < before)) {
    verdict = DOWNGRADE_VERDICT.DOWNGRADE_REQUIRED;
    compliant = false;
  } else if (!requiresDowngrade && after > before && !isNonEmpty(justification)) {
    verdict = DOWNGRADE_VERDICT.UNJUSTIFIED_INCREASE;
    compliant = false;
  }

  // Low confidence with nothing reproduced means "I have not shown anything
  // yet" -- the honest outcome is more verification, not a decision to ship.
  const inconclusive =
    after <= LOW_CONFIDENCE_THRESHOLD && !hasReproduced(list) && decision !== REVIEW_DECISION.REJECT;

  return { triggers, requiresDowngrade, delta, verdict, compliant, blockingTestFailure: false, inconclusive };
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasReproduced(findings) {
  return findings.some((f) => f?.evidence === EVIDENCE_KIND.REPRODUCED);
}

export default {
  DOWNGRADE_TRIGGER,
  DOWNGRADE_VERDICT,
  LOW_CONFIDENCE_THRESHOLD,
  assessDowngrade,
};
