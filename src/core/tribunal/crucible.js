// Stage 2 -- The Crucible: external cross-examination.
//
// Where self-review.js makes one model attack its own proposal, the Crucible
// hands a proposal it has already defended to *specialized* attackers. Security
// is questioned by a security lens, logic by a logic lens, edge cases by an edge
// lens, scalability by a performance lens -- each in its own isolated prompt so
// one agent's framing cannot contaminate another's. The proposal is presented
// identity-blind: the attacker sees the work, never who or which model produced
// it, because "this came from model X" is exactly the shortcut the stage exists
// to remove.

import { redactDeep } from "../redact.js";
import {
  ATTACK_VECTOR,
  ATTACK_VECTOR_SPECS,
  CRUCIBLE_ATTACK_SCHEMA,
  CRUCIBLE_SCHEMA_VERSION,
  CRUCIBLE_SEVERITY,
  CRUCIBLE_SEVERITY_RANK,
  PROOF_KIND,
  classifyAttackFindings,
  validateCrucibleReport,
} from "./crucible-schema.js";

/**
 * Mark placed on an attack the orchestrator could not use: a transport failure,
 * non-JSON output, or a report the schema refused. Named (not a bare null) so a
 * caller can report *how many* attacks were lost without conflating them with a
 * genuine PASS.
 */
export const INVALID_ATTACK = "INVALID_ATTACK";

/**
 * The system prompt shared by every attack. The schema block is spelled out
 * literally, enum by enum, so the model has no room to invent a severity or a
 * proof kind the validator will reject.
 */
export const CRUCIBLE_SYSTEM_PROMPT = [
  "You are an adversarial examiner in a proposal tribunal. Your job is to break the work in front of you, not to praise it.",
  "Attack the proposal from the single perspective you are given. Ignore every other perspective; another examiner covers those.",
  "Every finding you raise MUST be falsifiable: it carries a proof of one of these kinds --",
  `  ${PROOF_KIND.TEST_CASE}: a concrete test case and the result it would produce.`,
  `  ${PROOF_KIND.COUNTER_EXAMPLE}: a specific input or scenario that defeats the proposal.`,
  `  ${PROOF_KIND.BOUNDARY_INPUT}: a boundary value (empty, zero, maximum, malformed) that breaks it.`,
  `  ${PROOF_KIND.LOGICAL_PROOF}: a short argument showing a contradiction or an unmet invariant.`,
  "A finding whose falsifiable_proof.payload is empty is not a finding and will be discarded.",
  "Do not speculate about who wrote this or what tool produced it. Judge only the work.",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
  `It must have exactly these fields: schema_version (must be ${CRUCIBLE_SCHEMA_VERSION}), attacker_perspective, target_proposal_id, verdict, findings, summary.`,
  "verdict is one of PASS, FLAWED, FATAL. FATAL means the proposal cannot proceed as written.",
  `Each finding has exactly: id, severity (${Object.values(CRUCIBLE_SEVERITY).join(", ")}), vector, title, explanation, falsifiable_proof.`,
  `falsifiable_proof has exactly: kind (${Object.values(PROOF_KIND).join(", ")}) and payload.`,
].join("\n");

/**
 * How each proposal domain should be framed, and which proof kinds read as
 * native to it. The Crucible is domain-agnostic: the same four vectors apply to
 * a function, a service design, a plan, or an argument -- only the vocabulary of
 * "proof" changes, and that is what this table adapts.
 */
export const DOMAIN_SPECS = Object.freeze({
  code: {
    label: "source code",
    instruction:
      "The proposal is code or a coding change. Prefer TEST_CASE and COUNTER_EXAMPLE proofs: show the input and the failing result a test would observe.",
  },
  architecture: {
    label: "system architecture",
    instruction:
      "The proposal is a system or architecture design. Prefer COUNTER_EXAMPLE and LOGICAL_PROOF: describe the scenario or interleaving that breaks a stated guarantee.",
  },
  idea: {
    label: "product idea",
    instruction:
      "The proposal is a product or business idea. Prefer COUNTER_EXAMPLE and LOGICAL_PROOF: name the concrete user, market, or assumption that falsifies the claim.",
  },
  plan: {
    label: "project plan",
    instruction:
      "The proposal is a plan or sequence of work. Prefer LOGICAL_PROOF and BOUNDARY_INPUT: show where the ordering, dependency, or boundary case makes the plan unworkable.",
  },
  logic: {
    label: "argument or reasoning",
    instruction:
      "The proposal is an argument or design rationale. Prefer LOGICAL_PROOF and COUNTER_EXAMPLE: show the premise that fails or the case the conclusion misses.",
  },
});

