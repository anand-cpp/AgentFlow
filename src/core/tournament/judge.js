// The Arena judge: turn one judge response into a validated match decision.
//
// The judge is a separate stage on purpose. A candidate arguing for itself is
// not evidence, so the bracket asks an independent call to score both revised
// candidates against the rubric and to list only the objections that survived
// the defense phase. This module is the contract between that call and the
// bracket:
//
//   * The response is parsed and validated strictly. Missing criteria, unknown
//     fields, out-of-range scores, and a verdict that contradicts the scores are
//     rejected -- an invalid judge is a lost match, never a default winner.
//   * Serious defect claims need evidence. A criterion scored at or below
//     SERIOUS_DEFECT_SCORE must be backed by an unresolved objection whose
//     evidence is a concrete test case, counterexample, boundary input, or
//     logical proof.
//   * A fatal flaw decides the match only when it is verified. An unsupported
//     allegation is recorded as `verified: false` and the match falls through to
//     the rubric, so a confident sentence cannot eliminate a candidate.
//   * Ties are broken by an explicit, documented ladder, and a genuine tie
//     returns `outcome: "unresolved"`. The judge never invents a winner, and
//     this module never advances the bracket -- it returns a decision that the
//     caller applies with applyMatchResult().
//
// Raw judge output is returned alongside the compact decision, not inside it,
// so persisted tournament state stays small and the full artifact can live in
// the session store where it belongs.

import {
  CRITERIA,
  RUBRIC_WEIGHTS,
  RUBRIC_VERSION,
  SERIOUS_DEFECT_SCORE,
  TIE_EPSILON,
  compareTotals,
  rubricTable,
  scoreCandidate,
} from "./rubric.js";
import { parseModelJson } from "./json.js";
import { addUnknownFields, isNonEmptyString, isPlainObject } from "./schema.js";

export const JUDGE_SCHEMA_VERSION = 1;

/**
 * How a claim is backed. The first four are checkable; ALLEGATION is the
 * explicit "I have no proof" option, which is what makes unsupported fatal
 * claims representable instead of silently schema-invalid.
 */
export const EVIDENCE_KIND = Object.freeze({
  TEST_CASE: "TEST_CASE",
  COUNTER_EXAMPLE: "COUNTER_EXAMPLE",
  BOUNDARY_INPUT: "BOUNDARY_INPUT",
  LOGICAL_PROOF: "LOGICAL_PROOF",
  ALLEGATION: "ALLEGATION",
});

const SUPPORTED_EVIDENCE = new Set([
  EVIDENCE_KIND.TEST_CASE,
  EVIDENCE_KIND.COUNTER_EXAMPLE,
  EVIDENCE_KIND.BOUNDARY_INPUT,
  EVIDENCE_KIND.LOGICAL_PROOF,
]);
const FATAL_EVIDENCE = new Set([...SUPPORTED_EVIDENCE, EVIDENCE_KIND.ALLEGATION]);

/** What the judge is allowed to declare. TIE is an admission, not a winner. */
export const DECLARED_VERDICT = Object.freeze({
  A_WINS: "A_WINS",
  B_WINS: "B_WINS",
  TIE: "TIE",
});

/** What the module returns. */
export const OUTCOME = Object.freeze({
  WINNER: "winner",
  UNRESOLVED: "unresolved",
});

export const DECISION_REASON = Object.freeze({
  FATAL_FLAW: "fatal_flaw",
  SCORE: "score",
  CORRECTNESS: "tiebreak_correctness",
  ROBUSTNESS: "tiebreak_robustness",
  OBJECTIONS: "tiebreak_objections",
  UNRESOLVED: "tie_unresolved",
});

const CANDIDATE_LABELS = Object.freeze(["candidate_a", "candidate_b"]);
const LABEL_SET = new Set(CANDIDATE_LABELS);
const CRITERION_SET = new Set(CRITERIA.map((criterion) => criterion.id));

