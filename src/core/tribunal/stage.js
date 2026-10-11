// Self-adversarial stage: run self-review over candidates, bounded.
//
// This is the orchestration the rest of the tribunal sits on top of. It takes
// candidate proposals that a caller has already produced, hands each to its own
// model for a hostile review, and -- when the review says REVISE and offers a
// revised approach -- feeds the revision back for another review.
//
// Three properties matter and are enforced here, not by prompt wording:
//
//   * No candidate skips review. The loop calls runSelfReview for every
//     candidate before it can be reported; there is no "looks fine" fast path
//     for a model that trusts itself.
//   * Revision is bounded. A reviewer that keeps finding *something* cannot
//     spin forever; maxRevisions caps the debate and the limit is reported
//     rather than hidden.
//   * A malformed review is a first-class outcome. If the model returns
//     garbage, the candidate is reported as INVALID_REVIEW with the errors
//     intact -- never silently passed through as if it had been reviewed.
//
// This stage makes no provider calls itself and writes nothing. Persistence,
// events, and cross-model examination are later milestones.

import { REVIEW_DECISION, classifyFindings } from "./review-schema.js";
import { assessDowngrade } from "./confidence.js";
import { runSelfReview } from "./self-review.js";

export const STAGE_OUTCOME = {
  REVIEWED: "reviewed",
  INVALID_REVIEW: "invalid_review",
  REVISION_LIMIT: "revision_limit",
};

/**
 * Review a list of candidates.
 *
 * @param {object} input
 * @param {Array}  input.candidates   [{ id, model, approach, rationale, ... }]
 * @param {Function} input.complete   gateway complete()
 * @param {object} [input.config]     passed through to complete
 * @param {number} [input.maxRevisions=1]  how many REVISE rounds a candidate may take
 * @param {object} [input.opts]       { timeoutMs, maxTokens, temperature, system }
 */
export async function runSelfAdversarialStage({
  candidates = [],
  complete,
  config = null,
  maxRevisions = 1,
  opts = {},
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const results = [];

  for (let index = 0; index < list.length; index += 1) {
    results.push(
      await reviewCandidate({ candidate: list[index], index, complete, config, maxRevisions, opts }),
    );
  }

  const summary = {
    total: results.length,
    reviewed: results.filter((r) => r.outcome === STAGE_OUTCOME.REVIEWED).length,
    invalid: results.filter((r) => r.outcome === STAGE_OUTCOME.INVALID_REVIEW).length,
    limited: results.filter((r) => r.outcome === STAGE_OUTCOME.REVISION_LIMIT).length,
    revised: results.reduce((n, r) => n + Math.max(0, r.iterations - 1), 0),
  };

  return { candidates: results, summary };
}

async function reviewCandidate({ candidate, index, complete, config, maxRevisions, opts }) {
  const id = candidate?.id ?? `candidate-${index + 1}`;
  const modelId = candidate?.model ?? null;
  const traces = [];
  let current = candidate;
  let limitReached = false;
  let last = null;

  for (let revision = 0; revision <= maxRevisions; revision += 1) {
    const result = await runSelfReview({ complete, config, modelId, candidate: current, opts });

    if (!result.ok) {
      traces.push({ revision, ok: false, errors: result.errors });
      return {
        id,
        model: modelId,
        ok: false,
        outcome: STAGE_OUTCOME.INVALID_REVIEW,
        iterations: revision + 1,
        review: null,
        classification: null,
        assessment: null,
        decision: null,
        traces,
      };
    }

    const review = result.review;
    const classification = classifyFindings(review);
    const assessment = assessDowngrade({
      before: review.confidenceBefore,
      after: review.confidenceAfter,
      findings: review.failureHypotheses,
      tests: review.proposedTests,
      decision: review.decision,
      justification: review.confidenceJustification,
    });

    traces.push({
      revision,
      ok: true,
      decision: review.decision,
      verdict: assessment.verdict,
      reproduced: classification.reproduced.length,
    });
    last = { review, classification, assessment };

    const wantsRevision = review.decision === REVIEW_DECISION.REVISE && typeof review.revisedApproach === "string";
    if (wantsRevision) {
      if (revision < maxRevisions) {
        // Re-review the revised approach under the same id. The next loop
        // iteration hands the new approach back through runSelfReview.
        current = { ...current, approach: review.revisedApproach };
        continue;
      }
      limitReached = true;
    }
    break;
  }

  return {
    id,
    model: modelId,
    ok: true,
    outcome: limitReached ? STAGE_OUTCOME.REVISION_LIMIT : STAGE_OUTCOME.REVIEWED,
    iterations: traces.length,
    review: last?.review ?? null,
    classification: last?.classification ?? null,
    assessment: last?.assessment ?? null,
    decision: last?.review?.decision ?? null,
    traces,
  };
}

export default { STAGE_OUTCOME, runSelfAdversarialStage };