// Fields that reveal who produced the proposal. Removed before the proposal
// reaches an attacker so the judgment is of the work, not its author.
const IDENTITY_FIELDS = ["model", "modelId", "author", "authorId", "provider", "createdBy", "agent"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripIdentity(proposal) {
  if (!isPlainObject(proposal)) return {};
  const clone = { ...proposal };
  for (const key of IDENTITY_FIELDS) delete clone[key];
  return clone;
}

/**
 * Build the isolated prompt for one attacker.
 *
 * @param {object} input
 * @param {object} input.proposal  the proposal under attack (identity stripped)
 * @param {string} input.vector    one of ATTACK_VECTOR
 * @param {string} [input.domain]  code | architecture | idea | plan | logic
 * @returns {string}
 */
export function buildCruciblePrompt({ proposal, vector, domain = "code" } = {}) {
  const spec = ATTACK_VECTOR_SPECS[vector];
  if (!spec) throw new Error(`unknown attack vector "${vector}"`);
  const domainSpec = DOMAIN_SPECS[domain] ?? DOMAIN_SPECS.code;
  const target = stripIdentity(proposal);
  const proposalId = proposal?.id ?? proposal?.proposalId ?? "unknown";

  return [
    `ATTACK PERSPECTIVE: ${spec.label} (${vector})`,
    `Focus exclusively on: ${spec.focus}.`,
    `A convincing proof for this perspective looks like: ${spec.sampleProof}.`,
    "",
    `DOMAIN: ${domainSpec.label}.`,
    domainSpec.instruction,
    "",
    `TARGET PROPOSAL (id: ${proposalId}):`,
    JSON.stringify(target, null, 2),
    "",
    `Return one JSON attack report with attacker_perspective "${vector}", target_proposal_id "${proposalId}", and schema_version ${CRUCIBLE_SCHEMA_VERSION}.`,
    "If the proposal withstands your attack, return verdict PASS with an empty findings array and say why in summary.",
  ].join("\n");
}

function extractBalancedObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseAttackJson(text) {
  const source = typeof text === "string" ? text : "";
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const slice = extractBalancedObject(body);
  if (slice === null) return { ok: false, error: "no JSON object found in attack output" };
  try {
    const value = JSON.parse(slice);
    if (!isPlainObject(value)) return { ok: false, error: "attack output is not a JSON object" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `attack output is not valid JSON: ${err.message}` };
  }
}

/**
 * Run one attacker against one proposal and validate its report.
 *
 * A malformed attack (transport error, non-JSON, schema violation) is recorded
 * as an INVALID_ATTACK entry rather than thrown, so a stage examining several
 * proposals and several vectors loses at most one lens and can still report the
 * rest -- and can report that it lost one.
 */
async function runOneAttack({ proposal, proposalId, vector, domain, completeFn, modelId, config, opts }) {
  const prompt = buildCruciblePrompt({ proposal, vector, domain });
  let text;
  try {
    const response = await completeFn(config, modelId, prompt, {
      ...opts,
      system: opts.system ?? CRUCIBLE_SYSTEM_PROMPT,
    });
    text = response?.text ?? response?.output ?? "";
  } catch (err) {
    return { ok: false, vector, entry: { vector, verdict: INVALID_ATTACK, errors: [err.message] } };
  }
  const parsed = parseAttackJson(text);
  if (!parsed.ok) {
    return { ok: false, vector, entry: { vector, verdict: INVALID_ATTACK, errors: [parsed.error] } };
  }
  const check = validateCrucibleReport(parsed.value);
  if (!check.valid) {
    return { ok: false, vector, entry: { vector, verdict: INVALID_ATTACK, errors: check.errors } };
  }
  // Redact before the report leaves this module: an attacker quoting a secret
  // from the proposal back at us must not carry it into downstream state.
  return { ok: true, vector, report: redactDeep(parsed.value) };
}

/**
 * Cross-examine one proposal across the requested attack vectors.
 *
 * @param {object} input
 * @param {object}   input.proposal     the proposal under attack
 * @param {Function} input.completeFn   gateway complete(config, modelId, prompt, opts)
 * @param {string[]} [input.vectors]    vectors to run; defaults to all four
 * @param {string}   [input.modelId]    the attacker model (any capable model)
 * @param {object}   [input.config]     passed through to completeFn
 * @param {string}   [input.domain]     code | architecture | idea | plan | logic
 * @param {object}   [input.opts]       { timeoutMs, maxTokens, temperature, system }
 * @returns {Promise<{ ok: boolean, proposalId: string|null, reports: object[], invalid: object[], errors: string[] }>}
 */
export async function runCrossExamination({
  proposal,
  completeFn,
  vectors = null,
  modelId = null,
  config = null,
  domain = "code",
  opts = {},
} = {}) {
  const errors = [];
  if (typeof completeFn !== "function") errors.push("a completeFn() function is required");
  if (!isPlainObject(proposal)) errors.push("a proposal object is required");

  const proposalId = proposal?.id ?? proposal?.proposalId ?? null;
  if (errors.length) return { ok: false, proposalId, reports: [], invalid: [], errors };

  const active = Array.isArray(vectors) && vectors.length > 0 ? vectors : CRUCIBLE_ATTACK_SCHEMA.vectors;

  const reports = [];
  const invalid = [];
  for (const vector of active) {
    if (!ATTACK_VECTOR_SPECS[vector]) {
      invalid.push({ vector, verdict: INVALID_ATTACK, errors: [`unknown attack vector "${vector}"`] });
      continue;
    }
    const outcome = await runOneAttack({
      proposal,
      proposalId,
      vector,
      domain,
      completeFn,
      modelId,
      config,
      opts,
    });
    if (outcome.ok) reports.push(outcome.report);
    else invalid.push(outcome.entry);
  }

  return { ok: invalid.length === 0, proposalId, reports, invalid, errors: [] };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Combine every finding from a proposal's attack reports into one ordered,
 * de-duplicated set, and score the proposal's survival.
 *
 * De-duplication is by severity + vector + title: two attackers converging on
 * the same defect from the same lens should count once, but the same sentence
 * from two different lenses is a stronger signal and is kept as two findings.
 *
 * The survival score starts at 1.0 and subtracts per-finding weight --
 * P0 0.5, P1 0.2, P2 0.05, P3 nothing -- clamped to [0, 1]. A single P0 halves a
 * proposal; two P0s kill it; a pile of P2s barely dents it. That asymmetry is
 * the point: the score answers "did anything critical survive?", not "how many
 * nits were filed?".
 */
export function aggregateCrucibleFindings(reports) {
  const list = Array.isArray(reports) ? reports : [];
  const seen = new Set();
  const findings = [];

  for (const report of list) {
    const { proven } = classifyAttackFindings(report);
    for (const finding of proven) {
      const signature = `${finding.severity}\u0000${finding.vector}\u0000${String(finding.title).trim().toLowerCase()}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      findings.push(finding);
    }
  }

  findings.sort((a, b) => {
    const bySeverity = CRUCIBLE_SEVERITY_RANK[a.severity] - CRUCIBLE_SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return String(a.title).localeCompare(String(b.title));
  });

  const counts = {
    [CRUCIBLE_SEVERITY.P0_CRITICAL]: 0,
    [CRUCIBLE_SEVERITY.P1_MAJOR]: 0,
    [CRUCIBLE_SEVERITY.P2_MINOR]: 0,
    [CRUCIBLE_SEVERITY.P3_INFORMATIONAL]: 0,
    total: findings.length,
  };
  for (const finding of findings) {
    if (counts[finding.severity] !== undefined) counts[finding.severity] += 1;
  }

  const penalty =
    counts[CRUCIBLE_SEVERITY.P0_CRITICAL] * 0.5 +
    counts[CRUCIBLE_SEVERITY.P1_MAJOR] * 0.2 +
    counts[CRUCIBLE_SEVERITY.P2_MINOR] * 0.05;

  return { findings, counts, survivalScore: clamp(1 - penalty, 0, 1) };
}

export default {
  INVALID_ATTACK,
  CRUCIBLE_SYSTEM_PROMPT,
  DOMAIN_SPECS,
  buildCruciblePrompt,
  runCrossExamination,
  aggregateCrucibleFindings,
};
