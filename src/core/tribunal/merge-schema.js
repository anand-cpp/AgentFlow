// Merge schema (v1): the shape of a hybrid synthesis.
//
// Stage 2 (the Crucible) left us with proposals and a set of falsifiable
// findings against them. Stage 3 (the Merge) must produce *one* hybrid from
// those survivors -- and, because the whole point of the tribunal is that a
// claim can be checked, that hybrid has to be auditable. Auditable here means
// two concrete things, and this module is where they are enforced:
//
//   * Provenance. Every distinct part of the hybrid names the proposal(s) it
//     came from. An element that cites a proposal we were never handed is not
//     provenance, it is a fabrication, so it is rejected.
//
//   * Finding closure. Every P0/P1 finding the Crucible raised must end up
//     either addressed by a committed element or explicitly acknowledged as
//     unresolved. The sharp edge is DISPUTED: a finding the synthesizer argues
//     against cannot also be cited by an element as *addressed*. Those two
//     statements cannot both be true, so the validator refuses the report that
//     makes both.
//
// The style mirrors review-schema.js and crucible-schema.js deliberately: a
// closed vocabulary, a fail-closed non-throwing validator, and belt-and-braces
// classifiers that a caller can use without running the validator first.

export const MERGE_SCHEMA_VERSION = 1;

/**
 * What the synthesizer concluded about the set of proposals it was handed.
 *
 * There is no "pick the best one and forget the rest" outcome except
 * SINGLE_PROPOSAL_RETAINED, which still forces the retained proposal's findings
 * to be accounted for. Silence about a proposal is not a decision.
 */
export const MERGE_DECISION = {
  SYNTHESIZED: "SYNTHESIZED",
  INSUFFICIENT_INPUT: "INSUFFICIENT_INPUT",
  SINGLE_PROPOSAL_RETAINED: "SINGLE_PROPOSAL_RETAINED",
  IRRECONCILABLE: "IRRECONCILABLE",
};

/** The decisions that produce a hybrid, and so require `hybrid_solution`. */
export const MERGE_DECISIONS_WITH_HYBRID = Object.freeze([
  MERGE_DECISION.SYNTHESIZED,
  MERGE_DECISION.SINGLE_PROPOSAL_RETAINED,
]);

/** The decisions that produce no hybrid, and so require `insufficiency_reason`. */
export const MERGE_DECISIONS_WITHOUT_HYBRID = Object.freeze([
  MERGE_DECISION.INSUFFICIENT_INPUT,
  MERGE_DECISION.IRRECONCILABLE,
]);

/**
 * How a Crucible finding was closed out.
 *
 * ADDRESSED is the only status an element may cite. A finding can be
 * ACKNOWLEDGED_UNRESOLVED -- shipped anyway, on the record -- and it can be
 * DISPUTED -- argued to be wrong -- but neither of those is the same as having
 * fixed it, and the schema keeps them apart.
 */
export const FINDING_RESOLUTION_STATUS = {
  ADDRESSED: "ADDRESSED",
  ACKNOWLEDGED_UNRESOLVED: "ACKNOWLEDGED_UNRESOLVED",
  DISPUTED: "DISPUTED",
};

// The closed field lists. Exported so a prompt builder, a fixture, and the
// validator share one source of truth and cannot drift apart.
export const MERGE_FIELDS = Object.freeze([
  "schema_version",
  "decision",
  "hybrid_solution",
  "findings_resolution",
  "discarded_elements",
  "synthesis_notes",
  "insufficiency_reason",
]);

export const ELEMENT_FIELDS = Object.freeze([
  "element_id",
  "source_proposal_ids",
  "rationale",
  "addresses_findings",
]);

export const RESOLUTION_FIELDS = Object.freeze([
  "finding_id",
  "status",
  "resolution",
]);

export const DISCARDED_FIELDS = Object.freeze([
  "source_proposal_id",
  "element_summary",
  "discard_reason",
]);

export const HYBRID_FIELDS = Object.freeze(["content", "elements"]);

const DECISIONS = new Set(Object.values(MERGE_DECISION));
const HYBRID_DECISIONS = new Set(MERGE_DECISIONS_WITH_HYBRID);
const RESOLUTION_STATUSES = new Set(Object.values(FINDING_RESOLUTION_STATUS));
const MERGE_FIELD_SET = new Set(MERGE_FIELDS);
const ELEMENT_FIELD_SET = new Set(ELEMENT_FIELDS);
const RESOLUTION_FIELD_SET = new Set(RESOLUTION_FIELDS);
const DISCARDED_FIELD_SET = new Set(DISCARDED_FIELDS);
const HYBRID_FIELD_SET = new Set(HYBRID_FIELDS);

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

