// Stage 4 entry point -- running the Trial over the merge, with a bounded retry.
//
// Thin orchestration, like the other stages. runTrialStage runs one prosecution
// of the merge and reports SKIPPED / COMPLETED / MISTRIAL. runTrialWithRetry
// runs the loop the pipeline actually wants: try, and if convicted with budget
// left, re-merge on the trial's findings and try again.
//
// The loop is bounded by maxRetries and, by design, does not require a re-merge
// function. If none is wired, it runs the first trial and returns the retry
// recommendation -- the re-merge integration is deferred to the CLI wiring
// phase. That limitation is stated on the result (`note`) rather than hidden.

import { extractCriticalFindings } from "./merge.js";
import { MERGE_STAGE_STATUS } from "./stage-merge.js";
import { DEFAULT_MAX_RETRIES, MISTRIAL, classifyTrialOutcome, runTrial } from "./trial.js";
import { TRIAL_VERDICT } from "./trial-schema.js";

/** The stage's name, as it appears in a pipeline description or a result. */
export const TRIAL_STAGE = "TRIAL";

export const TRIAL_STAGE_STATUS = {
  SKIPPED: "SKIPPED",
  COMPLETED: "COMPLETED",
  MISTRIAL: "MISTRIAL",
};

/**
 * Pull the merge report out of whatever shape a caller hands us: a merge stage
 * result (COMPLETED), a bare merge report, or a nested object. Returns null when
 * there is nothing to try.
 */
function mergeReportOf(mergeStageResult) {
  if (!mergeStageResult || typeof mergeStageResult !== "object") return null;
  const nested = mergeStageResult.result?.report ?? mergeStageResult.report;
  if (nested && typeof nested === "object") return nested;
  if (mergeStageResult.hybrid_solution || mergeStageResult.decision) return mergeStageResult;
  return null;
}

/** A merge is tryable only if it completed and carries a report. */
function isTryable(mergeStageResult) {
  if (!mergeStageResult || typeof mergeStageResult !== "object") return false;
  const status = mergeStageResult.status;
  if (status === MERGE_STAGE_STATUS.SKIPPED || status === MERGE_STAGE_STATUS.INVALID_RESULT) return false;
  return mergeReportOf(mergeStageResult) !== null;
}

function criticalFindingsFor(mergeStageResult, crucibleStageResult) {
  if (crucibleStageResult) return extractCriticalFindings(crucibleStageResult);
  return Array.isArray(mergeStageResult?.criticalFindings) ? mergeStageResult.criticalFindings : [];
}

/**
 * Prosecute the merge once and classify the outcome.
 *
 * @param {object} input
 * @param {object}   [input.mergeStageResult]     the object runMergeStage() returned
 * @param {object}   [input.crucibleStageResult] the object runCrucibleStage() returned
 * @param {Array}    [input.originalProposals]   proposals the merge drew from
 * @param {Function} [input.completeFn]
 * @param {string}   [input.modelId]
 * @param {object}   [input.options]             { maxRetries, domain, config, opts, iteration, completedAt }
 * @returns {Promise<object>}
 */
export async function runTrialStage({
  mergeStageResult,
  crucibleStageResult,
  originalProposals = [],
  completeFn,
  modelId = null,
  options = {},
} = {}) {
  const completedAt = options.completedAt ?? new Date().toISOString();
  const maxRetries = typeof options.maxRetries === "number" ? options.maxRetries : DEFAULT_MAX_RETRIES;

  if (!isTryable(mergeStageResult)) {
    return {
      stage: TRIAL_STAGE,
      status: TRIAL_STAGE_STATUS.SKIPPED,
      reason: "No merge to try",
      modelId,
      elapsed_ms: 0,
      iterationsUsed: 0,
      completedAt,
    };
  }

  const mergeReport = mergeReportOf(mergeStageResult);
  const crucibleFindings = criticalFindingsFor(mergeStageResult, crucibleStageResult);

  const trialResult = await runTrial({
    mergeReport,
    crucibleFindings,
    originalProposals,
    completeFn,
    modelId,
    options,
  });

  if (trialResult.status === MISTRIAL) {
    return {
      stage: TRIAL_STAGE,
      status: TRIAL_STAGE_STATUS.MISTRIAL,
      trialResult,
      modelId,
      elapsed_ms: trialResult.elapsed_ms,
      iterationsUsed: 0,
      completedAt,
    };
  }

  const iteration = typeof options.iteration === "number" ? options.iteration : 0;
  const outcome = classifyTrialOutcome(trialResult.report, iteration, maxRetries);

  return {
    stage: TRIAL_STAGE,
    status: TRIAL_STAGE_STATUS.COMPLETED,
    trialResult,
    outcome,
    iteration,
    modelId,
    elapsed_ms: trialResult.elapsed_ms,
    iterationsUsed: 1,
    completedAt,
  };
}