const REPORT_FIELDS = Object.freeze([
  "schema_version",
  "match_id",
  "scores",
  "unresolved_objections",
  "fatal_flaw",
  "verdict",
  "rationale",
  "judge_model",
]);
const FATAL_FLAW_FIELDS = Object.freeze(["candidate", "criterion", "claim", "evidence"]);
const OBJECTION_FIELDS = Object.freeze(["criterion", "claim", "evidence"]);
const EVIDENCE_FIELDS = Object.freeze(["kind", "payload"]);
const REPORT_FIELD_SET = new Set(REPORT_FIELDS);
const FATAL_FLAW_FIELD_SET = new Set(FATAL_FLAW_FIELDS);
const OBJECTION_FIELD_SET = new Set(OBJECTION_FIELDS);
const EVIDENCE_FIELD_SET = new Set(EVIDENCE_FIELDS);
const VERDICT_SET = new Set(Object.values(DECLARED_VERDICT));

/** The exact JSON shape the judge must return. Data, so tests and prompts agree. */
export const JUDGE_RESPONSE_SCHEMA = Object.freeze({
  schema_version: JUDGE_SCHEMA_VERSION,
  report_fields: REPORT_FIELDS,
  fatal_flaw_fields: FATAL_FLAW_FIELDS,
  objection_fields: OBJECTION_FIELDS,
  evidence_fields: EVIDENCE_FIELDS,
  criteria: Object.freeze(CRITERIA.map((criterion) => criterion.id)),
  evidence_kinds: Object.freeze(Object.values(EVIDENCE_KIND)),
  fatal_evidence_kinds: Object.freeze([...FATAL_EVIDENCE]),
  verdicts: Object.freeze(Object.values(DECLARED_VERDICT)),
  score_range: Object.freeze({ min: 0, max: 10 }),
  serious_defect_score: SERIOUS_DEFECT_SCORE,
  tie_epsilon: TIE_EPSILON,
  rubric_version: RUBRIC_VERSION,
});

/**
 * The shape of a parsed judge report, used after the runtime shape checks in
 * validateJudgeResponse().
 *
 * @typedef {object} JudgeReport
 * @property {number} schema_version
 * @property {string} match_id
 * @property {object} scores
 * @property {object} scores.candidate_a
 * @property {object} scores.candidate_b
 * @property {object} unresolved_objections
 * @property {object} unresolved_objections.candidate_a
 * @property {object} unresolved_objections.candidate_b
 * @property {object|null} fatal_flaw
 * @property {string} fatal_flaw.candidate
 * @property {string} fatal_flaw.criterion
 * @property {string} fatal_flaw.claim
 * @property {object} fatal_flaw.evidence
 * @property {string} fatal_flaw.evidence.kind
 * @property {string} fatal_flaw.evidence.payload
 * @property {"A_WINS"|"B_WINS"|"TIE"} verdict
 * @property {string} rationale
 * @property {string|null} judge_model
 */

export const JUDGE_SYSTEM_PROMPT = [
  "You are an independent judge in a competitive evaluation.",
  "Score the two candidates against the rubric. Do not be polite: use the whole 0-10 scale, and do not reward length, confidence, or self-praise.",
  "Judge the work, not the writing style. A clear wrong answer loses to a dense correct one.",
  "For every requirement the task states, check whether the candidate actually meets it.",
  "Only list an objection as unresolved if it survived the candidate's defense and revision. If it was fixed or correctly rebutted, it is not an objection.",
  "A score of 3 or lower on any criterion requires an unresolved objection with concrete evidence.",
  "A fatal flaw must name the criterion, the claim, and checkable evidence (a test case, counterexample, boundary input, or logical proof). If you have no proof, use evidence kind ALLEGATION -- it will not decide the match.",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
].join("\n");

