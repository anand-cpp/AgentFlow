// The shape of one Arena debate: attacks, defenses, and revisions.
//
// A match is three model calls per side plus one judge call, and every one of
// those responses is untrusted. This module owns the contracts so the match
// runner can treat "the model wrote prose instead of JSON" and "the model
// attacked a criterion that does not exist" as the same class of failure --
// recorded, bounded, and retried -- rather than as an exception that kills the
// tournament.
//
// The evidence vocabulary is shared with the judge on purpose. An attack can
// carry an ALLEGATION, because models assert things they cannot prove, but only
// the four checkable kinds are marked verified, only verified attacks can back
// a fatal flaw, and the judge prompt says so. A confident sentence therefore
// cannot eliminate a candidate even if an attacker wrote it.

import { EVIDENCE_KIND } from "./judge.js";
import { CRITERIA } from "./rubric.js";
import { addUnknownFields, isNonEmptyString, isPlainObject } from "./schema.js";

export const MATCH_SCHEMA_VERSION = 1;

/** How hard an attack claims to hit. The judge still decides what survives. */
export const ATTACK_SEVERITY = Object.freeze({
  SERIOUS: "SERIOUS",
  MINOR: "MINOR",
});

/** What a defender did with an attack. OPEN means it is still a problem. */
export const DEFENSE_STANCE = Object.freeze({
  FIXED: "FIXED",
  REBUTTED: "REBUTTED",
  OPEN: "OPEN",
});

export const CHECKABLE_EVIDENCE = Object.freeze([
  EVIDENCE_KIND.TEST_CASE,
  EVIDENCE_KIND.COUNTER_EXAMPLE,
  EVIDENCE_KIND.BOUNDARY_INPUT,
  EVIDENCE_KIND.LOGICAL_PROOF,
]);

const CHECKABLE_SET = new Set(CHECKABLE_EVIDENCE);
const EVIDENCE_SET = new Set(Object.values(EVIDENCE_KIND));
const SEVERITY_SET = new Set(Object.values(ATTACK_SEVERITY));
const STANCE_SET = new Set(Object.values(DEFENSE_STANCE));
const CRITERION_SET = new Set(CRITERIA.map((criterion) => criterion.id));

const ATTACK_FIELDS = Object.freeze(["criterion", "severity", "claim", "evidence"]);
const ATTACK_REPORT_FIELDS = Object.freeze([
  "schema_version",
  "match_id",
  "attacker",
  "target",
  "summary",
  "attacks",
]);
const DEFENSE_FIELDS = Object.freeze(["attack_index", "stance", "explanation"]);
const DEFENSE_REPORT_FIELDS = Object.freeze([
  "schema_version",
  "match_id",
  "defender",
  "responses",
]);
const REVISION_REPORT_FIELDS = Object.freeze([
  "schema_version",
  "match_id",
  "candidate",
  "proposal",
  "changes",
]);
const EVIDENCE_FIELDS = Object.freeze(["kind", "payload"]);

const ATTACK_FIELD_SET = new Set(ATTACK_FIELDS);
const ATTACK_REPORT_FIELD_SET = new Set(ATTACK_REPORT_FIELDS);
const DEFENSE_FIELD_SET = new Set(DEFENSE_FIELDS);
const DEFENSE_REPORT_FIELD_SET = new Set(DEFENSE_REPORT_FIELDS);
const REVISION_REPORT_FIELD_SET = new Set(REVISION_REPORT_FIELDS);
const EVIDENCE_FIELD_SET = new Set(EVIDENCE_FIELDS);

/** An attack matters as evidence only when it can be checked. */
export function isVerifiedEvidence(evidence) {
  return Boolean(
    isPlainObject(evidence) &&
      CHECKABLE_SET.has(evidence.kind) &&
      isNonEmptyString(evidence.payload),
  );
}

function addEvidence(errors, evidence, where) {
  if (!isPlainObject(evidence)) {
    errors.push(`${where}evidence must be an object`);
    return;
  }
  addUnknownFields(errors, evidence, EVIDENCE_FIELD_SET, `${where}evidence.`);
  if (!EVIDENCE_SET.has(evidence.kind)) {
    errors.push(`${where}evidence.kind must be one of ${[...EVIDENCE_SET].join(", ")}`);
  }
  if (typeof evidence.payload !== "string") {
    errors.push(`${where}evidence.payload must be a string`);
  } else if (evidence.kind !== EVIDENCE_KIND.ALLEGATION && !isNonEmptyString(evidence.payload)) {
    errors.push(`${where}evidence.payload must be non-empty for ${evidence.kind} evidence`);
  }
}

