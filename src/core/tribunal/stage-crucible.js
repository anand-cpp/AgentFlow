// Stage 3 entry point -- running the Crucible over a set of surviving proposals.
//
// This is the thin orchestration layer the pipeline calls. It owns no attack
// logic of its own: it fans each proposal out to runCrossExamination(), folds
// the returned reports through aggregateCrucibleFindings(), and returns one
// result per proposal with a stage summary. Keeping it thin is deliberate -- the
// attack semantics live in crucible.js and crucible-schema.js, where they are
// tested directly, and this file is only the "run it for every candidate" loop.

import { CRUCIBLE_ATTACK_SCHEMA, ATTACK_VECTOR_SPECS } from "./crucible-schema.js";
import { aggregateCrucibleFindings, runCrossExamination } from "./crucible.js";

/** The stage's name, as it appears in a pipeline description or a result. */
export const CRUCIBLE_STAGE = "CRUCIBLE";

function proposalIdOf(proposal) {
  return proposal?.id ?? proposal?.proposalId ?? null;
}

/**
 * Cross-examine every proposal and aggregate the results.
 *
 * @param {object} input
 * @param {Array}    [input.proposals]  proposals that survived Stage 1
 * @param {Function} input.completeFn   gateway complete(config, modelId, prompt, opts)
 * @param {object}   [input.options]
 * @param {string[]} [input.options.vectors]  vectors to run per proposal; default all four
 * @param {string}   [input.options.modelId]  attacker model
 * @param {object}   [input.options.config]   passed through to completeFn
 * @param {string}   [input.options.domain]   code | architecture | idea | plan | logic
 * @param {object}   [input.options.opts]     per-call options for completeFn
 * @param {string}   [input.options.completedAt]  override the completion timestamp
 * @returns {Promise<{
 *   stage: string,
 *   results: Array<{
 *     proposalId: string|null, reports: object[], invalid: object[],
 *     aggregatedFindings: object[], counts: object, survivalScore: number,
 *   }>,
 *   summary: { total: number, attacked: number, reports: number, invalid: number, findings: number, averageSurvival: number },
 *   completedAt: string,
 * }>}
 */
export async function runCrucibleStage({ proposals = [], completeFn, options = {} } = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  const vectors =
    Array.isArray(options.vectors) && options.vectors.length > 0
      ? options.vectors
      : CRUCIBLE_ATTACK_SCHEMA.vectors;
  const domain = options.domain ?? "code";

  const results = [];
  let reportCount = 0;
  let invalidCount = 0;
  let findingCount = 0;
  let survivalSum = 0;

  for (const proposal of list) {
    const { reports, invalid } = await runCrossExamination({
      proposal,
      completeFn,
      vectors,
      modelId: options.modelId ?? null,
      config: options.config ?? null,
      domain,
      opts: options.opts ?? {},
    });

    const { findings, counts, survivalScore } = aggregateCrucibleFindings(reports);

    reportCount += reports.length;
    invalidCount += invalid.length;
    findingCount += findings.length;
    survivalSum += survivalScore;

    results.push({
      proposalId: proposalIdOf(proposal),
      reports,
      invalid,
      aggregatedFindings: findings,
      counts,
      survivalScore,
    });
  }

  return {
    stage: CRUCIBLE_STAGE,
    results,
    summary: {
      total: results.length,
      attacked: reportCount,
      reports: reportCount,
      invalid: invalidCount,
      findings: findingCount,
      averageSurvival: results.length > 0 ? survivalSum / results.length : 0,
    },
    completedAt: options.completedAt ?? new Date().toISOString(),
  };
}

/** The vectors this stage runs by default, exposed for callers that describe it. */
export const DEFAULT_CRUCIBLE_VECTORS = CRUCIBLE_ATTACK_SCHEMA.vectors;

export { ATTACK_VECTOR_SPECS };

export default { CRUCIBLE_STAGE, DEFAULT_CRUCIBLE_VECTORS, runCrucibleStage };
