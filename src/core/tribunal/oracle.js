// Stage 5 -- The Oracle: final validation, confidence gate, battle report.
//
// The Oracle is the only stage that makes no model call. Everything it needs was
// already produced by the stages before it, so its job is arithmetic and
// narration: fold five stages of evidence into one confidence number, decide
// whether that number clears the "Perfect or Nothing" gate, and write the battle
// report that explains the decision either way.
//
// Three properties are enforced here rather than hoped for:
//
//   * The engine never throws. A missing stage, a skipped merge, or a garbled
//     trial is a verdict (ABORTED or REJECTED), not an exception, so a pipeline
//     can always record an outcome.
//
//   * The gate is not the model's to move. Confidence is computed from the
//     stages' own numbers; a trial the model called ACQUITTED still has to earn
//     its weight, and a merge that produced no hybrid scores zero regardless of
//     how the prose reads.
//
//   * The confidence and the verdict cannot disagree. VERIFIED is only emitted
//     at or above CONFIDENCE_THRESHOLD and INSUFFICIENT_CONFIDENCE only below it,
//     which is exactly what oracle-schema.js validates from both ends.

import { redactDeep } from "../redact.js";
import { CRUCIBLE_SEVERITY } from "./crucible-schema.js";
import { FINDING_RESOLUTION_STATUS, MERGE_DECISION } from "./merge-schema.js";
import { TRIAL_VECTOR, TRIAL_VERDICT } from "./trial-schema.js";
import {
  BATTLE_STAGES,
  CONFIDENCE_THRESHOLD,
  CONFIDENCE_WEIGHTS,
  MERGE_QUALITY_SCORE,
  ORACLE_SCHEMA_VERSION,
  ORACLE_VERDICT,
  TRIAL_SCORE,
} from "./oracle-schema.js";

/** The validation checks, by id, so callers and tests name them without typos. */
export const VALIDATION_CHECK = {
  STRUCTURAL_INTEGRITY: "STRUCTURAL_INTEGRITY",
  FINDING_CLOSURE: "FINDING_CLOSURE",
  TRIAL_SURVIVAL: "TRIAL_SURVIVAL",
  PROVENANCE_COMPLETE: "PROVENANCE_COMPLETE",
  NO_SCOPE_INFLATION: "NO_SCOPE_INFLATION",
};

const CHECK_NAMES = Object.freeze({
  [VALIDATION_CHECK.STRUCTURAL_INTEGRITY]: "Structural integrity",
  [VALIDATION_CHECK.FINDING_CLOSURE]: "Finding closure",
  [VALIDATION_CHECK.TRIAL_SURVIVAL]: "Trial survival",
  [VALIDATION_CHECK.PROVENANCE_COMPLETE]: "Provenance complete",
  [VALIDATION_CHECK.NO_SCOPE_INFLATION]: "No scope inflation",
});

const CRITICAL_SEVERITIES = new Set([CRUCIBLE_SEVERITY.P0_CRITICAL, CRUCIBLE_SEVERITY.P1_MAJOR]);
const SEVERITY_BUCKET = {
  [CRUCIBLE_SEVERITY.P0_CRITICAL]: "p0",
  [CRUCIBLE_SEVERITY.P1_MAJOR]: "p1",
  [CRUCIBLE_SEVERITY.P2_MINOR]: "p2",
  [CRUCIBLE_SEVERITY.P3_INFORMATIONAL]: "p3",
};

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

/** Pull a merge report out of a merge stage result, a bare report, or a nested one. */
function mergeReportOf(mergeStageResult) {
  if (!isPlainObject(mergeStageResult)) return null;
  const nested = mergeStageResult.result?.report ?? mergeStageResult.report;
  if (isPlainObject(nested)) return nested;
  if (mergeStageResult.hybrid_solution || mergeStageResult.decision) return mergeStageResult;
  return null;
}

/** Pull the trial's report out of a trial stage result (single trial or retry loop). */
function trialReportOf(stage4Result) {
  if (!isPlainObject(stage4Result)) return null;
  if (isPlainObject(stage4Result.trialResult?.report)) return stage4Result.trialResult.report;
  if (isPlainObject(stage4Result.finalTrial?.report)) return stage4Result.finalTrial.report;
  if (isPlainObject(stage4Result.report)) return stage4Result.report;
  return null;
}