/**
 * Run the Trial in a retry loop against a re-merge function.
 *
 * Behaviour:
 *   * ACQUITTED or CONVICTED_FINAL ends the loop immediately.
 *   * CONVICTED_RETRY with a `mergeFn` provided calls it to produce a new merge,
 *     then tries again; it repeats until the budget is spent.
 *   * CONVICTED_RETRY with NO `mergeFn` returns the retry recommendation after
 *     the first trial -- the re-merge wiring is deferred, and the result says so
 *     in `note`.
 *
 * `mergeFn(context)` receives `{ mergeStageResult, trialResult, findings, focus,
 * iteration, options }` and must return a tryable merge (a merge stage result,
 * or a bare merge report).
 *
 * @param {object} input
 * @param {object}   [input.mergeStageResult]     the object runMergeStage() returned
 * @param {object}   [input.crucibleStageResult] the object runCrucibleStage() returned
 * @param {Array}    [input.originalProposals]   proposals the merge drew from
 * @param {Function} [input.completeFn]
 * @param {Function} [input.mergeFn]
 * @param {string}   [input.modelId]
 * @param {object}   [input.options]             { maxRetries, domain, config, opts, iteration, completedAt }
 * @returns {Promise<{
 *   stage: string,
 *   finalVerdict: string,
 *   finalMerge: object|null,
 *   finalTrial: object|null,
 *   history: Array<object>,
 *   iterationsUsed: number,
 *   completedAt: string,
 *   modelId: string|null,
 *   note?: string,
 *   exhaustedBudget?: boolean,
 * }>}
 */
export async function runTrialWithRetry({
  mergeStageResult,
  crucibleStageResult,
  originalProposals = [],
  completeFn,
  mergeFn,
  modelId = null,
  options = {},
} = {}) {
  const completedAt = options.completedAt ?? new Date().toISOString();
  const maxRetries = typeof options.maxRetries === "number" ? options.maxRetries : DEFAULT_MAX_RETRIES;
  const crucibleFindings = criticalFindingsFor(mergeStageResult, crucibleStageResult);
  const history = [];

  const finish = (finalVerdict, extra = {}) => ({
    stage: TRIAL_STAGE,
    finalVerdict,
    finalMerge: extra.finalMerge ?? null,
    finalTrial: extra.finalTrial ?? null,
    history,
    iterationsUsed: history.length,
    completedAt,
    modelId,
    ...(extra.note ? { note: extra.note } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
  });

  if (!isTryable(mergeStageResult)) {
    return finish(TRIAL_STAGE_STATUS.SKIPPED, { finalMerge: mergeStageResult ?? null, reason: "No merge to try" });
  }

  let currentMerge = mergeStageResult;

  for (let iteration = 0; iteration <= maxRetries; iteration += 1) {
    const mergeReport = mergeReportOf(currentMerge);
    const trialResult = await runTrial({
      mergeReport,
      crucibleFindings,
      originalProposals,
      completeFn,
      modelId,
      options,
    });

    if (trialResult.status === MISTRIAL) {
      history.push({ iteration, verdict: TRIAL_VERDICT.MISTRIAL, mergeStatus: currentMerge?.status ?? null, trialResult, outcome: null });
      return finish(TRIAL_VERDICT.MISTRIAL, { finalMerge: currentMerge, finalTrial: trialResult });
    }

    const outcome = classifyTrialOutcome(trialResult.report, iteration, maxRetries);
    history.push({ iteration, verdict: outcome.verdict, mergeStatus: currentMerge?.status ?? "COMPLETED", trialResult, outcome });

    if (outcome.verdict === TRIAL_VERDICT.ACQUITTED || outcome.verdict === TRIAL_VERDICT.CONVICTED_FINAL) {
      return finish(outcome.verdict, { finalMerge: currentMerge, finalTrial: trialResult });
    }

    // CONVICTED_RETRY. Without a re-merge function we stop and hand back the
    // recommendation; the loop is not spun on a merge we cannot change.
    if (typeof mergeFn !== "function") {
      return finish(TRIAL_VERDICT.CONVICTED_RETRY, {
        finalMerge: currentMerge,
        finalTrial: trialResult,
        note: "Re-merge not wired: returning the retry recommendation after the first trial.",
      });
    }

    const remerged = await mergeFn({
      mergeStageResult: currentMerge,
      trialResult,
      findings: outcome.criticalFindings,
      focus: outcome.focus ?? null,
      iteration,
      options,
    });

    if (!remerged || mergeReportOf(remerged) === null) {
      return finish(TRIAL_VERDICT.CONVICTED_RETRY, {
        finalMerge: currentMerge,
        finalTrial: trialResult,
        note: "Re-merge produced no usable report: stopping with the retry recommendation.",
      });
    }

    currentMerge = remerged;
  }

  // Unreachable in practice: iteration === maxRetries returns CONVICTED_FINAL
  // above. Kept as a safe floor so the function always resolves a verdict.
  return {
    ...finish(TRIAL_VERDICT.CONVICTED_FINAL, { finalMerge: currentMerge, finalTrial: history.at(-1)?.trialResult ?? null }),
    exhaustedBudget: true,
  };
}

export default { TRIAL_STAGE, TRIAL_STAGE_STATUS, runTrialStage, runTrialWithRetry };