/**
 * @param {unknown} report
 * @param {{ matchId?: string|null, attacker?: string|null, target?: string|null, maxAttacks?: number }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAttackResponse(
  report,
  { matchId = null, attacker = null, target = null, maxAttacks = 3 } = {},
) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["attack report must be an object"] };
  addUnknownFields(errors, report, ATTACK_REPORT_FIELD_SET, "");

  if (report.schema_version !== MATCH_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MATCH_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(report.match_id)) errors.push("match_id must be a non-empty string");
  else if (matchId && report.match_id !== matchId) {
    errors.push(`match_id "${report.match_id}" does not match "${matchId}"`);
  }
  if (attacker && report.attacker !== attacker) {
    errors.push(`attacker must be "${attacker}"`);
  }
  if (target && report.target !== target) {
    errors.push(`target must be "${target}"`);
  }
  if (!isNonEmptyString(report.summary)) errors.push("summary must be a non-empty string");

  if (!Array.isArray(report.attacks)) {
    errors.push("attacks must be an array (empty when there is nothing to attack)");
    return { valid: errors.length === 0, errors };
  }
  if (report.attacks.length > maxAttacks) {
    errors.push(`attacks must contain at most ${maxAttacks} entries, got ${report.attacks.length}`);
  }

  report.attacks.forEach((attack, index) => {
    const at = `attacks[${index}].`;
    if (!isPlainObject(attack)) {
      errors.push(`attacks[${index}] must be an object`);
      return;
    }
    addUnknownFields(errors, attack, ATTACK_FIELD_SET, at);
    if (!CRITERION_SET.has(attack.criterion)) {
      errors.push(`${at}criterion must be one of ${[...CRITERION_SET].join(", ")}`);
    }
    if (!SEVERITY_SET.has(attack.severity)) {
      errors.push(`${at}severity must be one of ${[...SEVERITY_SET].join(", ")}`);
    }
    if (!isNonEmptyString(attack.claim)) errors.push(`${at}claim must be a non-empty string`);
    addEvidence(errors, attack.evidence, at);
  });

  return { valid: errors.length === 0, errors };
}

/**
 * A defense must answer every attack exactly once. Silence is not a defense:
 * an unanswered attack stays open, and a validator that let it slide would let
 * a model win by ignoring the hardest question.
 *
 * @param {unknown} report
 * @param {{ matchId?: string|null, defender?: string|null, attackCount?: number }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDefenseResponse(
  report,
  { matchId = null, defender = null, attackCount = 0 } = {},
) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["defense report must be an object"] };
  addUnknownFields(errors, report, DEFENSE_REPORT_FIELD_SET, "");

  if (report.schema_version !== MATCH_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MATCH_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(report.match_id)) errors.push("match_id must be a non-empty string");
  else if (matchId && report.match_id !== matchId) {
    errors.push(`match_id "${report.match_id}" does not match "${matchId}"`);
  }
  if (defender && report.defender !== defender) {
    errors.push(`defender must be "${defender}"`);
  }

  if (!Array.isArray(report.responses)) {
    errors.push("responses must be an array");
    return { valid: errors.length === 0, errors };
  }
  if (report.responses.length !== attackCount) {
    errors.push(`responses must contain exactly ${attackCount} entries, got ${report.responses.length}`);
  }

  const seen = new Set();
  report.responses.forEach((response, index) => {
    const at = `responses[${index}].`;
    if (!isPlainObject(response)) {
      errors.push(`responses[${index}] must be an object`);
      return;
    }
    addUnknownFields(errors, response, DEFENSE_FIELD_SET, at);
    if (!Number.isInteger(response.attack_index) || response.attack_index < 0) {
      errors.push(`${at}attack_index must be a non-negative integer`);
    } else if (attackCount > 0 && response.attack_index >= attackCount) {
      errors.push(`${at}attack_index ${response.attack_index} is out of range`);
    } else if (seen.has(response.attack_index)) {
      errors.push(`${at}attack_index ${response.attack_index} is answered twice`);
    } else {
      seen.add(response.attack_index);
    }
    if (!STANCE_SET.has(response.stance)) {
      errors.push(`${at}stance must be one of ${[...STANCE_SET].join(", ")}`);
    }
    if (!isNonEmptyString(response.explanation)) {
      errors.push(`${at}explanation must be a non-empty string`);
    }
  });

  if (attackCount > 0 && seen.size !== report.responses.length) {
    const missing = [];
    for (let i = 0; i < attackCount; i += 1) if (!seen.has(i)) missing.push(i);
    if (missing.length) errors.push(`responses are missing attack_index ${missing.join(", ")}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * A revision must be a complete replacement proposal, not a diff against the
 * old one. The judge scores what survives, so a revision that says "as before,
 * but fixed" without restating the plan gives it nothing to read.
 *
 * @param {unknown} report
 * @param {{ matchId?: string|null, candidate?: string|null }} [options]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRevisionResponse(report, { matchId = null, candidate = null } = {}) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["revision report must be an object"] };
  addUnknownFields(errors, report, REVISION_REPORT_FIELD_SET, "");

  if (report.schema_version !== MATCH_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MATCH_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(report.match_id)) errors.push("match_id must be a non-empty string");
  else if (matchId && report.match_id !== matchId) {
    errors.push(`match_id "${report.match_id}" does not match "${matchId}"`);
  }
  if (candidate && report.candidate !== candidate) {
    errors.push(`candidate must be "${candidate}"`);
  }
  if (!isNonEmptyString(report.proposal)) {
    errors.push("proposal must be the complete revised proposal");
  }
  if (!Array.isArray(report.changes)) {
    errors.push("changes must be an array (empty when nothing changed)");
  } else {
    report.changes.forEach((change, index) => {
      if (!isNonEmptyString(change)) errors.push(`changes[${index}] must be a non-empty string`);
    });
  }

  return { valid: errors.length === 0, errors };
}

export const ATTACK_SYSTEM_PROMPT = [
  "You are a competing candidate in an adversarial evaluation tournament.",
  "Your job in this phase is to attack the opponent's proposal, not to praise it.",
  "Attacks must be specific and checkable. A claim without a test case, counter-example, boundary input, or logical proof is an ALLEGATION and will not decide anything.",
  "Attack the work, not the author. Do not invent requirements the task never stated.",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
].join("\n");

export const DEFENSE_SYSTEM_PROMPT = [
  "You are defending your own proposal against attacks from a rival candidate.",
  "Answer every attack exactly once. FIXED means you changed the proposal to remove the problem; REBUTTED means the attack is wrong and you can say why; OPEN means it is a real problem you have not solved.",
  "Do not mark an attack REBUTTED just because you dislike it. The judge checks the reasoning against your revision.",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
].join("\n");

export const REVISION_SYSTEM_PROMPT = [
  "You are revising your own proposal after an adversarial review.",
  "Return the complete revised proposal, not a diff and not a summary of what you would change.",
  "Actually fix what is broken. Keep what was already right. Do not pad the proposal to look thorough.",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
].join("\n");

function renderCard(card) {
  if (!card) return "(no strategy card)";
  return [
    `reasoning: ${card.reasoning ?? ""}`,
    `workflow: ${card.workflow ?? ""}`,
    `optimization: ${card.optimization ?? ""}`,
  ].join("\n");
}

/**
 * Prompt for the attack call.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {string} input.matchId
 * @param {string} input.attacker      candidate_a | candidate_b
 * @param {string} input.target        the other label
 * @param {string} input.targetProposal
 * @param {object} [input.attackerCard]
 * @param {number} [input.maxAttacks]
 */
