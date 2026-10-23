// The Arena rubric: what a match is judged on, and how the numbers combine.
//
// A bracket is only as trustworthy as its scoring contract. This module owns
// that contract so the judge prompt, the validator, the decision, and the
// report cannot disagree about what "86.5" means:
//
//   * five criteria, each scored 0-10;
//   * fixed weights that sum to exactly 1.0;
//   * weighted score in 0-10, published total in 0-100;
//   * totals within TIE_EPSILON are a tie, which the judge module resolves by
//     an explicit ladder rather than by float comparison.
//
// The weights are deliberately not configurable per run in v1. A rubric that
// changes between rounds makes round 1 and round 4 incomparable, and a
// tournament whose final score depends on which weights happened to be loaded
// is not a tournament. `validateWeights()` exists so a future version can add
// a named rubric without weakening this check.

export const RUBRIC_VERSION = 1;

/**
 * Two totals closer than this are level. 0.05 of a 100-point scale is well
 * below anything a judge can defend as a meaningful difference, and it keeps
 * 84.99999999 from beating 85.0 on floating-point noise.
 */
export const TIE_EPSILON = 0.05;

/** A score at or below this is a serious defect and needs evidence. */
export const SERIOUS_DEFECT_SCORE = 3;

export const CRITERIA = Object.freeze([
  {
    id: "correctness",
    name: "Correctness",
    weight: 0.3,
    question:
      "Is it right? No false claims, no logic errors, no bugs, nothing that would mislead someone who acts on it.",
    anchors: [
      { score: 10, meaning: "Nothing wrong found after checking; claims match evidence." },
      { score: 7, meaning: "Works for the stated case, with a minor imprecision that does not change the outcome." },
      { score: 4, meaning: "Materially incomplete or wrong in a way that needs correction before use." },
      { score: 0, meaning: "Fundamentally wrong, or the central claim is unsupported." },
    ],
  },
  {
    id: "completeness",
    name: "Completeness",
    weight: 0.25,
    question:
      "Does it meet every requirement the task states? Judged against the task text, not against what the judge would have liked.",
    anchors: [
      { score: 10, meaning: "Every stated requirement is addressed, including edge conditions the task names." },
      { score: 7, meaning: "All primary requirements addressed; one secondary detail is missing." },
      { score: 4, meaning: "A stated requirement is missing or only gestured at." },
      { score: 0, meaning: "Most of the task is unaddressed." },
    ],
  },
  {
    id: "robustness",
    name: "Robustness",
    weight: 0.2,
    question:
      "Does it hold up against the attacks raised in this match, including malformed input, failure paths, and concurrency?",
    anchors: [
      { score: 10, meaning: "Every material attack is fixed or correctly rebutted with evidence." },
      { score: 7, meaning: "Attacks are addressed; one low-severity objection remains open." },
      { score: 4, meaning: "A material objection stands and the revision does not resolve it." },
      { score: 0, meaning: "The solution fails under the first realistic counterexample." },
    ],
  },
  {
    id: "specificity",
    name: "Specificity",
    weight: 0.15,
    question:
      "Could someone act on it right now without guessing? Exact files, functions, commands, values, and steps.",
    anchors: [
      { score: 10, meaning: "Names the exact changes and how to verify them." },
      { score: 7, meaning: "Actionable, with one detail left to the implementer." },
      { score: 4, meaning: "Directionally right but too vague to execute without a second round." },
      { score: 0, meaning: "Generic advice that could apply to any task." },
    ],
  },
  {
    id: "clarity",
    name: "Clarity",
    weight: 0.1,
    question:
      "Is it easy to read and use, at a length that fits the task? Verbosity is not a substitute for substance.",
    anchors: [
      { score: 10, meaning: "Structured, direct, no filler; the reader knows what to do next." },
      { score: 7, meaning: "Clear with some redundancy." },
      { score: 4, meaning: "Hard to follow, or padded enough to hide the actual change." },
      { score: 0, meaning: "Unreadable or self-contradictory." },
    ],
  },
]);

/** Weights keyed by criterion id. Kept in sync with CRITERIA by construction. */
export const RUBRIC_WEIGHTS = Object.freeze(
  Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, criterion.weight])),
);

const CRITERION_IDS = Object.freeze(CRITERIA.map((criterion) => criterion.id));
const CRITERION_SET = new Set(CRITERION_IDS);
const WEIGHT_TOLERANCE = 1e-6;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a weight table before it is used to score anything.
 *
 * @param {Record<string, number>} [weights]
 * @returns {{ ok: boolean, errors: string[], total: number }}
 */