/**
 * Parse judge output. Accepts a bare object or a fenced block, because models
 * routinely wrap JSON in markdown no matter what the system prompt says. The
 * extraction rules themselves live in json.js so every Arena stage agrees on
 * what counts as readable output.
 *
 * @param {string} text
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseJudgeJson(text) {
  return parseModelJson(text, "judge");
}

function addEvidence(errors, evidence, where, { allowAllegation }) {
  const allowed = allowAllegation ? FATAL_EVIDENCE : SUPPORTED_EVIDENCE;
  if (!isPlainObject(evidence)) {
    errors.push(`${where}evidence must be an object`);
    return;
  }
  addUnknownFields(errors, evidence, EVIDENCE_FIELD_SET, `${where}evidence.`);
  if (!allowed.has(evidence.kind)) {
    errors.push(
      `${where}evidence.kind must be one of ${[...allowed].join(", ")}${
        allowAllegation ? " (use ALLEGATION only when you have no proof)" : ""
      }`,
    );
  }
  if (typeof evidence.payload !== "string") {
    errors.push(`${where}evidence.payload must be a string`);
  } else if (evidence.kind !== EVIDENCE_KIND.ALLEGATION && !isNonEmptyString(evidence.payload)) {
    errors.push(`${where}evidence.payload must be non-empty concrete evidence`);
  }
}

function addObjections(errors, objections, label) {
  const where = `unresolved_objections.${label}`;
  if (!Array.isArray(objections)) {
    errors.push(`${where} must be an array`);
    return;
  }
  objections.forEach((objection, index) => {
    const at = `${where}[${index}].`;
    if (!isPlainObject(objection)) {
      errors.push(`${where}[${index}] must be an object`);
      return;
    }
    addUnknownFields(errors, objection, OBJECTION_FIELD_SET, at);
    if (!CRITERION_SET.has(objection.criterion)) {
      errors.push(`${at}criterion must be one of ${[...CRITERION_SET].join(", ")}`);
    }
    if (!isNonEmptyString(objection.claim)) errors.push(`${at}claim must be a non-empty string`);
    // Objections are the evidence trail for serious scores, so an allegation
    // is not enough here -- only the four checkable kinds count.
    addEvidence(errors, objection.evidence, at, { allowAllegation: false });
  });
}

/**
 * Validate the structure of one judge response. Non-throwing and fail-closed.
 *
 * @param {unknown} report
 * @param {{ matchId?: string|null }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateJudgeResponse(report, { matchId = null } = {}) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["judge report must be an object"] };
  /** @type {JudgeReport} */
  const r = /** @type {any} */ (report);
  addUnknownFields(errors, r, REPORT_FIELD_SET, "");

  if (r.schema_version !== JUDGE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${JUDGE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(r.match_id)) {
    errors.push("match_id must be a non-empty string");
  } else if (matchId && r.match_id !== matchId) {
    errors.push(`match_id "${r.match_id}" does not match "${matchId}"`);
  }

  if (!isPlainObject(r.scores)) {
    errors.push("scores must be an object with candidate_a and candidate_b");
  } else {
    for (const label of CANDIDATE_LABELS) {
      if (!(label in r.scores)) errors.push(`scores is missing "${label}"`);
    }
    for (const key of Object.keys(r.scores)) {
      if (!LABEL_SET.has(key)) errors.push(`scores has unknown candidate "${key}"`);
    }
    for (const label of CANDIDATE_LABELS) {
      if (!(label in r.scores)) continue;
      const check = scoreCandidate(r.scores[label], RUBRIC_WEIGHTS);
      for (const error of check.errors) errors.push(`scores.${label}: ${error}`);
    }
  }

  if (!isPlainObject(r.unresolved_objections)) {
    errors.push("unresolved_objections must be an object with candidate_a and candidate_b");
  } else {
    for (const label of CANDIDATE_LABELS) {
      if (!(label in r.unresolved_objections)) {
        errors.push(`unresolved_objections is missing "${label}"`);
      } else {
        addObjections(errors, r.unresolved_objections[label], label);
      }
    }
    for (const key of Object.keys(r.unresolved_objections)) {
      if (!LABEL_SET.has(key)) errors.push(`unresolved_objections has unknown candidate "${key}"`);
    }
  }

  if (r.fatal_flaw !== null) {
    if (!isPlainObject(r.fatal_flaw)) {
      errors.push("fatal_flaw must be null or an object");
    } else {
      addUnknownFields(errors, r.fatal_flaw, FATAL_FLAW_FIELD_SET, "fatal_flaw.");
      if (!LABEL_SET.has(r.fatal_flaw.candidate)) {
        errors.push('fatal_flaw.candidate must be "candidate_a" or "candidate_b"');
      }
      if (!CRITERION_SET.has(r.fatal_flaw.criterion)) {
        errors.push(`fatal_flaw.criterion must be one of ${[...CRITERION_SET].join(", ")}`);
      }
      if (!isNonEmptyString(r.fatal_flaw.claim)) {
        errors.push("fatal_flaw.claim must be a non-empty string");
      }
      addEvidence(errors, r.fatal_flaw.evidence, "fatal_flaw.", { allowAllegation: true });
    }
  } else if (!("fatal_flaw" in r)) {
    errors.push("fatal_flaw is required and must be null when there is no fatal flaw");
  }

  if (!VERDICT_SET.has(r.verdict)) {
    errors.push(`verdict must be one of ${[...VERDICT_SET].join(", ")}`);
  }
  if (!isNonEmptyString(r.rationale)) {
    errors.push("rationale must be a non-empty string");
  }
  if ("judge_model" in r && r.judge_model !== null && typeof r.judge_model !== "string") {
    errors.push("judge_model must be a string or null");
  }

  return { valid: errors.length === 0, errors };
}

