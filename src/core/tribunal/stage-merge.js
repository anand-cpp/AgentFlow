// Stage 3 entry point -- running the Merge over the Crucible's survivors.
//
// Thin orchestration, like stage-crucible.js. It owns no synthesis logic of its
// own; it reads the survival gate, extracts the critical findings the merge must
// account for, calls runMerge once, and reports one of three outcomes:
//
//   SKIPPED        every proposal was too flawed to build on -- no model call.
//   COMPLETED      a schema-valid merge report came back.
//   INVALID_RESULT the synthesizer's output could not be read; the raw response
//                  is preserved so a human can see what it actually said.
//
// The status is a first-class result, not an error, because "we chose not to
// merge" and "we could not read the merge" are different facts a pipeline needs
// to distinguish and record.

import {
  INVALID_MERGE,
  extractCriticalFindings,
  runMerge,
  shouldAttemptMerge,
} from "./merge.js";

/** The stage's name, as it appears in a pipeline description or a result. */
export const MERGE_STAGE = "MERGE";

export const MERGE_STAGE_STATUS = {
  SKIPPED: "SKIPPED",
  COMPLETED: "COMPLETED",
  INVALID_RESULT: "INVALID_RESULT",
};

/**
 * Decide whether to merge, then do it.
 *
 * @param {object} input
 * @param {Array}    [input.proposals]          surviving proposals
 * @param {object}   input.crucibleStageResult  the object runCrucibleStage() returned
 * @param {Function} input.completeFn           gateway complete(config, modelId, prompt, opts)
 * @param {string}   [input.modelId]
 * @param {object}   [input.options]            { minSurvivalScore, domain, config, opts, completedAt }
 * @returns {Promise<object>} one of the three stage outcomes, each carrying `stage`, `status`, `gate`, `modelId`, `elapsed_ms`, `completedAt`
 */
export async function runMergeStage({
  proposals = [],
  crucibleStageResult,
  completeFn,
  modelId = null,
  options = {},
} = {}) {
  const completedAt = options.completedAt ?? new Date().toISOString();
  const gate = shouldAttemptMerge(crucibleStageResult, options);

  if (!gate.attempt) {
    return {
      stage: MERGE_STAGE,
      status: MERGE_STAGE_STATUS.SKIPPED,
      reason: gate.reason,
      gate,
      criticalFindings: [],
      modelId,
      elapsed_ms: 0,
      completedAt,
    };
  }

  const criticalFindings = extractCriticalFindings(crucibleStageResult);
  const result = await runMerge({
    proposals,
    crucibleFindings: criticalFindings,
    completeFn,
    modelId,
    options,
  });

  if (result.status === INVALID_MERGE) {
    return {
      stage: MERGE_STAGE,
      status: MERGE_STAGE_STATUS.INVALID_RESULT,
      rawResponse: result.rawResponse,
      errors: result.errors,
      gate,
      criticalFindings,
      modelId,
      elapsed_ms: result.elapsed_ms,
      completedAt,
    };
  }

  return {
    stage: MERGE_STAGE,
    status: MERGE_STAGE_STATUS.COMPLETED,
    result,
    gate,
    criticalFindings,
    modelId,
    elapsed_ms: result.elapsed_ms,
    completedAt,
  };
}

export default { MERGE_STAGE, MERGE_STAGE_STATUS, runMergeStage };