export function validateWeights(weights = RUBRIC_WEIGHTS) {
  const errors = [];
  if (!isPlainObject(weights)) {
    return { ok: false, errors: ["weights must be an object"], total: 0 };
  }

  for (const id of CRITERION_IDS) {
    if (!(id in weights)) errors.push(`weights are missing "${id}"`);
  }
  for (const key of Object.keys(weights)) {
    if (!CRITERION_SET.has(key)) errors.push(`unknown weight "${key}"`);
  }

  let total = 0;
  for (const id of CRITERION_IDS) {
    if (!(id in weights)) continue;
    const value = weights[id];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`weight "${id}" must be a finite number`);
      continue;
    }
    if (value <= 0 || value > 1) errors.push(`weight "${id}" must be greater than 0 and at most 1`);
    total += value;
  }

  if (Math.abs(total - 1) > WEIGHT_TOLERANCE) {
    errors.push(`weights must sum to 1.0, got ${Number(total.toFixed(6))}`);
  }

  return { ok: errors.length === 0, errors, total: Number(total.toFixed(6)) };
}

/**
 * Score one candidate. Fail-closed: a missing criterion, a non-number, or a
 * value outside 0-10 is an error, never a zero. Zero is a judgement; missing is
 * a broken judge, and conflating them would let a malformed response silently
 * lose a match.
 *
 * @param {Record<string, number>} scores
 * @param {Record<string, number>} [weights]
 * @returns {{
 *   ok: boolean,
 *   errors: string[],
 *   criteria: Record<string, number>,
 *   weighted: number,
 *   total: number
 * }}
 */
export function scoreCandidate(scores, weights = RUBRIC_WEIGHTS) {
  const weightCheck = validateWeights(weights);
  if (!weightCheck.ok) {
    return { ok: false, errors: weightCheck.errors, criteria: {}, weighted: 0, total: 0 };
  }

  const errors = [];
  if (!isPlainObject(scores)) {
    return { ok: false, errors: ["scores must be an object"], criteria: {}, weighted: 0, total: 0 };
  }

  for (const id of CRITERION_IDS) {
    if (!(id in scores)) errors.push(`scores are missing "${id}"`);
  }
  for (const key of Object.keys(scores)) {
    if (!CRITERION_SET.has(key)) errors.push(`unknown score "${key}"`);
  }

  const criteria = {};
  let weighted = 0;
  for (const id of CRITERION_IDS) {
    if (!(id in scores)) continue;
    const value = scores[id];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`score "${id}" must be a finite number`);
      continue;
    }
    if (value < 0 || value > 10) {
      errors.push(`score "${id}" must be between 0 and 10, got ${value}`);
      continue;
    }
    criteria[id] = value;
    weighted += value * weights[id];
  }

  if (errors.length) {
    return {
      ok: false,
      errors,
      criteria,
      weighted: Number(weighted.toFixed(3)),
      total: Number((weighted * 10).toFixed(1)),
    };
  }

  const rounded = Number(weighted.toFixed(3));
  return {
    ok: true,
    errors: [],
    criteria,
    weighted: rounded,
    total: Number((rounded * 10).toFixed(1)),
  };
}

/**
 * Compare two published totals. Returns 0 when they are level within
 * TIE_EPSILON, otherwise -1/1 like a sort comparator.
 */
export function compareTotals(a, b) {
  if (Math.abs(a - b) < TIE_EPSILON) return 0;
  return a > b ? 1 : -1;
}

/** A compact, prompt-friendly description of the rubric, in weight order. */
export function rubricTable() {
  return CRITERIA.map(
    (criterion) =>
      `- ${criterion.id} (weight ${criterion.weight.toFixed(2)}): ${criterion.question}`,
  ).join("\n");
}

/** Machine-readable rubric metadata for prompts, docs and tests. */
export function rubricSchema() {
  return {
    version: RUBRIC_VERSION,
    tie_epsilon: TIE_EPSILON,
    serious_defect_score: SERIOUS_DEFECT_SCORE,
    criteria: CRITERIA.map((criterion) => ({
      id: criterion.id,
      name: criterion.name,
      weight: criterion.weight,
      question: criterion.question,
      anchors: criterion.anchors,
    })),
  };
}

export default {
  RUBRIC_VERSION,
  TIE_EPSILON,
  SERIOUS_DEFECT_SCORE,
  CRITERIA,
  RUBRIC_WEIGHTS,
  validateWeights,
  scoreCandidate,
  compareTotals,
  rubricTable,
  rubricSchema,
};