export function buildAttackPrompt({
  task,
  matchId,
  attacker,
  target,
  targetProposal,
  attackerCard = null,
  attackerLabel = null,
  maxAttacks = 3,
} = {}) {
  const who = attackerLabel ? `${attacker} (${attackerLabel})` : attacker;
  return [
    `Task both candidates were given:\n${String(task ?? "").trim()}`,
    `Match: ${matchId}`,
    `You are ${who}. Your strategy card:\n${renderCard(attackerCard)}`,
    `Opponent (${target}) proposal:\n---\n${String(targetProposal ?? "").trim()}\n---`,
    `Send at most ${maxAttacks} attacks. Rank the most damaging first. If a criterion is genuinely fine, do not attack it just to fill the list; an empty attacks array is allowed.`,
    "Attack criteria: " + CRITERIA.map((criterion) => criterion.id).join(", ") + ".",
    "Return exactly this JSON shape (no extra fields):",
    JSON.stringify(
      {
        schema_version: MATCH_SCHEMA_VERSION,
        match_id: matchId ?? "r1m1",
        attacker: attackerLabel ?? "candidate_a",
        target: target ?? "candidate_b",
        summary: "one sentence on the biggest risk you found",
        attacks: [
          {
            criterion: "correctness",
            severity: "SERIOUS",
            claim: "what is wrong",
            evidence: { kind: "TEST_CASE", payload: "the concrete failing case" },
          },
        ],
      },
      null,
      2,
    ),
  ].join("\n\n");
}

