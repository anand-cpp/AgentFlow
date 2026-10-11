// Stage 5 entry point -- and the full tribunal pipeline.
//
// Two things live here. runOracleStage is the thin wrapper the pipeline calls:
// it hands the four prior stage results to runOracle() and reports whether the
// Oracle completed or erroring out. runFullTribunal is the whole five-stage
// pipeline in one function: Forge, Crucible, Merge, Trial, Oracle, chained by
// the same thin orchestration the earlier stages already expose.
//
// The pipeline is deliberately tolerant of early termination. Every stage it
// calls already accepts a missing or skipped input and degrades cleanly, so
// there is no branching cascade here -- a crucible that kills every proposal
// makes the merge skip, the trial skip, and the oracle abort, and the caller
// still gets one complete record with the reason attached.

import { randomUUID } from "node:crypto";

import { runSelfAdversarialStage } from "./stage.js";
import { runCrucibleStage } from "./stage-crucible.js";
import { runMergeStage } from "./stage-merge.js";
import { runTrialStage } from "./stage-trial.js";
import { runOracle } from "./oracle.js";

/** The stage's name, as it appears in a pipeline description or a result. */
export const ORACLE_STAGE = "ORACLE";

export const ORACLE_STAGE_STATUS = {
  COMPLETED: "COMPLETED",
  ERROR: "ERROR",
};

function newTribunalId() {
  try {
    return randomUUID();
  } catch {
    return `tribunal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Run the Oracle over the collected stage results.
 *
 * @param {object} input
 * @param {object} input.allStageResults  { stage1, stage2, stage3, stage4 }
 * @param {string} [input.domain]
 * @param {object} [input.options]
 * @returns {Promise<{ stage: string, status: string, oracleResult?: object, error?: string, completedAt: string }>}
 */
export async function runOracleStage({ allStageResults = {}, domain = "general", options = {} } = {}) {
  const completedAt = options.completedAt ?? new Date().toISOString();
  try {
    const oracleResult = runOracle({
      stage1Result: allStageResults?.stage1,
      stage2Result: allStageResults?.stage2,
      stage3Result: allStageResults?.stage3,
      stage4Result: allStageResults?.stage4,
      domain,
      options,
    });
    return { stage: ORACLE_STAGE, status: ORACLE_STAGE_STATUS.COMPLETED, oracleResult, completedAt };
  } catch (err) {
    // runOracle is written not to throw; this is the last line of defence so a
    // pipeline caller never has to wrap the stage in its own try/catch.
    return { stage: ORACLE_STAGE, status: ORACLE_STAGE_STATUS.ERROR, error: err?.message || String(err), completedAt };
  }
}

/**
 * Run the complete five-stage tribunal.
 *
 * @param {object} input
 * @param {Array}    [input.proposals]  candidate proposals ({ id, model, approach, ... })
 * @param {Function} input.completeFn   gateway complete(config, modelId, prompt, opts)
 * @param {string}   [input.modelId]    advisor/attacker/synthesizer/prosecutor model
 * @param {string}   [input.domain]     code | architecture | idea | plan | logic
 * @param {object}   [input.options]    { maxRevisions, vectors, minSurvivalScore, maxRetries, config, opts, completedAt, tribunal_id }
 * @returns {Promise<{
 *   tribunal_id: string,
 *   domain: string,
 *   startedAt: string,
 *   completedAt: string,
 *   stages: { stage1: object|null, stage2: object|null, stage3: object|null, stage4: object|null, stage5: object|null },
 *   oracle: object|null,
 *   battle_report: object|null,
 * }>}
 */
export async function runFullTribunal({ proposals = [], completeFn, modelId = null, domain = "code", options = {} } = {}) {
  const startedAt = options.completedAt ?? new Date().toISOString();
  const tribunalId = options.tribunal_id ?? newTribunalId();
  const list = Array.isArray(proposals) ? proposals : [];
  const config = options.config ?? null;
  const opts = options.opts ?? {};

  // The Forge keys each review off the candidate's own `model`; when a caller
  // hands a single pipeline-level modelId, stamp it onto candidates that lack one
  // so the stage is runnable in a single-model configuration.
  const stage1Candidates = list.map((proposal) => (proposal && proposal.model ? proposal : { ...(proposal ?? {}), model: modelId }));

  let stage1 = null;
  let stage2 = null;
  let stage3 = null;
  let stage4 = null;
  let stage5 = null;

  try {
    stage1 = await runSelfAdversarialStage({
      candidates: stage1Candidates,
      complete: completeFn,
      config,
      maxRevisions: options.maxRevisions ?? 1,
      opts,
    });

    stage2 = await runCrucibleStage({
      proposals: list,
      completeFn,
      options: { domain, modelId, config, opts, vectors: options.vectors, completedAt: options.completedAt },
    });

    stage3 = await runMergeStage({
      proposals: list,
      crucibleStageResult: stage2,
      completeFn,
      modelId,
      options: { domain, modelId, config, opts, minSurvivalScore: options.minSurvivalScore, completedAt: options.completedAt },
    });

    stage4 = await runTrialStage({
      mergeStageResult: stage3,
      crucibleStageResult: stage2,
      originalProposals: list,
      completeFn,
      modelId,
      options: { domain, modelId, config, opts, maxRetries: options.maxRetries, completedAt: options.completedAt },
    });

    stage5 = await runOracleStage({
      allStageResults: { stage1, stage2, stage3, stage4 },
      domain,
      options: { crucibleFindings: stage3?.criticalFindings, completedAt: options.completedAt },
    });
  } catch (err) {
    // One complete ABORTED record beats a partial throw: whatever ran is kept,
    // and the Oracle result explains the failure.
    const oracleResult = runOracle({ domain });
    stage5 = { stage: ORACLE_STAGE, status: ORACLE_STAGE_STATUS.ERROR, error: err?.message || String(err), oracleResult, completedAt: new Date().toISOString() };
  }

  const completedAt = options.completedAt ?? new Date().toISOString();

  return {
    tribunal_id: tribunalId,
    domain,
    startedAt,
    completedAt,
    stages: { stage1, stage2, stage3, stage4, stage5 },
    oracle: stage5?.oracleResult ?? null,
    battle_report: stage5?.oracleResult?.battle_report ?? null,
  };
}

export default { ORACLE_STAGE, ORACLE_STAGE_STATUS, runOracleStage, runFullTribunal };
