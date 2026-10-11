// Crucible attack schema (v1): the shape of one adversarial attack.
//
// Stage 1 (the Forge) asks a model to attack its own proposal. Stage 2 (the
// Crucible) hands a surviving proposal to *specialized* attackers -- Security,
// Logic, Edge Cases, Scalability -- and demands each accusation carry
// falsifiable proof. This module is the contract for those attacks, kept
// separate from any provider so the same validator runs on model output, a test
// double, or a hand-written fixture.
//
// Two commitments mirror review-schema.js deliberately.
//
// Closed vocabulary. `finding.severity = "P4"` or `vector = "STYLE"` is a typo
// that never matches anything downstream, so unknown values and unknown fields
// are rejected where the mistake is rather than three layers away.
//
// An accusation is not "falsifiable" without proof. The whole value of the
// Crucible over an opinion is that a finding can be checked: a failing test
// case, a counter-example, a boundary input, or a logical proof. A finding
// whose `falsifiable_proof.payload` is empty is therefore invalid, not a
// low-severity note -- classifyAttackFindings() refuses to count one even if a
// caller skips validation.

export const CRUCIBLE_SCHEMA_VERSION = 1;

/**
 * The adversarial perspectives a Crucible attack may take.
 *
 * Each is a distinct lens, not a severity: a Security attacker and a
 * Scalability attacker look for different failure classes in the same proposal,
 * and the Crucible runs them as separate, identity-blind examinations so one
 * agent's framing cannot contaminate another's.
 */
export const ATTACK_VECTOR = {
  SECURITY: "SECURITY",
  LOGIC_INTEGRITY: "LOGIC_INTEGRITY",
  EDGE_CASES: "EDGE_CASES",
  SCALABILITY_PERF: "SCALABILITY_PERF",
};

/**
 * How badly a finding damages the proposal.
 *
 * P0 is fatal and P3 is decorative; the survival score in crucible.js weighs
 * them differently, so the set has to be closed and ordered.
 */
export const CRUCIBLE_SEVERITY = {
  P0_CRITICAL: "P0_CRITICAL",
  P1_MAJOR: "P1_MAJOR",
  P2_MINOR: "P2_MINOR",
  P3_INFORMATIONAL: "P3_INFORMATIONAL",
};

/** Sort key for severities: lower is worse. Also drives aggregation ordering. */
export const CRUCIBLE_SEVERITY_RANK = Object.freeze({
  P0_CRITICAL: 0,
  P1_MAJOR: 1,
  P2_MINOR: 2,
  P3_INFORMATIONAL: 3,
});

/**
 * What an attacker concluded about the proposal as a whole.
 *
 * FATAL is not "more findings", it is "this cannot proceed". A single
 * reproducible P0 is enough to return FATAL; that judgement is the attacker's to
 * make, and the fields it must supply are what keep it honest.
 */
export const CRUCIBLE_VERDICT = {
  PASS: "PASS",
  FLAWED: "FLAWED",
  FATAL: "FATAL",
};

/**
 * The kind of falsifiable proof backing a finding.
 *
 * Deliberately domain-agnostic: a failing test case and a counter-example prove
 * things about code, but a boundary input proves things about an interface and a
 * logical proof proves things about an argument or a plan. Every domain maps
 * onto this set, which is why the Crucible can examine ideas as readily as code.
 */
export const PROOF_KIND = {
  TEST_CASE: "TEST_CASE",
  COUNTER_EXAMPLE: "COUNTER_EXAMPLE",
  BOUNDARY_INPUT: "BOUNDARY_INPUT",
  LOGICAL_PROOF: "LOGICAL_PROOF",
};

/**
 * Per-vector framing, shared by the prompt builder and available to callers that
 * want to label or explain a vector. `focus` is the substance; the prompt turns
 * it into an instruction.
 */
export const ATTACK_VECTOR_SPECS = Object.freeze({
  [ATTACK_VECTOR.SECURITY]: {
    label: "Security",
    focus: "vulnerabilities, injection, broken authorization, data leaks, and trust-boundary mistakes",
    sampleProof: "an input string that escapes its intended context, or a step that reaches data it should not",
  },
  [ATTACK_VECTOR.LOGIC_INTEGRITY]: {
    label: "Logic & Integrity",
    focus: "internal contradictions, invalid assumptions, race conditions, and state that drifts from what is claimed",
    sampleProof: "two steps whose combined effect contradicts a stated invariant, or an interleaving that corrupts state",
  },
  [ATTACK_VECTOR.EDGE_CASES]: {
    label: "Edge Cases",
    focus: "null and undefined inputs, empty states, boundary values, malformed input, and timeouts",
    sampleProof: "the smallest or largest input, the empty collection, or the value that is never expected",
  },
  [ATTACK_VECTOR.SCALABILITY_PERF]: {
    label: "Scalability & Performance",
    focus: "quadratic or worse hot paths, memory bloat, blocking I/O, and resource exhaustion",
    sampleProof: "an input size at which work or memory grows faster than the requirement allows",
  },
});

// The closed field lists. Exported so callers, fixtures, and docs share one
// source of truth instead of re-listing the shape and drifting.
export const REPORT_FIELDS = Object.freeze([
  "schema_version",
  "attacker_perspective",
  "target_proposal_id",
  "verdict",
  "findings",
  "summary",
]);

export const FINDING_FIELDS = Object.freeze([
  "id",
  "severity",
  "vector",
  "title",
  "explanation",
  "falsifiable_proof",
]);