function candidateId(candidate) {
  if (typeof candidate === "string") return candidate;
  return candidate?.id ?? null;
}

function publicScore(id, score) {
  return {
    id,
    criteria: score.criteria,
    weighted: score.weighted,
    total: score.total,
  };
}

/**
 * Decide a match from an already-parsed judge report.
 *
 * Returns `{ ok: false, errors }` for an invalid or self-contradictory report,
 * and `{ ok: true, decision }` otherwise -- including `outcome: "unresolved"`
 * when the rubric and every tie-break are level. It never throws on bad model
 * output and never touches tournament state.
 *
 * @param {object} report
 * @param {object} input
 * @param {string} [input.matchId]
 * @param {string|object} [input.candidateA]
 * @param {string|object} [input.candidateB]
 * @param {number} [input.now]
 */
export function decideMatch(report, { matchId, candidateA, candidateB, now = Date.now() } = {}) {
  const idA = candidateId(candidateA);
  const idB = candidateId(candidateB);
  if (!matchId) return { ok: false, decision: null, errors: ["matchId is required"] };
  if (!idA || !idB) return { ok: false, decision: null, errors: ["both candidate ids are required"] };
  if (idA === idB) return { ok: false, decision: null, errors: ["a candidate cannot be matched against itself"] };

  const check = validateJudgeResponse(report, { matchId });
  if (!check.valid) return { ok: false, decision: null, errors: check.errors };

  /** @type {JudgeReport} */
  const r = /** @type {any} */ (report);
  const a = scoreCandidate(r.scores.candidate_a);
  const b = scoreCandidate(r.scores.candidate_b);
  if (!a.ok || !b.ok) {
    return { ok: false, decision: null, errors: [...a.errors, ...b.errors] };
  }

  const errors = [];
  const scoresByLabel = { candidate_a: a, candidate_b: b };
  const idsByLabel = { candidate_a: idA, candidate_b: idB };

  // Rule 1: a serious score must be backed by a concrete unresolved objection.
  for (const label of CANDIDATE_LABELS) {
    const objections = r.unresolved_objections[label];
    for (const criterion of CRITERIA) {
      const value = scoresByLabel[label].criteria[criterion.id];
      if (value > SERIOUS_DEFECT_SCORE) continue;
      const backed = objections.some(
        (objection) =>
          objection.criterion === criterion.id &&
          SUPPORTED_EVIDENCE.has(objection.evidence.kind) &&
          isNonEmptyString(objection.evidence.payload),
      );
      if (!backed) {
        errors.push(
          `scores.${label}.${criterion.id} is ${value} but no unresolved objection with evidence supports it`,
        );
      }
    }
  }

  const fatal = r.fatal_flaw;
  let fatalFlaw = null;
  if (fatal) {
    const verified =
      SUPPORTED_EVIDENCE.has(fatal.evidence.kind) && isNonEmptyString(fatal.evidence.payload);
    fatalFlaw = {
      candidateId: idsByLabel[fatal.candidate],
      candidate: fatal.candidate,
      criterion: fatal.criterion,
      claim: fatal.claim,
      verified,
      evidence: { kind: fatal.evidence.kind, payload: fatal.evidence.payload },
    };
    // A claimed critical defect on a criterion the judge also scored well is a
    // contradiction, not a judgement call.
    if (verified && scoresByLabel[fatal.candidate].criteria[fatal.criterion] > SERIOUS_DEFECT_SCORE) {
      errors.push(
        `contradictory fatal flaw: ${fatal.candidate}.${fatal.criterion} is scored ` +
          `${scoresByLabel[fatal.candidate].criteria[fatal.criterion]} but called fatal`,
      );
    }
  }

  if (errors.length) return { ok: false, decision: null, errors };

  let winnerLabel = null;
  let reason = null;
  let tieBreak = null;
  const diff = a.total - b.total;

  if (fatalFlaw?.verified) {
    winnerLabel = fatalFlaw.candidate === "candidate_a" ? "candidate_b" : "candidate_a";
    reason = DECISION_REASON.FATAL_FLAW;
  } else if (compareTotals(a.total, b.total) !== 0) {
    winnerLabel = diff > 0 ? "candidate_a" : "candidate_b";
    reason = DECISION_REASON.SCORE;
  } else {
    // Documented ladder. Totals are level, so the next questions are "which is
    // more correct", "which survived the attacks", then "which has fewer open
    // objections". If all three are level, the match is genuinely unresolved.
    const ladder = [
      { criterion: "correctness", reason: DECISION_REASON.CORRECTNESS },
      { criterion: "robustness", reason: DECISION_REASON.ROBUSTNESS },
    ];
    for (const step of ladder) {
      const delta =
        scoresByLabel.candidate_a.criteria[step.criterion] -
        scoresByLabel.candidate_b.criteria[step.criterion];
      if (Math.abs(delta) < TIE_EPSILON) continue;
      winnerLabel = delta > 0 ? "candidate_a" : "candidate_b";
      reason = step.reason;
      tieBreak = {
        rule: step.reason,
        detail: `${step.criterion} ${scoresByLabel.candidate_a.criteria[step.criterion]} vs ${scoresByLabel.candidate_b.criteria[step.criterion]}`,
      };
      break;
    }

    if (!winnerLabel) {
      const objectionsA = r.unresolved_objections.candidate_a.length;
      const objectionsB = r.unresolved_objections.candidate_b.length;
      if (objectionsA !== objectionsB) {
        winnerLabel = objectionsA < objectionsB ? "candidate_a" : "candidate_b";
        reason = DECISION_REASON.OBJECTIONS;
        tieBreak = { rule: reason, detail: `${objectionsA} vs ${objectionsB} open objections` };
      } else {
        reason = DECISION_REASON.UNRESOLVED;
      }
    }
  }

  // Cross-check: a declared winner that disagrees with the computed result is a
  // contradiction, not a hint. TIE never contradicts -- it is an admission.
  if (r.verdict !== DECLARED_VERDICT.TIE) {
    if (!winnerLabel) {
      return {
        ok: false,
        decision: null,
        errors: [`contradictory verdict: declared ${r.verdict} but the rubric is level`],
      };
    }
    const declared = r.verdict === DECLARED_VERDICT.A_WINS ? "candidate_a" : "candidate_b";
    if (declared !== winnerLabel) {
      return {
        ok: false,
        decision: null,
        errors: [
          `contradictory verdict: declared ${r.verdict} but the scores favour ${winnerLabel}`,
        ],
      };
    }
  }

  const outcome = winnerLabel ? OUTCOME.WINNER : OUTCOME.UNRESOLVED;
  const winnerId = winnerLabel ? idsByLabel[winnerLabel] : null;
  const loserId = winnerLabel ? idsByLabel[winnerLabel === "candidate_a" ? "candidate_b" : "candidate_a"] : null;

  return {
    ok: true,
    errors: [],
    decision: {
      rubricVersion: RUBRIC_VERSION,
      schemaVersion: JUDGE_SCHEMA_VERSION,
      matchId,
      candidates: { candidate_a: idA, candidate_b: idB },
      outcome,
      verdict: winnerLabel ? (winnerLabel === "candidate_a" ? "A_WINS" : "B_WINS") : "UNRESOLVED",
      declaredVerdict: r.verdict,
      winnerId,
      loserId,
      reason,
      scores: {
        candidate_a: publicScore(idA, a),
        candidate_b: publicScore(idB, b),
      },
      fatalFlaw,
      tieBreak,
      unresolvedObjections: {
        candidate_a: r.unresolved_objections.candidate_a.length,
        candidate_b: r.unresolved_objections.candidate_b.length,
      },
      rationale: r.rationale,
      judgeModel: r.judge_model ?? null,
      decidedAt: new Date(now).toISOString(),
    },
  };
}