/**
 * Prompt for the defense call. Every attack is listed with its index so the
 * response can be matched up mechanically rather than by string comparison.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {string} input.matchId
 * @param {string} input.defender
 * @param {string} input.ownProposal
 * @param {Array<{criterion: string, severity: string, claim: string, evidence: object}>} input.attacks
 */
export function buildDefensePrompt({
  task,
  matchId,
  defender,
  defenderLabel = null,
  ownProposal,
  attacks = [],
} = {}) {
  const list = attacks.length
    ? attacks
        .map(
          (attack, index) =>
            `[${index}] ${attack.severity} on ${attack.criterion}: ${attack.claim}\n` +
            `    evidence (${attack.evidence.kind}): ${attack.evidence.payload || "(none)"}`,
        )
        .join("\n")
    : "(no attacks were raised)";
  const who = defenderLabel ? `${defender} (${defenderLabel})` : defender;

  return [
    `Task both candidates were given:\n${String(task ?? "").trim()}`,
    `Match: ${matchId}`,
    `You are ${who}, defending your own proposal.`,
    `Your current proposal:\n---\n${String(ownProposal ?? "").trim()}\n---`,
    `Attacks against it:\n${list}`,
    "Answer every numbered attack exactly once. Use FIXED only if the proposal already resolves it, REBUTTED only with a specific reason the attack is wrong, OPEN if it is a real unsolved problem.",
    "Return exactly this JSON shape (no extra fields):",
    JSON.stringify(
      {
        schema_version: MATCH_SCHEMA_VERSION,
        match_id: matchId ?? "r1m1",
        defender: defenderLabel ?? "candidate_b",
        responses: [
          { attack_index: 0, stance: "FIXED", explanation: "what changed and where" },
        ],
      },
      null,
      2,
    ),
  ].join("\n\n");
}

/**
 * Prompt for the revision call.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {string} input.matchId
 * @param {string} input.candidate
 * @param {string} input.ownProposal
 * @param {Array<object>} input.attacks
 * @param {Array<object>} input.defenses
 */
export function buildRevisionPrompt({
  task,
  matchId,
  candidate,
  candidateLabel = null,
  ownProposal,
  attacks = [],
  defenses = [],
} = {}) {
  const list = attacks.length
    ? attacks
        .map((attack, index) => {
          const defense = defenses[index];
          const stance = defense?.stance ?? "OPEN";
          const why = defense?.explanation ?? "(no defense recorded)";
          return `[${index}] ${attack.severity} on ${attack.criterion}: ${attack.claim}\n    your defense was ${stance}: ${why}`;
        })
        .join("\n")
    : "(no attacks were raised)";
  const who = candidateLabel ? `${candidate} (${candidateLabel})` : candidate;

  return [
    `Task both candidates were given:\n${String(task ?? "").trim()}`,
    `Match: ${matchId}`,
    `You are ${who}, revising your own proposal.`,
    `Your current proposal:\n---\n${String(ownProposal ?? "").trim()}\n---`,
    `Attacks and your defenses:\n${list}`,
    "Write the complete revised proposal. Fix what is genuinely broken, keep what was right, and make the result directly usable by someone implementing it.",
    "Return exactly this JSON shape (no extra fields):",
    JSON.stringify(
      {
        schema_version: MATCH_SCHEMA_VERSION,
        match_id: matchId ?? "r1m1",
        candidate: candidateLabel ?? "candidate_a",
        proposal: "the complete revised proposal",
        changes: ["what changed, in one line"],
      },
      null,
      2,
    ),
  ].join("\n\n");
}

export default {
  MATCH_SCHEMA_VERSION,
  ATTACK_SEVERITY,
  DEFENSE_STANCE,
  CHECKABLE_EVIDENCE,
  isVerifiedEvidence,
  validateAttackResponse,
  validateDefenseResponse,
  validateRevisionResponse,
  ATTACK_SYSTEM_PROMPT,
  DEFENSE_SYSTEM_PROMPT,
  REVISION_SYSTEM_PROMPT,
  buildAttackPrompt,
  buildDefensePrompt,
  buildRevisionPrompt,
};
