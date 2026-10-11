// Trial schema (v1): adversarial review of a *merge*.
//
// Stage 2 (the Crucible) attacked individual proposals. Stage 4 (the Trial)
// attacks the hybrid those proposals were merged into -- and it attacks it for
// a different class of defect. The failure it exists to catch is
// synthesis-induced: a flaw that lives in the seam *between* two good
// proposals, or one the synthesizer introduced while combining them. Neither
// input proposal is guilty of it, so no per-proposal review could ever have
// found it. That is why the vectors here are new rather than a reuse of the
// Crucible's four.
//
// Two rules carry over verbatim from the earlier schemas, because they are the
// ones that stop a report from lying:
//
//   * Closed vocabulary. An unknown vector, verdict, severity, or field is a
//     typo the validator refuses where the mistake is made.
//
//   * A finding is not falsifiable without proof. An empty
//     falsifiable_proof.payload is invalid, not a low-severity note.
//
// And one rule is new. A CONVICTED verdict without a critical finding is
// incoherent -- you cannot convict a merge of nothing -- and an ACQUITTED
// verdict that carries a P0 is the exact laundering this stage exists to
// prevent. So the verdict and the findings' severities must agree, and the
// validator holds both ends of that agreement.

import { CRUCIBLE_SEVERITY, PROOF_KIND } from "./crucible-schema.js";

export const TRIAL_SCHEMA_VERSION = 1;

/**
 * The attack vectors the Trial adds. Each names a way a merge can be worse than
 * every proposal that fed it.
 */
export const TRIAL_VECTOR = {
  INTEGRATION_SEAM: "INTEGRATION_SEAM",
  FINDING_REGRESSION: "FINDING_REGRESSION",
  PROVENANCE_VIOLATION: "PROVENANCE_VIOLATION",
  ARCHITECTURAL_DRIFT: "ARCHITECTURAL_DRIFT",
  SCOPE_INFLATION: "SCOPE_INFLATION",
};

/**
 * What the Trial concluded.
 *
 * ACQUITTED and the two CONVICTED verdicts are outcomes of a successful trial.
 * MISTRIAL is not a judgement about the merge at all -- it is the trial failing
 * to render one (unreadable output, a transport error) -- and is kept distinct
 * so a pipeline never mistakes "we could not judge" for "it is fine".
 */
/** @type {{ ACQUITTED: "ACQUITTED", CONVICTED_RETRY: "CONVICTED_RETRY", CONVICTED_FINAL: "CONVICTED_FINAL", MISTRIAL: "MISTRIAL" }} */
export const TRIAL_VERDICT = {
  ACQUITTED: "ACQUITTED",
  CONVICTED_RETRY: "CONVICTED_RETRY",
  CONVICTED_FINAL: "CONVICTED_FINAL",
  MISTRIAL: "MISTRIAL",
};

/** Severity is the Crucible's, re-exported so the tribunal shares one scale. */
export const SEVERITY = CRUCIBLE_SEVERITY;

/** The severities that make a finding critical enough to convict. */
export const CRITICAL_SEVERITIES = Object.freeze([SEVERITY.P0_CRITICAL, SEVERITY.P1_MAJOR]);

/** Proof kinds, re-exported from the Crucible so the tribunal shares one set. */
export { PROOF_KIND };

/**
 * Per-vector framing, shared by the prompt builder and available to callers
 * that want to explain a vector. `description` is the substance.
 */
