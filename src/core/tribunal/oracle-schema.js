// Oracle schema (v1): the final contract of the tribunal.
//
// Stage 5 is where the tribunal stops evaluating and starts *deciding*. Every
// earlier stage produced a fact -- a review, a survival score, a merge, a trial
// verdict -- and the Oracle folds them into one number and one report a caller
// can act on. Two commitments carry over verbatim from the earlier schemas,
// because they are the ones that stop the output from lying:
//
//   * Closed vocabulary. An unknown verdict, a component score outside [0, 1],
//     or an unknown field is a mistake the validator refuses where it is made.
//
//   * Fail-closed, non-throwing. A malformed report is reported as malformed,
//     never thrown past a caller trying to record it.
//
// And one commitment is new, and it is the whole point of the stage: the
// "Perfect or Nothing" gate. The confidence model weights every prior stage, and
// a verdict of VERIFIED is only reachable when that weighted confidence clears
// CONFIDENCE_THRESHOLD (0.95). Anything below is INSUFFICIENT_CONFIDENCE -- the
// output still ships, but flagged, with a battle report explaining exactly which
// stage held it back. The validator enforces the threshold from both ends: a
// VERIFIED report below 0.95 is invalid, and an INSUFFICIENT_CONFIDENCE report at
// or above 0.95 is too, so the verdict and the number cannot disagree.
//
// REJECTED and ABORTED are the two terminal non-outcomes. REJECTED is a merge the
// Trial convicted beyond repair (CONVICTED_FINAL); ABORTED is a run that never
// got far enough to judge (a skipped or unreadable stage). Both carry confidence
// 0 and no output, and the schema holds them there.

export const ORACLE_SCHEMA_VERSION = 1;

/** The "Perfect or Nothing" gate. At or above this, the output is endorsed. */
export const CONFIDENCE_THRESHOLD = 0.95;

/**
 * The confidence model. Five weighted components, summing to 1.0. The weights
 * encode what the tribunal trusts most: the Trial (0.30) is the last independent
 * check on the merge and so carries the most; the Oracle's own validation checks
 * (0.10) carry the least, because by then there is nothing left to discover.
 */
export const CONFIDENCE_WEIGHTS = Object.freeze({
  self_review: 0.15,
  survival: 0.25,
  merge: 0.2,
  trial: 0.3,
  validation: 0.1,
});

/**
 * How good a merge decision is, as a contribution to confidence. A synthesized
 * hybrid from multiple proposals is the ideal; a single retained proposal is a
 * weaker but acceptable outcome; producing nothing is zero.
 */
export const MERGE_QUALITY_SCORE = Object.freeze({
  SYNTHESIZED: 1.0,
  SINGLE_PROPOSAL_RETAINED: 0.8,
  INSUFFICIENT_INPUT: 0.0,
  IRRECONCILABLE: 0.0,
  UNAVAILABLE: 0.0,
});

/**
 * How good a Trial outcome is. A clean acquittal is perfect; an acquittal that
 * only came after a retry is discounted (the merge was wrong once); a final
 * conviction is near-zero; a mistrial or a skipped trial contributes nothing.
 */
export const TRIAL_SCORE = Object.freeze({
  ACQUITTED: 1.0,
  ACQUITTED_AFTER_RETRY: 0.7,
  CONVICTED: 0.2,
  MISTRIAL: 0.0,
  SKIPPED: 0.0,
});

/** The final verdicts of the whole tribunal. */
export const ORACLE_VERDICT = {
  VERIFIED: "VERIFIED",
  INSUFFICIENT_CONFIDENCE: "INSUFFICIENT_CONFIDENCE",
  REJECTED: "REJECTED",
  ABORTED: "ABORTED",
};

/** The stages a battle report narrates, in order. */
export const BATTLE_STAGES = Object.freeze({
  FORGE: "FORGE",
  CRUCIBLE: "CRUCIBLE",
  MERGE: "MERGE",
  TRIAL: "TRIAL",
  ORACLE: "ORACLE",
});

/** The domains a validation check may declare itself for. */
export const CHECK_DOMAINS = Object.freeze([
  "code",
  "architecture",
  "idea",
  "plan",
  "logic",
  "general",
]);

// The closed field lists. Exported so the validator, the engine, and fixtures
// share one source of truth and cannot drift.
export const ORACLE_FIELDS = Object.freeze([
  "schema_version",
  "verdict",
  "confidence",
  "confidence_breakdown",
  "validation_checks",
  "battle_report",
  "final_output",
  "caveats",
]);

export const BREAKDOWN_FIELDS = Object.freeze([
  "self_review_score",
  "survival_score",
  "merge_quality_score",
  "trial_score",
  "validation_score",
  "weights",
]);

export const WEIGHT_FIELDS = Object.freeze(["self_review", "survival", "merge", "trial", "validation"]);

export const CHECK_FIELDS = Object.freeze(["check_id", "name", "domain", "passed", "details"]);