/**
 * The single authoritative trial verdict, whether the stage ran one trial or a
 * retry loop: the retry loop reports `finalVerdict`, the single stage reports an
 * `outcome.verdict`, and a raw status maps MISTRIAL/SKIPPED directly.
 */
function finalVerdictOf(stage4Result) {
  if (!isPlainObject(stage4Result)) return null;
  if (isNonEmptyString(stage4Result.finalVerdict)) return stage4Result.finalVerdict;
  if (isNonEmptyString(stage4Result.outcome?.verdict)) return stage4Result.outcome.verdict;
  if (stage4Result.status === "MISTRIAL") return TRIAL_VERDICT.MISTRIAL;
  if (stage4Result.status === "SKIPPED") return "SKIPPED";
  if (isNonEmptyString(trialReportOf(stage4Result)?.verdict)) return trialReportOf(stage4Result).verdict;
  return null;
}

/** Flatten every P-finding the Crucible raised across all proposals. */
function collectCrucibleFindings(stage2Result) {
  const results = Array.isArray(stage2Result?.results) ? stage2Result.results : [];
  const flat = [];
  for (const result of results) {
    const findings = Array.isArray(result?.aggregatedFindings) ? result.aggregatedFindings : [];
    for (const finding of findings) flat.push(finding);
  }
  return flat;
}

function crucibleFindingsFor(stage2Result, stage3Result, options) {
  if (Array.isArray(options.crucibleFindings)) return options.crucibleFindings;
  const fromStage2 = collectCrucibleFindings(stage2Result);
  if (fromStage2.length > 0) return fromStage2;
  return Array.isArray(stage3Result?.criticalFindings) ? stage3Result.criticalFindings : [];
}

// ---------------------------------------------------------------------------
// 2.1 Confidence computation
// ---------------------------------------------------------------------------

/** Stage 1: average post-review confidence, or 1.0 when no review data exists. */
function selfReviewComponent(stage1Result) {
  const candidates = Array.isArray(stage1Result?.candidates) ? stage1Result.candidates : [];
  if (candidates.length === 0) return 1.0;
  let sum = 0;
  for (const candidate of candidates) {
    const value = candidate?.review?.confidenceAfter;
    sum += typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : 1.0;
  }
  return sum / candidates.length;
}

/** Stage 2: average survival score across proposals, or 1.0 when no data. */
function survivalComponent(stage2Result) {
  const results = Array.isArray(stage2Result?.results) ? stage2Result.results : [];
  if (results.length === 0) return 1.0;
  let sum = 0;
  for (const result of results) {
    const value = result?.survivalScore;
    sum += typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : 0;
  }
  return sum / results.length;
}

/** Stage 3: how good the merge decision was. Not COMPLETED means zero. */
function mergeQualityComponent(stage3Result) {
  if (isPlainObject(stage3Result) && isNonEmptyString(stage3Result.status) && stage3Result.status !== "COMPLETED") {
    return MERGE_QUALITY_SCORE.UNAVAILABLE;
  }
  const report = mergeReportOf(stage3Result);
  if (!report) return MERGE_QUALITY_SCORE.UNAVAILABLE;
  const score = MERGE_QUALITY_SCORE[report.decision];
  return typeof score === "number" ? score : MERGE_QUALITY_SCORE.UNAVAILABLE;
}

/** Stage 4: how good the trial outcome was. An acquittal after a retry is discounted. */
function trialComponent(stage4Result) {
  const verdict = finalVerdictOf(stage4Result);
  if (verdict === TRIAL_VERDICT.ACQUITTED) {
    const history = Array.isArray(stage4Result?.history) ? stage4Result.history : [];
    const hadRetry = history.some((entry) => entry?.verdict === TRIAL_VERDICT.CONVICTED_RETRY);
    return hadRetry ? TRIAL_SCORE.ACQUITTED_AFTER_RETRY : TRIAL_SCORE.ACQUITTED;
  }
  if (verdict === TRIAL_VERDICT.CONVICTED_RETRY || verdict === TRIAL_VERDICT.CONVICTED_FINAL) {
    return TRIAL_SCORE.CONVICTED;
  }
  if (verdict === TRIAL_VERDICT.MISTRIAL) return TRIAL_SCORE.MISTRIAL;
  return TRIAL_SCORE.SKIPPED;
}