export const TRIAL_VECTOR_SPECS = Object.freeze({
  [TRIAL_VECTOR.INTEGRATION_SEAM]: {
    label: "Integration Seam",
    description:
      "elements drawn from different sources that conflict when combined -- e.g. one proposal's locking and another's lock-free approach deadlocking when placed side by side",
  },
  [TRIAL_VECTOR.FINDING_REGRESSION]: {
    label: "Finding Regression",
    description:
      "a P0/P1 Crucible finding marked ADDRESSED that the merged solution actually reintroduces -- resolved on paper, present in fact",
  },
  [TRIAL_VECTOR.PROVENANCE_VIOLATION]: {
    label: "Provenance Violation",
    description:
      "an element that claims a source it does not match, or that was materially altered without being recorded as transformed",
  },
  [TRIAL_VECTOR.ARCHITECTURAL_DRIFT]: {
    label: "Architectural Drift",
    description:
      "an architectural flaw in the merged solution that exists in no input proposal -- the merge is worse than everything it came from",
  },
  [TRIAL_VECTOR.SCOPE_INFLATION]: {
    label: "Scope Inflation",
    description:
      "features or complexity the merge added that appear in no input proposal -- the synthesizer hallucinated requirements",
  },
});

// The closed field lists. Exported so the prompt builder, fixtures, and the
// validator share one source of truth.
export const TRIAL_FIELDS = Object.freeze([
  "schema_version",
  "verdict",
  "findings",
  "prosecution_summary",
  "recommended_retry_focus",
]);

export const TRIAL_FINDING_FIELDS = Object.freeze([
  "id",
  "severity",
  "vector",
  "title",
  "explanation",
  "affected_element_ids",
  "regression_of",
  "falsifiable_proof",
]);

export const TRIAL_PROOF_FIELDS = Object.freeze(["kind", "payload"]);

/**
 * The schema as data. Callers read allowed values from here rather than
 * re-listing them, so the set cannot silently desync from the validator.
 */
export const TRIAL_SCHEMA = Object.freeze({
  schema_version: TRIAL_SCHEMA_VERSION,
  report_fields: TRIAL_FIELDS,
  finding_fields: TRIAL_FINDING_FIELDS,
  proof_fields: TRIAL_PROOF_FIELDS,
  vectors: Object.freeze(Object.values(TRIAL_VECTOR)),
  severities: Object.freeze(Object.values(SEVERITY)),
  verdicts: Object.freeze(Object.values(TRIAL_VERDICT)),
  proof_kinds: Object.freeze(Object.values(PROOF_KIND)),
});

const VECTORS = new Set(TRIAL_SCHEMA.vectors);
const SEVERITIES = new Set(TRIAL_SCHEMA.severities);
const VERDICTS = new Set(TRIAL_SCHEMA.verdicts);
const PROOF_KINDS = new Set(TRIAL_SCHEMA.proof_kinds);
const CRITICAL = new Set(CRITICAL_SEVERITIES);
const REPORT_FIELD_SET = new Set(TRIAL_FIELDS);
const FINDING_FIELD_SET = new Set(TRIAL_FINDING_FIELDS);
const PROOF_FIELD_SET = new Set(TRIAL_PROOF_FIELDS);

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

/**
 * Work out which element ids and finding ids a trial report is allowed to cite.
 *
 * The second argument to validateTrialReport is a merge report, because that is
 * the object a trial is always run against and it carries both sets the
 * validator needs: its `hybrid_solution.elements` are the element ids a finding
 * may implicate, and its `findings_resolution` lists the Crucible finding ids it
 * answered -- the set a FINDING_REGRESSION may point back at. A caller that has
 * the raw Crucible findings (rather than, or in addition to, a merge report) may
 * pass them as `options.crucibleFindings` and they are merged into the known
 * finding set. Passing either as a context object
 * (`{ mergeReport | merge_report, crucibleFindings | crucible_findings }`) also
 * works, for callers that hold both under different names.
 */