export const PROOF_FIELDS = Object.freeze(["kind", "payload"]);

/**
 * The schema as data. Tests, prompt builders, and fixtures read the allowed
 * values from here rather than hard-coding them, so adding a vector or severity
 * is a one-line change that cannot silently desync a validator.
 */
export const CRUCIBLE_ATTACK_SCHEMA = Object.freeze({
  schema_version: CRUCIBLE_SCHEMA_VERSION,
  report_fields: REPORT_FIELDS,
  finding_fields: FINDING_FIELDS,
  proof_fields: PROOF_FIELDS,
  vectors: Object.freeze(Object.values(ATTACK_VECTOR)),
  severities: Object.freeze(Object.values(CRUCIBLE_SEVERITY)),
  verdicts: Object.freeze(Object.values(CRUCIBLE_VERDICT)),
  proof_kinds: Object.freeze(Object.values(PROOF_KIND)),
});

const VECTORS = new Set(CRUCIBLE_ATTACK_SCHEMA.vectors);
const SEVERITIES = new Set(CRUCIBLE_ATTACK_SCHEMA.severities);
const VERDICTS = new Set(CRUCIBLE_ATTACK_SCHEMA.verdicts);
const PROOF_KINDS = new Set(CRUCIBLE_ATTACK_SCHEMA.proof_kinds);
const REPORT_FIELD_SET = new Set(REPORT_FIELDS);
const FINDING_FIELD_SET = new Set(FINDING_FIELDS);
const PROOF_FIELD_SET = new Set(PROOF_FIELDS);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addUnknownFields(errors, object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${where}unknown field "${key}"`);
  }
}

function addProof(errors, proof, where) {
  if (!isPlainObject(proof)) {
    errors.push(`${where}falsifiable_proof must be an object`);
    return;
  }
  addUnknownFields(errors, proof, PROOF_FIELD_SET, `${where}falsifiable_proof.`);
  if (!PROOF_KINDS.has(proof.kind)) {
    errors.push(`${where}falsifiable_proof.kind must be one of ${[...PROOF_KINDS].join(", ")}`);
  }
  // The load-bearing rule: a finding without a proof payload is an opinion, and
  // the Crucible does not accept opinions as findings.
  if (!isNonEmptyString(proof.payload)) {
    errors.push(`${where}falsifiable_proof.payload must be a non-empty string`);
  }
}

function addFinding(errors, finding, index) {
  const where = `findings[${index}].`;
  if (!isPlainObject(finding)) {
    errors.push(`findings[${index}] must be an object`);
    return;
  }
  addUnknownFields(errors, finding, FINDING_FIELD_SET, where);

  if (!isNonEmptyString(finding.id)) errors.push(`${where}id must be a non-empty string`);
  if (!SEVERITIES.has(finding.severity)) {
    errors.push(`${where}severity must be one of ${[...SEVERITIES].join(", ")}`);
  }
  if (!VECTORS.has(finding.vector)) {
    errors.push(`${where}vector must be one of ${[...VECTORS].join(", ")}`);
  }
  if (!isNonEmptyString(finding.title)) errors.push(`${where}title must be a non-empty string`);
  if (!isNonEmptyString(finding.explanation)) errors.push(`${where}explanation must be a non-empty string`);
  addProof(errors, finding.falsifiable_proof, where);
}

/**
 * Validate one Crucible attack report. Fail-closed and non-throwing: a malformed
 * attack must be reported as malformed rather than thrown past a stage that is
 * trying to record it.
 *
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCrucibleReport(report) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["report must be an object"] };

  addUnknownFields(errors, report, REPORT_FIELD_SET, "");

  if (report.schema_version !== CRUCIBLE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${CRUCIBLE_SCHEMA_VERSION}`);
  }
  if (!VECTORS.has(report.attacker_perspective)) {
    errors.push(`attacker_perspective must be one of ${[...VECTORS].join(", ")}`);
  }
  if (!isNonEmptyString(report.target_proposal_id)) {
    errors.push("target_proposal_id must be a non-empty string");
  }
  if (!VERDICTS.has(report.verdict)) {
    errors.push(`verdict must be one of ${[...VERDICTS].join(", ")}`);
  }
  if (!isNonEmptyString(report.summary)) {
    errors.push("summary must be a non-empty string");
  }

  if (!Array.isArray(report.findings)) {
    errors.push("findings must be an array");
  } else {
    report.findings.forEach((finding, index) => addFinding(errors, finding, index));
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Partition findings by whether they carry a usable proof payload.
 *
 * Validation already rejects a finding with no payload. This is the
 * belt-and-braces path for callers handing over unvalidated data: an accusation
 * marked as a finding but carrying no proof lands in `unproven`, never in
 * `proven`.
 */
export function classifyAttackFindings(report) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const proven = [];
  const unproven = [];
  for (const finding of findings) {
    if (isNonEmptyString(finding?.falsifiable_proof?.payload)) proven.push(finding);
    else unproven.push(finding);
  }
  return { proven, unproven };
}

export default {
  CRUCIBLE_SCHEMA_VERSION,
  ATTACK_VECTOR,
  CRUCIBLE_SEVERITY,
  CRUCIBLE_SEVERITY_RANK,
  CRUCIBLE_VERDICT,
  PROOF_KIND,
  ATTACK_VECTOR_SPECS,
  CRUCIBLE_ATTACK_SCHEMA,
  validateCrucibleReport,
  classifyAttackFindings,
};