/** Stage 5: ratio of validation checks that passed; vacuously 1.0 when there are none. */
function validationComponent(validationChecks) {
  const checks = Array.isArray(validationChecks) ? validationChecks : [];
  if (checks.length === 0) return 1.0;
  const passed = checks.filter((check) => check?.passed === true).length;
  return passed / checks.length;
}

/**
 * Fold every stage into one confidence score and its breakdown.
 *
 * @param {object} input
 * @param {object} [input.stage1Result]
 * @param {object} [input.stage2Result]
 * @param {object} [input.stage3Result]
 * @param {object} [input.stage4Result]
 * @param {Array}  [input.validationChecks]
 * @returns {{ confidence: number, breakdown: object }}
 */
export function computeConfidence({ stage1Result, stage2Result, stage3Result, stage4Result, validationChecks } = {}) {
  const selfReview = selfReviewComponent(stage1Result);
  const survival = survivalComponent(stage2Result);
  const merge = mergeQualityComponent(stage3Result);
  const trial = trialComponent(stage4Result);
  const validation = validationComponent(validationChecks);

  const confidence = clamp(
    selfReview * CONFIDENCE_WEIGHTS.self_review +
      survival * CONFIDENCE_WEIGHTS.survival +
      merge * CONFIDENCE_WEIGHTS.merge +
      trial * CONFIDENCE_WEIGHTS.trial +
      validation * CONFIDENCE_WEIGHTS.validation,
    0,
    1,
  );

  return {
    confidence,
    breakdown: {
      self_review_score: selfReview,
      survival_score: survival,
      merge_quality_score: merge,
      trial_score: trial,
      validation_score: validation,
      weights: { ...CONFIDENCE_WEIGHTS },
    },
  };
}

// ---------------------------------------------------------------------------
// 2.2 Validation checks
// ---------------------------------------------------------------------------

function makeCheck(checkId, domain, passed, details) {
  return { check_id: checkId, name: CHECK_NAMES[checkId], domain, passed, details };
}

/**
 * Run the domain-agnostic validation checks. None of these needs a model: each
 * is a fact about the merge report or the trial report that a caller can verify
 * by reading the data.
 *
 * @param {object} input
 * @param {object} [input.mergeReport]
 * @param {object} [input.trialReport]
 * @param {string} [input.domain]
 * @param {object} [input.options]
 * @param {Array}  [input.options.crucibleFindings]
 * @param {string} [input.options.finalTrialVerdict]
 * @returns {Array<{check_id: string, name: string, domain: string, passed: boolean, details: string}>}
 */