function resolveContext(mergeReport, options) {
  let merge = mergeReport;
  let crucibleFindings = options.crucibleFindings ?? [];

  if (isPlainObject(mergeReport) && (mergeReport.mergeReport || mergeReport.merge_report)) {
    merge = mergeReport.mergeReport ?? mergeReport.merge_report;
    crucibleFindings = mergeReport.crucibleFindings ?? mergeReport.crucible_findings ?? crucibleFindings;
  }

  const elementIds = new Set();
  const findingIds = new Set();
  if (isPlainObject(merge)) {
    const elements = merge.hybrid_solution?.elements;
    if (Array.isArray(elements)) {
      for (const element of elements) {
        if (isNonEmptyString(element?.element_id)) elementIds.add(element.element_id);
      }
    }
    if (Array.isArray(merge.findings_resolution)) {
      for (const entry of merge.findings_resolution) {
        if (isNonEmptyString(entry?.finding_id)) findingIds.add(entry.finding_id);
      }
    }
  }
  for (const finding of Array.isArray(crucibleFindings) ? crucibleFindings : []) {
    const id = finding?.id ?? finding?.finding_id;
    if (isNonEmptyString(id)) findingIds.add(id);
  }

  return {
    elementIds,
    findingIds,
    // The element-membership check only bites when we actually have a merge with
    // elements to check against; shape-only validation (no merge) must not
    // invent a constraint.
    hasElements: elementIds.size > 0,
  };
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
  // The load-bearing rule shared with the Crucible: a finding without a proof
  // payload is an opinion, and the Trial does not convict on opinions.
  if (!isNonEmptyString(proof.payload)) {
    errors.push(`${where}falsifiable_proof.payload must be a non-empty string`);
  }
}

function addFinding(errors, finding, index, context, seenIds) {
  const where = `findings[${index}].`;
  if (!isPlainObject(finding)) {
    errors.push(`findings[${index}] must be an object`);
    return;
  }
  addUnknownFields(errors, finding, FINDING_FIELD_SET, where);

  if (!isNonEmptyString(finding.id)) {
    errors.push(`${where}id must be a non-empty string`);
  } else if (seenIds.has(finding.id)) {
    errors.push(`${where}id "${finding.id}" is used more than once`);
  } else {
    seenIds.add(finding.id);
  }

  if (!SEVERITIES.has(finding.severity)) {
    errors.push(`${where}severity must be one of ${[...SEVERITIES].join(", ")}`);
  }
  if (!VECTORS.has(finding.vector)) {
    errors.push(`${where}vector must be one of ${[...VECTORS].join(", ")}`);
  }
  if (!isNonEmptyString(finding.title)) errors.push(`${where}title must be a non-empty string`);
  if (!isNonEmptyString(finding.explanation)) errors.push(`${where}explanation must be a non-empty string`);

  // affected_element_ids must name real elements of the merge, when we have a
  // merge to check against.
  const affected = finding.affected_element_ids;
  if (!Array.isArray(affected)) {
    errors.push(`${where}affected_element_ids must be an array of strings`);
  } else {
    affected.forEach((elementId, i) => {
      if (!isNonEmptyString(elementId)) {
        errors.push(`${where}affected_element_ids[${i}] must be a non-empty string`);
        return;
      }
      if (context.hasElements && !context.elementIds.has(elementId)) {
        errors.push(`${where}affected_element_ids[${i}] "${elementId}" is not an element of the merge report`);
      }
    });
  }

  // regression_of is the link back to the Crucible finding that came back. It is
  // required for FINDING_REGRESSION and must point at a finding the merge
  // actually resolved; for any other vector it is optional but, if present, is
  // held to the same membership check.
  const isRegression = finding.vector === TRIAL_VECTOR.FINDING_REGRESSION;
  if (finding.regression_of !== undefined && finding.regression_of !== null && !isNonEmptyString(finding.regression_of)) {
    errors.push(`${where}regression_of must be a non-empty string or null`);
  }
  if (isRegression && !isNonEmptyString(finding.regression_of)) {
    errors.push(`${where}regression_of is required when vector is FINDING_REGRESSION`);
  }
  if (isNonEmptyString(finding.regression_of) && !context.findingIds.has(finding.regression_of)) {
    errors.push(`${where}regression_of "${finding.regression_of}" is not a finding the merge resolved`);
  }

  addProof(errors, finding.falsifiable_proof, where);
}