/**
 * Parse and decide in one step. The raw report is returned separately so the
 * caller can persist it without inflating the tournament state.
 *
 * @param {object} input
 * @param {string} [input.text]        raw judge output
 * @param {object} [input.match]     bracket match ({ id, a, b })
 * @param {string} [input.matchId]
 * @param {string|object} [input.candidateA]
 * @param {string|object} [input.candidateB]
 * @param {number} [input.now]
 */
export function judgeMatch({ text, match, matchId, candidateA, candidateB, now = Date.now() } = {}) {
  const id = matchId ?? match?.id;
  const a = candidateA ?? match?.a;
  const b = candidateB ?? match?.b;

  const parsed = parseJudgeJson(text);
  if (!parsed.ok) {
    const failed = /** @type {{ ok: false; error: string }} */ (parsed);
    return { ok: false, decision: null, raw: null, errors: [failed.error] };
  }

  const decided = decideMatch(parsed.value, { matchId: id, candidateA: a, candidateB: b, now });
  return { ok: decided.ok, decision: decided.decision, raw: parsed.value, errors: decided.errors };
}

/**
 * The argument for the bracket owner's applyMatchResult(). Returns null when
 * the match is unresolved: an unresolved match must not be advanced by
 * defaulting to one of the candidates.
 *
 * @param {object|null} decision
 * @returns {{ matchId: string, winnerId: string, verdict: object } | null}
 */