function addStringList(errors, value, where) {
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array of strings`);
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) errors.push(`${where}[${index}] must be a non-empty string`);
  });
}

/**
 * Validate one merge report. Fail-closed and non-throwing: a synthesizer that
 * returns nonsense must be reported as nonsense, not thrown past a stage trying
 * to record it.
 *
 * @param {object} report
 * @param {string[]} [inputProposalIds]  ids of the proposals handed to the merge.
 *   Provenance is checked against exactly this set -- an element citing anything
 *   else is rejected. Pass `[]` (the default) to validate shape only when no
 *   proposals are in scope, in which case any element that cites a source is an
 *   error, because it cannot have come from an empty input.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateMergeReport(report, inputProposalIds = []) {
  const errors = [];
  if (!isPlainObject(report)) return { valid: false, errors: ["merge report must be an object"] };

  const known = Array.isArray(inputProposalIds) ? new Set(inputProposalIds) : new Set();

  addUnknownFields(errors, report, MERGE_FIELD_SET, "");

  if (report.schema_version !== MERGE_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MERGE_SCHEMA_VERSION}`);
  }
  if (!DECISIONS.has(report.decision)) {
    errors.push(`decision must be one of ${[...DECISIONS].join(", ")}`);
  }
  if (!isNonEmptyString(report.synthesis_notes)) {
    errors.push("synthesis_notes must be a non-empty string");
  }

  // insufficiency_reason is typed as string|null everywhere; require the non-empty
  // string only for the decisions that actually need it, so a SYNTHESIZED report
  // may carry null (or omit it, which reads as null).
  if (report.insufficiency_reason !== undefined && report.insufficiency_reason !== null && !isNonEmptyString(report.insufficiency_reason)) {
    errors.push("insufficiency_reason must be a non-empty string or null");
  }
  if (report.decision === MERGE_DECISION.INSUFFICIENT_INPUT || report.decision === MERGE_DECISION.IRRECONCILABLE) {
    if (!isNonEmptyString(report.insufficiency_reason)) {
      errors.push("insufficiency_reason is required when decision is INSUFFICIENT_INPUT or IRRECONCILABLE");
    }
  }

  // Findings resolution first: the element check needs its ADDRESSED set.
  const addressed = new Set();
  const resolutionIds = new Set();
  if (!Array.isArray(report.findings_resolution)) {
    errors.push("findings_resolution must be an array");
  } else {
    report.findings_resolution.forEach((entry, index) => {
      const where = `findings_resolution[${index}].`;
      if (!isPlainObject(entry)) {
        errors.push(`findings_resolution[${index}] must be an object`);
        return;
      }
      addUnknownFields(errors, entry, RESOLUTION_FIELD_SET, where);
      if (!isNonEmptyString(entry.finding_id)) {
        errors.push(`${where}finding_id must be a non-empty string`);
      } else if (resolutionIds.has(entry.finding_id)) {
        errors.push(`${where}finding_id "${entry.finding_id}" is resolved more than once`);
      } else {
        resolutionIds.add(entry.finding_id);
      }
      if (!RESOLUTION_STATUSES.has(entry.status)) {
        errors.push(`${where}status must be one of ${[...RESOLUTION_STATUSES].join(", ")}`);
      }
      if (!isNonEmptyString(entry.resolution)) {
        errors.push(`${where}resolution must be a non-empty string`);
      }
      if (entry.status === FINDING_RESOLUTION_STATUS.ADDRESSED && isNonEmptyString(entry.finding_id)) {
        addressed.add(entry.finding_id);
      }
    });
  }

  // The hybrid itself, and the presence invariant that keys off the decision.
  const requiresHybrid = HYBRID_DECISIONS.has(report.decision);
  const hasHybrid = isPlainObject(report.hybrid_solution);

  if (requiresHybrid && !hasHybrid) {
    errors.push(`hybrid_solution is required when decision is ${report.decision}`);
  }
  if (!requiresHybrid && report.hybrid_solution !== null && report.hybrid_solution !== undefined) {
    errors.push(`hybrid_solution must be null when decision is ${report.decision}`);
  }

  if (report.hybrid_solution !== null && report.hybrid_solution !== undefined && !isPlainObject(report.hybrid_solution)) {
    errors.push("hybrid_solution must be an object or null");
  }

  if (hasHybrid) {
    addUnknownFields(errors, report.hybrid_solution, HYBRID_FIELD_SET, "hybrid_solution.");
    if (!isNonEmptyString(report.hybrid_solution.content)) {
      errors.push("hybrid_solution.content must be a non-empty string");
    }
    if (!Array.isArray(report.hybrid_solution.elements)) {
      errors.push("hybrid_solution.elements must be an array");
    } else {
      const elementIds = new Set();
      report.hybrid_solution.elements.forEach((element, index) => {
        const where = `hybrid_solution.elements[${index}].`;
        if (!isPlainObject(element)) {
          errors.push(`hybrid_solution.elements[${index}] must be an object`);
          return;
        }
        addUnknownFields(errors, element, ELEMENT_FIELD_SET, where);

        if (!isNonEmptyString(element.element_id)) {
          errors.push(`${where}element_id must be a non-empty string`);
        } else if (elementIds.has(element.element_id)) {
          errors.push(`${where}element_id "${element.element_id}" is used more than once`);
        } else {
          elementIds.add(element.element_id);
        }
        if (!isNonEmptyString(element.rationale)) {
          errors.push(`${where}rationale must be a non-empty string`);
        }

        addStringList(errors, element.source_proposal_ids, `${where}source_proposal_ids`);
        if (Array.isArray(element.source_proposal_ids)) {
          element.source_proposal_ids.forEach((proposalId, i) => {
            if (isNonEmptyString(proposalId) && !known.has(proposalId)) {
              errors.push(`${where}source_proposal_ids[${i}] "${proposalId}" is not one of the input proposals`);
            }
          });
        }

        // The load-bearing closure rule: an element may only claim to address a
        // finding that the resolution list marks ADDRESSED.
        addStringList(errors, element.addresses_findings, `${where}addresses_findings`);
        if (Array.isArray(element.addresses_findings)) {
          element.addresses_findings.forEach((findingId, i) => {
            if (!isNonEmptyString(findingId)) return;
            if (!resolutionIds.has(findingId)) {
              errors.push(`${where}addresses_findings[${i}] "${findingId}" is not in findings_resolution`);
            } else if (!addressed.has(findingId)) {
              errors.push(`${where}addresses_findings[${i}] "${findingId}" is not marked ADDRESSED in findings_resolution`);
            }
          });
        }
      });
    }
  }

  if (!Array.isArray(report.discarded_elements)) {
    errors.push("discarded_elements must be an array");
  } else {
    report.discarded_elements.forEach((entry, index) => {
      const where = `discarded_elements[${index}].`;
      if (!isPlainObject(entry)) {
        errors.push(`discarded_elements[${index}] must be an object`);
        return;
      }
      addUnknownFields(errors, entry, DISCARDED_FIELD_SET, where);
      if (!isNonEmptyString(entry.source_proposal_id)) {
        errors.push(`${where}source_proposal_id must be a non-empty string`);
      }
      if (!isNonEmptyString(entry.element_summary)) {
        errors.push(`${where}element_summary must be a non-empty string`);
      }
      if (!isNonEmptyString(entry.discard_reason)) {
        errors.push(`${where}discard_reason must be a non-empty string`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return the P0/P1 findings a merge report fails to close out.
 *
 * Validation does not *require* every critical finding to appear in
 * findings_resolution -- a synthesizer working from a subset, or a report
 * assembled before the findings list is final, is still structurally valid. But
 * an auditor wants the gap named, so this reports the findings the report was
 * handed that it neither addressed nor acknowledged. Finding ids are read from
 * whatever the caller passes as `criticalFindings` ({ id } or { finding_id }).
 *
 * @param {object} report
 * @param {Array}  criticalFindings  findings the merge was expected to account for
 * @returns {{ unresolved: string[], resolved: string[] }}
 */
export function findUnresolvedCriticalFindings(report, criticalFindings = []) {
  const expected = [];
  for (const finding of Array.isArray(criticalFindings) ? criticalFindings : []) {
    const id = finding?.id ?? finding?.finding_id;
    if (isNonEmptyString(id)) expected.push(id);
  }
  const resolvedIds = new Set();
  for (const entry of Array.isArray(report?.findings_resolution) ? report.findings_resolution : []) {
    if (isNonEmptyString(entry?.finding_id)) resolvedIds.add(entry.finding_id);
  }
  const unresolved = expected.filter((id) => !resolvedIds.has(id));
  const resolved = expected.filter((id) => resolvedIds.has(id));
  return { unresolved, resolved };
}

export default {
  MERGE_SCHEMA_VERSION,
  MERGE_DECISION,
  MERGE_DECISIONS_WITH_HYBRID,
  MERGE_DECISIONS_WITHOUT_HYBRID,
  FINDING_RESOLUTION_STATUS,
  MERGE_FIELDS,
  ELEMENT_FIELDS,
  RESOLUTION_FIELDS,
  DISCARDED_FIELDS,
  HYBRID_FIELDS,
  validateMergeReport,
  findUnresolvedCriticalFindings,
};