/**
 * Validate one trial report. Fail-closed and non-throwing.
 *
 * @param {object} report
 * @param {object} [mergeReport]  the merge under trial; supplies the legal
 *   element ids and resolved finding ids. May also be a context object
 *   ({ mergeReport, crucibleFindings }).
 * @param {object} [options]
 * @param {Array}  [options.crucibleFindings]  raw Crucible findings to widen the
 *   known finding-id set
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTrialReport(report, mergeReport = null, options = {}) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["trial report must be an object"] };

  const context = resolveContext(mergeReport, options ?? {});

  addUnknownFields(errors, report, REPORT_FIELD_SET, "");

  if (report.schema_version !== TRIAL_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${TRIAL_SCHEMA_VERSION}`);
  }
  if (!VERDICTS.has(report.verdict)) {
    errors.push(`verdict must be one of ${[...VERDICTS].join(", ")}`);
  }
  if (!isNonEmptyString(report.prosecution_summary)) {
    errors.push("prosecution_summary must be a non-empty string");
  }
  if (report.recommended_retry_focus !== undefined && report.recommended_retry_focus !== null && !isNonEmptyString(report.recommended_retry_focus)) {
    errors.push("recommended_retry_focus must be a non-empty string or null");
  }

  const findings = report.findings;
  if (!Array.isArray(findings)) {
    errors.push("findings must be an array");
  } else {
    const seenIds = new Set();
    findings.forEach((finding, index) => addFinding(errors, finding, index, context, seenIds));
  }

  const list = Array.isArray(findings) ? findings : [];
  const criticalCount = list.filter((f) => CRITICAL.has(f?.severity)).length;

  // The verdict must agree with the findings. This is where "ACQUITTED" is
  // stopped from hiding a P0, and "CONVICTED" is stopped from resting on nits.
  if (report.verdict === TRIAL_VERDICT.ACQUITTED && criticalCount > 0) {
    errors.push("findings must not contain a P0/P1 when verdict is ACQUITTED");
  }
  if (
    (report.verdict === TRIAL_VERDICT.CONVICTED_RETRY || report.verdict === TRIAL_VERDICT.CONVICTED_FINAL) &&
    criticalCount === 0
  ) {
    errors.push(`findings must contain at least one P0/P1 when verdict is ${report.verdict}`);
  }
  if (report.verdict === TRIAL_VERDICT.CONVICTED_RETRY && !isNonEmptyString(report.recommended_retry_focus)) {
    errors.push("recommended_retry_focus is required when verdict is CONVICTED_RETRY");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return the P0/P1 findings of a validated trial report, ordered P0 first.
 *
 * The classifier in trial.js reads severities directly; this is the convenience
 * accessor for callers that want the critical subset without re-deriving it,
 * and it is severity-agnostic to the report's own verdict on purpose -- the
 * findings are the facts, the verdict is the judgement.
 */
export function criticalTrialFindings(report) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  return findings
    .filter((finding) => CRITICAL.has(finding?.severity))
    .sort((a, b) => rank(a?.severity) - rank(b?.severity));
}

function rank(severity) {
  if (severity === SEVERITY.P0_CRITICAL) return 0;
  if (severity === SEVERITY.P1_MAJOR) return 1;
  if (severity === SEVERITY.P2_MINOR) return 2;
  if (severity === SEVERITY.P3_INFORMATIONAL) return 3;
  return 99;
}

export default {
  TRIAL_SCHEMA_VERSION,
  TRIAL_VECTOR,
  TRIAL_VERDICT,
  SEVERITY,
  CRITICAL_SEVERITIES,
  PROOF_KIND,
  TRIAL_VECTOR_SPECS,
  TRIAL_FIELDS,
  TRIAL_FINDING_FIELDS,
  TRIAL_PROOF_FIELDS,
  TRIAL_SCHEMA,
  validateTrialReport,
  criticalTrialFindings,
};