export function runValidationChecks({ mergeReport, trialReport, domain = "general", options = {} } = {}) {
  const checks = [];
  const crucibleFindings = Array.isArray(options.crucibleFindings) ? options.crucibleFindings : [];
  const trialFindings = Array.isArray(trialReport?.findings) ? trialReport.findings : [];
  const finalVerdict = options.finalTrialVerdict ?? trialReport?.verdict ?? null;

  // 1. Structural integrity: is there a merged solution with real content?
  const content = mergeReport?.hybrid_solution?.content;
  checks.push(
    makeCheck(
      VALIDATION_CHECK.STRUCTURAL_INTEGRITY,
      domain,
      isNonEmptyString(content),
      isNonEmptyString(content)
        ? "The merged solution carries non-empty content."
        : "The merge report has no non-empty hybrid content.",
    ),
  );

  // 2. Finding closure: every P0 the Crucible raised must be ADDRESSED by the merge.
  const p0Findings = crucibleFindings.filter((f) => f?.severity === CRUCIBLE_SEVERITY.P0_CRITICAL);
  const addressed = new Set();
  for (const entry of Array.isArray(mergeReport?.findings_resolution) ? mergeReport.findings_resolution : []) {
    if (entry?.status === FINDING_RESOLUTION_STATUS.ADDRESSED && isNonEmptyString(entry.finding_id)) {
      addressed.add(entry.finding_id);
    }
  }
  const unclosed = p0Findings.filter((f) => {
    const id = f?.id ?? f?.finding_id;
    return !isNonEmptyString(id) || !addressed.has(id);
  });
  checks.push(
    makeCheck(
      VALIDATION_CHECK.FINDING_CLOSURE,
      domain,
      unclosed.length === 0,
      p0Findings.length === 0
        ? "No P0 findings were raised; nothing to close."
        : `${p0Findings.length - unclosed.length}/${p0Findings.length} P0 finding(s) addressed by the merge.`,
    ),
  );

  // 3. Trial survival: did the Trial end in an acquittal?
  checks.push(
    makeCheck(
      VALIDATION_CHECK.TRIAL_SURVIVAL,
      domain,
      finalVerdict === TRIAL_VERDICT.ACQUITTED,
      `Trial verdict: ${finalVerdict ?? "unknown"}.`,
    ),
  );

  // 4. Provenance complete: does every element name at least one source?
  const elements = mergeReport?.hybrid_solution?.elements;
  const hasElements = Array.isArray(elements) && elements.length > 0;
  const allSourced =
    hasElements &&
    elements.every(
      (element) =>
        Array.isArray(element?.source_proposal_ids) && element.source_proposal_ids.some(isNonEmptyString),
    );
  checks.push(
    makeCheck(
      VALIDATION_CHECK.PROVENANCE_COMPLETE,
      domain,
      allSourced,
      hasElements
        ? allSourced
          ? `All ${elements.length} element(s) cite at least one source proposal.`
          : "One or more elements cite no source proposal."
        : "The merge records no elements to check provenance on.",
    ),
  );

  // 5. No scope inflation: did the Trial flag SCOPE_INFLATION as P0/P1?
  const inflated = trialFindings.filter(
    (f) => f?.vector === TRIAL_VECTOR.SCOPE_INFLATION && CRITICAL_SEVERITIES.has(f?.severity),
  );
  checks.push(
    makeCheck(
      VALIDATION_CHECK.NO_SCOPE_INFLATION,
      domain,
      inflated.length === 0,
      inflated.length === 0
        ? "The Trial found no critical scope inflation."
        : `The Trial flagged ${inflated.length} critical scope-inflation finding(s).`,
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// 2.3 Battle report
// ---------------------------------------------------------------------------

function countFindings(findings) {
  const totals = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const finding of findings) {
    const bucket = SEVERITY_BUCKET[finding?.severity];
    if (bucket) totals[bucket] += 1;
  }
  return totals;
}

function buildWinner(mergeReport, verdict) {
  if (verdict === ORACLE_VERDICT.REJECTED || verdict === ORACLE_VERDICT.ABORTED) return null;
  const content = mergeReport?.hybrid_solution?.content;
  if (!isNonEmptyString(content)) return null;
  const snippet = content.trim().replace(/\s+/g, " ").slice(0, 120);
  const label =
    mergeReport.decision === MERGE_DECISION.SINGLE_PROPOSAL_RETAINED ? "Retained proposal" : "Synthesized hybrid";
  return `${label}: ${snippet}`;
}

/**
 * Compose the human-readable battle report: one round per stage, a winner, and
 * the aggregated finding ledgers.
 *
 * @param {object} input
 * @param {object} [input.stage1Result]  runSelfAdversarialStage() result
 * @param {object} [input.stage2Result]  runCrucibleStage() result
 * @param {object} [input.stage3Result]  runMergeStage() result
 * @param {object} [input.stage4Result]  runTrialStage() result
 * @param {number} [input.confidence=0]
 * @param {string} [input.verdict]
 * @param {string} [input.domain]
 * @returns {object}
 */
export function generateBattleReport({
  stage1Result,
  stage2Result,
  stage3Result,
  stage4Result,
  confidence = 0,
  verdict = ORACLE_VERDICT.ABORTED,
  domain = "general",
} = {}) {
  const mergeReport = mergeReportOf(stage3Result);
  const trialReport = trialReportOf(stage4Result);
  const finalVerdict = finalVerdictOf(stage4Result);

  const summaries = stage1Result?.summary ?? {};
  const candidates = Array.isArray(stage1Result?.candidates) ? stage1Result.candidates : [];
  const forgeTotal = typeof summaries.total === "number" ? summaries.total : candidates.length;
  const forgeReviewed =
    typeof summaries.reviewed === "number"
      ? summaries.reviewed
      : candidates.filter((c) => c?.outcome === "reviewed").length;
  const forgeInvalid =
    typeof summaries.invalid === "number"
      ? summaries.invalid
      : candidates.filter((c) => c?.outcome === "invalid_review").length;

  const crucibleResults = Array.isArray(stage2Result?.results) ? stage2Result.results : [];
  const crucibleFindings = collectCrucibleFindings(stage2Result);
  const vectors = new Set(crucibleFindings.map((f) => f?.vector).filter(isNonEmptyString));
  const survivalScores = crucibleResults.map((r) => {
    const score = typeof r?.survivalScore === "number" ? r.survivalScore.toFixed(2) : "0.00";
    return `${r?.proposalId ?? "?"}=${score}`;
  });

  const elements = mergeReport?.hybrid_solution?.elements;
  const elementCount = Array.isArray(elements) ? elements.length : 0;

  const trialFindings = Array.isArray(trialReport?.findings) ? trialReport.findings : [];

  const rounds = [
    {
      round_number: 1,
      stage: BATTLE_STAGES.FORGE,
      events: [
        `${forgeTotal} proposal(s) generated; ${forgeReviewed} survived self-review${forgeInvalid > 0 ? `, ${forgeInvalid} unreadable` : ""}.`,
      ],
    },
    {
      round_number: 2,
      stage: BATTLE_STAGES.CRUCIBLE,
      events: [
        `${crucibleFindings.length} finding(s) across ${vectors.size} attack vector(s).`,
        survivalScores.length > 0 ? `Survival: ${survivalScores.join(", ")}.` : "No proposals were cross-examined.",
      ],
    },
    {
      round_number: 3,
      stage: BATTLE_STAGES.MERGE,
      events: [
        `Decision: ${mergeReport?.decision ?? "NONE"}${stage3Result?.status ? ` (${stage3Result.status})` : ""}.`,
        `${elementCount} element(s) merged.`,
        ...(isNonEmptyString(stage3Result?.gate?.reason) ? [`Gate: ${stage3Result.gate.reason}.`] : []),
      ],
    },
    {
      round_number: 4,
      stage: BATTLE_STAGES.TRIAL,
      events: [`Verdict: ${finalVerdict ?? "unknown"}.`, `${trialFindings.length} finding(s) raised by the prosecutor.`],
    },
    {
      round_number: 5,
      stage: BATTLE_STAGES.ORACLE,
      events: [`Confidence: ${pct(confidence)}.`, `Verdict: ${verdict}.`],
    },
  ];

  const allFindings = [...crucibleFindings, ...trialFindings];
  const totalFindings = countFindings(allFindings);
  const total = totalFindings.p0 + totalFindings.p1 + totalFindings.p2 + totalFindings.p3;

  const resolvedIds = new Set();
  for (const entry of Array.isArray(mergeReport?.findings_resolution) ? mergeReport.findings_resolution : []) {
    if (isNonEmptyString(entry?.finding_id)) resolvedIds.add(entry.finding_id);
  }
  const unresolvedCritical = allFindings.filter((finding) => {
    if (!CRITICAL_SEVERITIES.has(finding?.severity)) return false;
    const id = finding?.id ?? finding?.finding_id;
    return !isNonEmptyString(id) || !resolvedIds.has(id);
  }).length;
  const resolvedFindings = Math.max(0, total - unresolvedCritical);

  const summary =
    verdict === ORACLE_VERDICT.VERIFIED
      ? `VERIFIED at ${pct(confidence)} confidence: the merged solution cleared the ${CONFIDENCE_THRESHOLD} gate.`
      : verdict === ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE
        ? `INSUFFICIENT_CONFIDENCE at ${pct(confidence)}: below the ${CONFIDENCE_THRESHOLD} gate. The output is returned with caveats.`
        : verdict === ORACLE_VERDICT.REJECTED
          ? "REJECTED: the Trial convicted the merge beyond repair."
          : "ABORTED: a stage was skipped or unreadable, so no verdict could be reached.";

  return {
    title: `Tribunal Battle Report (${domain})`,
    summary,
    rounds,
    winner: buildWinner(mergeReport, verdict),
    total_findings: totalFindings,
    resolved_findings: resolvedFindings,
    unresolved_critical: unresolvedCritical,
  };
}

function buildCaveats({ confidence, verdict, validationChecks, breakdown }) {
  const caveats = [];
  if (verdict === ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE) {
    caveats.push(
      `Confidence ${pct(confidence)} is below the ${CONFIDENCE_THRESHOLD} "Perfect or Nothing" threshold.`,
    );
  }
  for (const check of validationChecks) {
    if (check.passed !== true) caveats.push(`Validation check failed: ${check.name} — ${check.details}`);
  }
  const labels = {
    self_review_score: "self-review",
    survival_score: "crucible survival",
    merge_quality_score: "merge quality",
    trial_score: "trial",
    validation_score: "validation",
  };
  for (const [key, label] of Object.entries(labels)) {
    const score = breakdown?.[key];
    if (typeof score === "number" && score < 1) {
      caveats.push(`The ${label} component of confidence scored ${score.toFixed(2)} (max 1.00).`);
    }
  }
  if (caveats.length === 0) {
    caveats.push("No caveats recorded.");
  }
  return caveats;
}

function extractHybridContent(mergeReport) {
  const content = mergeReport?.hybrid_solution?.content;
  return isNonEmptyString(content) ? content : null;
}

// ---------------------------------------------------------------------------
// 2.4 The engine
// ---------------------------------------------------------------------------

/**
 * Decide why the run cannot produce a confidence verdict, if it cannot.
 * @returns {string|null} a reason, or null if the run is judgeable.
 */
function abortReason({ stage3Result, stage4Result, mergeReport }) {
  if (!isPlainObject(stage3Result)) return "Stage 3 (Merge) produced no result.";
  if (stage3Result.status === "SKIPPED") {
    return `Stage 3 (Merge) was skipped: ${stage3Result.reason ?? "no viable proposals"}.`;
  }
  if (stage3Result.status === "INVALID_RESULT") return "Stage 3 (Merge) produced no readable report.";
  if (!mergeReport) return "Stage 3 (Merge) produced no merge report.";
  if (!isPlainObject(mergeReport.hybrid_solution)) return "The merge produced no hybrid solution to validate.";
  if (!isPlainObject(stage4Result)) return "Stage 4 (Trial) produced no result.";
  if (stage4Result.status === "SKIPPED") return "Stage 4 (Trial) was skipped: there was no merge to try.";
  if (stage4Result.status === "MISTRIAL") return "Stage 4 (Trial) ended in a mistrial: the prosecutor's output was unreadable.";
  return null;
}

function terminalReport({ schemaVersion, verdict, reason, stage1Result, stage2Result, stage3Result, stage4Result, mergeReport, trialReport, crucibleFindings, domain }) {
  const validationChecks = mergeReport
    ? runValidationChecks({ mergeReport, trialReport, domain, options: { crucibleFindings, finalTrialVerdict: finalVerdictOf(stage4Result) } })
    : [];
  const { breakdown } = computeConfidence({ stage1Result, stage2Result, stage3Result, stage4Result, validationChecks });
  const battleReport = generateBattleReport({
    stage1Result,
    stage2Result,
    stage3Result,
    stage4Result,
    confidence: 0,
    verdict,
    domain,
  });
  return redactDeep({
    schema_version: schemaVersion,
    verdict,
    confidence: 0,
    confidence_breakdown: breakdown,
    validation_checks: validationChecks,
    battle_report: battleReport,
    final_output: null,
    caveats: [reason],
  });
}

/**
 * Run the Oracle. Never throws: a missing stage or a garbled input becomes an
 * ABORTED (or REJECTED) report rather than an exception.
 *
 * @param {object} input
 * @param {object} [input.stage1Result]  runSelfAdversarialStage() result
 * @param {object} [input.stage2Result]  runCrucibleStage() result
 * @param {object} [input.stage3Result]  runMergeStage() result
 * @param {object} [input.stage4Result]  runTrialStage()/runTrialWithRetry() result
 * @param {string} [input.domain]
 * @param {object} [input.options]
 * @param {Array}  [input.options.crucibleFindings]
 * @returns {object} a schema-valid Oracle report
 */
export function runOracle({ stage1Result, stage2Result, stage3Result, stage4Result, domain = "general", options = {} } = {}) {
  try {
    const mergeReport = mergeReportOf(stage3Result);
    const trialReport = trialReportOf(stage4Result);
    const crucibleFindings = crucibleFindingsFor(stage2Result, stage3Result, options);
    const finalVerdict = finalVerdictOf(stage4Result);

    const reason = abortReason({ stage3Result, stage4Result, mergeReport });
    if (reason) {
      return terminalReport({
        schemaVersion: ORACLE_SCHEMA_VERSION,
        verdict: ORACLE_VERDICT.ABORTED,
        reason,
        stage1Result,
        stage2Result,
        stage3Result,
        stage4Result,
        mergeReport,
        trialReport,
        crucibleFindings,
        domain,
      });
    }

    if (finalVerdict === TRIAL_VERDICT.CONVICTED_FINAL) {
      return terminalReport({
        schemaVersion: ORACLE_SCHEMA_VERSION,
        verdict: ORACLE_VERDICT.REJECTED,
        reason: "The Trial convicted the merge beyond repair (CONVICTED_FINAL).",
        stage1Result,
        stage2Result,
        stage3Result,
        stage4Result,
        mergeReport,
        trialReport,
        crucibleFindings,
        domain,
      });
    }

    const validationChecks = runValidationChecks({
      mergeReport,
      trialReport,
      domain,
      options: { crucibleFindings, finalTrialVerdict: finalVerdict },
    });
    const { confidence, breakdown } = computeConfidence({
      stage1Result,
      stage2Result,
      stage3Result,
      stage4Result,
      validationChecks,
    });

    const verdict = confidence >= CONFIDENCE_THRESHOLD ? ORACLE_VERDICT.VERIFIED : ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE;
    const battleReport = generateBattleReport({
      stage1Result,
      stage2Result,
      stage3Result,
      stage4Result,
      confidence,
      verdict,
      domain,
    });
    const finalOutput = extractHybridContent(mergeReport);
    const caveats = verdict === ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE ? buildCaveats({ confidence, verdict, validationChecks, breakdown }) : [];

    return redactDeep({
      schema_version: ORACLE_SCHEMA_VERSION,
      verdict,
      confidence,
      confidence_breakdown: breakdown,
      validation_checks: validationChecks,
      battle_report: battleReport,
      final_output: finalOutput,
      caveats,
    });
  } catch (err) {
    // The engine is meant never to throw; if the unexpected happens, degrade to a
    // well-formed ABORTED report rather than letting the exception escape.
    return {
      schema_version: ORACLE_SCHEMA_VERSION,
      verdict: ORACLE_VERDICT.ABORTED,
      confidence: 0,
      confidence_breakdown: {
        self_review_score: 0,
        survival_score: 0,
        merge_quality_score: 0,
        trial_score: 0,
        validation_score: 0,
        weights: { ...CONFIDENCE_WEIGHTS },
      },
      validation_checks: [],
      battle_report: {
        title: `Tribunal Battle Report (${domain})`,
        summary: `ABORTED: the Oracle failed with ${err?.message || err}.`,
        rounds: [{ round_number: 1, stage: BATTLE_STAGES.ORACLE, events: ["The Oracle could not complete."] }],
        winner: null,
        total_findings: { p0: 0, p1: 0, p2: 0, p3: 0 },
        resolved_findings: 0,
        unresolved_critical: 0,
      },
      final_output: null,
      caveats: [`Oracle error: ${err?.message || err}`],
    };
  }
}

export default {
  VALIDATION_CHECK,
  computeConfidence,
  runValidationChecks,
  generateBattleReport,
  runOracle,
};