export const BATTLE_FIELDS = Object.freeze([
  "title",
  "summary",
  "rounds",
  "winner",
  "total_findings",
  "resolved_findings",
  "unresolved_critical",
]);

export const ROUND_FIELDS = Object.freeze(["round_number", "stage", "events"]);

export const TOTAL_FINDINGS_FIELDS = Object.freeze(["p0", "p1", "p2", "p3"]);

const VERDICTS = new Set(Object.values(ORACLE_VERDICT));
const STAGES = new Set(Object.values(BATTLE_STAGES));
const DOMAINS = new Set(CHECK_DOMAINS);
const ORACLE_FIELD_SET = new Set(ORACLE_FIELDS);
const BREAKDOWN_FIELD_SET = new Set(BREAKDOWN_FIELDS);
const WEIGHT_FIELD_SET = new Set(WEIGHT_FIELDS);
const CHECK_FIELD_SET = new Set(CHECK_FIELDS);
const BATTLE_FIELD_SET = new Set(BATTLE_FIELDS);
const ROUND_FIELD_SET = new Set(ROUND_FIELDS);
const TOTAL_FINDINGS_FIELD_SET = new Set(TOTAL_FINDINGS_FIELDS);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isScore(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function addUnknownFields(errors, object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${where}unknown field "${key}"`);
  }
}

function addBreakdown(errors, breakdown) {
  if (!isPlainObject(breakdown)) {
    errors.push("confidence_breakdown must be an object");
    return;
  }
  addUnknownFields(errors, breakdown, BREAKDOWN_FIELD_SET, "confidence_breakdown.");

  for (const key of BREAKDOWN_FIELDS) {
    if (key === "weights") continue;
    if (!isScore(breakdown[key])) errors.push(`confidence_breakdown.${key} must be a number between 0 and 1`);
  }

  const weights = breakdown.weights;
  if (!isPlainObject(weights)) {
    errors.push("confidence_breakdown.weights must be an object");
    return;
  }
  addUnknownFields(errors, weights, WEIGHT_FIELD_SET, "confidence_breakdown.weights.");
  let sum = 0;
  for (const key of WEIGHT_FIELDS) {
    if (typeof weights[key] !== "number" || !Number.isFinite(weights[key])) {
      errors.push(`confidence_breakdown.weights.${key} must be a number`);
      continue;
    }
    sum += weights[key];
  }
  // The weights are a partition of 1.0; if they do not sum to it the confidence
  // they produce is not the confidence the model describes.
  if (Math.abs(sum - 1) > 1e-9) {
    errors.push(`confidence_breakdown.weights must sum to 1.0 (got ${sum})`);
  }
}

function addChecks(errors, checks) {
  if (!Array.isArray(checks)) {
    errors.push("validation_checks must be an array");
    return;
  }
  const seen = new Set();
  checks.forEach((check, index) => {
    const where = `validation_checks[${index}].`;
    if (!isPlainObject(check)) {
      errors.push(`validation_checks[${index}] must be an object`);
      return;
    }
    addUnknownFields(errors, check, CHECK_FIELD_SET, where);
    if (!isNonEmptyString(check.check_id)) {
      errors.push(`${where}check_id must be a non-empty string`);
    } else if (seen.has(check.check_id)) {
      errors.push(`${where}check_id "${check.check_id}" is used more than once`);
    } else {
      seen.add(check.check_id);
    }
    if (!isNonEmptyString(check.name)) errors.push(`${where}name must be a non-empty string`);
    if (!DOMAINS.has(check.domain)) {
      errors.push(`${where}domain must be one of ${[...DOMAINS].join(", ")}`);
    }
    if (typeof check.passed !== "boolean") errors.push(`${where}passed must be a boolean`);
    if (typeof check.details !== "string") errors.push(`${where}details must be a string`);
  });
}

function addBattleReport(errors, report) {
  if (!isPlainObject(report)) {
    errors.push("battle_report must be an object");
    return;
  }
  addUnknownFields(errors, report, BATTLE_FIELD_SET, "battle_report.");

  if (!isNonEmptyString(report.title)) errors.push("battle_report.title must be a non-empty string");
  if (!isNonEmptyString(report.summary)) errors.push("battle_report.summary must be a non-empty string");
  if (report.winner !== null && !isNonEmptyString(report.winner)) {
    errors.push("battle_report.winner must be a non-empty string or null");
  }

  if (!Array.isArray(report.rounds)) {
    errors.push("battle_report.rounds must be an array");
  } else {
    let last = -Infinity;
    let ordered = true;
    report.rounds.forEach((round, index) => {
      const where = `battle_report.rounds[${index}].`;
      if (!isPlainObject(round)) {
        errors.push(`battle_report.rounds[${index}] must be an object`);
        return;
      }
      addUnknownFields(errors, round, ROUND_FIELD_SET, where);
      if (!isCount(round.round_number) || round.round_number < 1) {
        errors.push(`${where}round_number must be a positive integer`);
      } else {
        if (round.round_number <= last) ordered = false;
        last = round.round_number;
      }
      if (!STAGES.has(round.stage)) {
        errors.push(`${where}stage must be one of ${[...STAGES].join(", ")}`);
      }
      if (!Array.isArray(round.events)) {
        errors.push(`${where}events must be an array of strings`);
      } else {
        round.events.forEach((event, i) => {
          if (!isNonEmptyString(event)) errors.push(`${where}events[${i}] must be a non-empty string`);
        });
      }
    });
    if (!ordered) errors.push("battle_report.rounds must be ordered by round_number");
  }

  const totals = report.total_findings;
  if (!isPlainObject(totals)) {
    errors.push("battle_report.total_findings must be an object");
  } else {
    addUnknownFields(errors, totals, TOTAL_FINDINGS_FIELD_SET, "battle_report.total_findings.");
    let sum = 0;
    let ok = true;
    for (const key of TOTAL_FINDINGS_FIELDS) {
      if (!isCount(totals[key])) {
        errors.push(`battle_report.total_findings.${key} must be a non-negative integer`);
        ok = false;
      } else {
        sum += totals[key];
      }
    }
    if (ok) {
      if (!isCount(report.resolved_findings)) {
        errors.push("battle_report.resolved_findings must be a non-negative integer");
      }
      if (!isCount(report.unresolved_critical)) {
        errors.push("battle_report.unresolved_critical must be a non-negative integer");
      }
      if (isCount(report.resolved_findings) && isCount(report.unresolved_critical)) {
        // Every finding the tribunal counted is either still outstanding as
        // critical or closed; the two buckets must partition the total.
        if (sum !== report.resolved_findings + report.unresolved_critical) {
          errors.push(
            `battle_report.total_findings must equal resolved_findings + unresolved_critical (got ${sum} vs ${report.resolved_findings + report.unresolved_critical})`,
          );
        }
      }
    }
  }
}

/**
 * Validate one Oracle report. Fail-closed and non-throwing.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateOracleReport(report) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["oracle report must be an object"] };

  addUnknownFields(errors, report, ORACLE_FIELD_SET, "");

  if (report.schema_version !== ORACLE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${ORACLE_SCHEMA_VERSION}`);
  }
  if (!VERDICTS.has(report.verdict)) {
    errors.push(`verdict must be one of ${[...VERDICTS].join(", ")}`);
  }
  if (!isScore(report.confidence)) {
    errors.push("confidence must be a number between 0 and 1");
  }

  addBreakdown(errors, report.confidence_breakdown);
  addChecks(errors, report.validation_checks);
  addBattleReport(errors, report.battle_report);

  if (report.final_output !== null && !isNonEmptyString(report.final_output)) {
    errors.push("final_output must be a non-empty string or null");
  }
  if (!Array.isArray(report.caveats)) {
    errors.push("caveats must be an array of strings");
  } else {
    report.caveats.forEach((caveat, index) => {
      if (!isNonEmptyString(caveat)) errors.push(`caveats[${index}] must be a non-empty string`);
    });
  }

  // The verdict and the confidence must agree. This is where the gate is
  // enforced from both ends and where a terminal verdict is held at zero.
  const confidence = report.confidence;
  const hasOutput = isNonEmptyString(report.final_output);
  const caveats = Array.isArray(report.caveats) ? report.caveats : [];

  if (report.verdict === ORACLE_VERDICT.VERIFIED) {
    if (typeof confidence === "number" && confidence < CONFIDENCE_THRESHOLD) {
      errors.push(`confidence must be at least ${CONFIDENCE_THRESHOLD} when verdict is VERIFIED`);
    }
    if (!hasOutput) errors.push("final_output must be a non-empty string when verdict is VERIFIED");
  } else if (report.verdict === ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE) {
    if (typeof confidence === "number" && confidence >= CONFIDENCE_THRESHOLD) {
      errors.push(`confidence must be below ${CONFIDENCE_THRESHOLD} when verdict is INSUFFICIENT_CONFIDENCE`);
    }
    if (caveats.length === 0) errors.push("caveats must be non-empty when verdict is INSUFFICIENT_CONFIDENCE");
  } else if (report.verdict === ORACLE_VERDICT.REJECTED || report.verdict === ORACLE_VERDICT.ABORTED) {
    if (confidence !== 0) errors.push(`confidence must be 0 when verdict is ${report.verdict}`);
    if (report.final_output !== null) errors.push(`final_output must be null when verdict is ${report.verdict}`);
  }

  return { valid: errors.length === 0, errors };
}

export default {
  ORACLE_SCHEMA_VERSION,
  CONFIDENCE_THRESHOLD,
  CONFIDENCE_WEIGHTS,
  MERGE_QUALITY_SCORE,
  TRIAL_SCORE,
  ORACLE_VERDICT,
  BATTLE_STAGES,
  CHECK_DOMAINS,
  ORACLE_FIELDS,
  BREAKDOWN_FIELDS,
  WEIGHT_FIELDS,
  CHECK_FIELDS,
  BATTLE_FIELDS,
  ROUND_FIELDS,
  TOTAL_FINDINGS_FIELDS,
  validateOracleReport,
};