export function decisionToMatchResult(decision) {
  if (!decision || decision.outcome !== OUTCOME.WINNER || !decision.winnerId) return null;
  return {
    matchId: decision.matchId,
    winnerId: decision.winnerId,
    verdict: decision,
  };
}

function renderCandidate(candidate) {
  if (!candidate) return "(missing)";
  const id = candidate.id ?? candidate;
  const card = candidate.cardId ?? candidate.card?.id;
  const proposal = candidate.proposal ?? candidate.text ?? "";
  const header = card ? `Candidate ${id} (strategy card ${card})` : `Candidate ${id}`;
  return `${header}\n---\n${proposal}`;
}

/**
 * Prompt for the judge call. Bounded by the caller: this module does not
 * truncate proposals, because silently dropping the end of an answer is how a
 * judge ends up scoring a different candidate than the one that competed.
 *
 * @param {object} input
 * @param {string} [input.task]
 * @param {string} [input.matchId]
 * @param {object|string} [input.candidateA]  { id, proposal, cardId? } or id
 * @param {object|string} [input.candidateB]
 */
export function buildJudgePrompt({ task, matchId, candidateA, candidateB } = {}) {
  return [
    `Task both candidates were given:\n${String(task ?? "").trim()}`,
    `Match: ${String(matchId ?? "").trim()}`,
    "Rubric (score each criterion 0-10; weights sum to 1.0):",
    rubricTable(),
    "Evidence rules:",
    "- A score of 3 or lower on a criterion requires an unresolved objection for that criterion with concrete evidence.",
    "- Only objections that survived the candidate's defense and revision belong in unresolved_objections.",
    "- A fatal flaw decides the match only if verified. Evidence kinds TEST_CASE, COUNTER_EXAMPLE, BOUNDARY_INPUT and LOGICAL_PROOF are checkable. ALLEGATION is not.",
    "- If the scores are level and you cannot separate the candidates, declare TIE.",
    "Return exactly this JSON shape (no extra fields):",
    JSON.stringify(
      {
        schema_version: JUDGE_SCHEMA_VERSION,
        match_id: matchId ?? "r1m1",
        scores: {
          candidate_a: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, 0])),
          candidate_b: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, 0])),
        },
        unresolved_objections: { candidate_a: [], candidate_b: [] },
        fatal_flaw: null,
        verdict: "A_WINS",
        rationale: "why the winner won, citing the rubric",
        judge_model: null,
      },
      null,
      2,
    ),
    `Candidate A:\n${renderCandidate(candidateA)}`,
    `Candidate B:\n${renderCandidate(candidateB)}`,
  ].join("\n\n");
}

export default {
  JUDGE_SCHEMA_VERSION,
  EVIDENCE_KIND,
  DECLARED_VERDICT,
  OUTCOME,
  DECISION_REASON,
  JUDGE_RESPONSE_SCHEMA,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeJson,
  validateJudgeResponse,
  decideMatch,
  judgeMatch,
  decisionToMatchResult,
  buildJudgePrompt,
};
