// Stage 3 -- The Merge: hybrid synthesis.
//
// This module takes the proposals that survived the Crucible, together with the
// P0/P1 findings raised against them, and asks a neutral synthesizer for one
// hybrid. Two things make it a tribunal stage rather than a prompt:
//
//   * The synthesizer is identity-blind. It sees proposal content and the
//     findings, never which model produced what. The prompt assigns anonymous
//     labels (Proposal A, Proposal B, ...) and strips model/author/provider
//     fields, so its choices rest on the work.
//
//   * Its output is a schema, not prose. runMerge parses and validates against
//     MERGE_SCHEMA v1 and, on any failure -- transport, non-JSON, or a report
//     the schema refuses -- returns an INVALID_MERGE result carrying the raw
//     response, never an exception. A synthesizer we cannot read is a result we
//     report, not a crash.

import { redactDeep } from "../redact.js";
import { CRUCIBLE_SEVERITY, CRUCIBLE_SEVERITY_RANK } from "./crucible-schema.js";
import {
  FINDING_RESOLUTION_STATUS,
  MERGE_DECISION,
  MERGE_SCHEMA_VERSION,
  validateMergeReport,
} from "./merge-schema.js";

/** Status on a merge we could not read. Named, so a caller can count losses. */
export const INVALID_MERGE = "INVALID_MERGE";

/** Below this survival score a proposal is too flawed to build on by default. */
export const DEFAULT_MIN_SURVIVAL_SCORE = 0.3;

/** The critical severities a merge is obliged to account for. */
export const CRITICAL_SEVERITIES = Object.freeze([
  CRUCIBLE_SEVERITY.P0_CRITICAL,
  CRUCIBLE_SEVERITY.P1_MAJOR,
]);

/**
 * The synthesizer's system prompt. The schema block is spelled out enum by enum
 * so the model has no room to invent a decision or a resolution status the
 * validator will reject, and the persona is stated as neutral explicitly, since
 * "pick your favourite" is the failure mode this stage exists to avoid.
 */
export const MERGE_SYSTEM_PROMPT = [
  "You are a neutral senior architect in a proposal tribunal. You did not author any proposal in front of you and you owe none of them loyalty.",
  "Your task is to produce ONE hybrid solution that is stronger than any input, using the best elements of each.",
  "You are identity-blind: judge the work, never speculate about who or what produced it.",
  "Take the strongest parts. Where two proposals agree, an element may cite both as its source.",
  "",
  "You MUST account for every P0 and P1 finding you are given. For each, record a findings_resolution entry with:",
  `  status ${FINDING_RESOLUTION_STATUS.ADDRESSED} -- the hybrid contains an element that fixes it, and that element lists the finding id in addresses_findings.`,
  `  status ${FINDING_RESOLUTION_STATUS.ACKNOWLEDGED_UNRESOLVED} -- the hybrid ships anyway and you say plainly why the finding stands.`,
  `  status ${FINDING_RESOLUTION_STATUS.DISPUTED} -- you argue the finding is wrong; explain why in resolution.`,
  "A finding marked DISPUTED or ACKNOWLEDGED_UNRESOLVED must NOT be cited by any element's addresses_findings -- only ADDRESSED findings may be.",
  "",
  "For every distinct element of the hybrid, record provenance: an element_id, the source_proposal_ids it came from (the exact proposal ids shown to you), a rationale, and the finding ids it addresses.",
  "List anything you did not carry forward in discarded_elements, with the source proposal id and a reason.",
  "",
  "Choose the decision:",
  `  ${MERGE_DECISION.SYNTHESIZED} -- you produced a hybrid from multiple proposals.`,
  `  ${MERGE_DECISION.SINGLE_PROPOSAL_RETAINED} -- only one proposal was viable; retain it as-is with its findings addressed.`,
  `  ${MERGE_DECISION.INSUFFICIENT_INPUT} -- every proposal has fatal flaws; produce no hybrid and explain the insufficiency.`,
  `  ${MERGE_DECISION.IRRECONCILABLE} -- the proposals contradict at a fundamental level that cannot be bridged; produce no hybrid and explain why.`,
  `For INSUFFICIENT_INPUT and IRRECONCILABLE, hybrid_solution MUST be null and insufficiency_reason MUST be a non-empty string.`,
  "",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
  `It must have exactly these fields: schema_version (must be ${MERGE_SCHEMA_VERSION}), decision, hybrid_solution, findings_resolution, discarded_elements, synthesis_notes, insufficiency_reason.`,
  "hybrid_solution is either null or { content, elements }, where each element has exactly element_id, source_proposal_ids, rationale, addresses_findings.",
  "Each findings_resolution entry has exactly finding_id, status, resolution.",
  "Each discarded_elements entry has exactly source_proposal_id, element_summary, discard_reason.",
].join("\n");

/**
 * Domain framing for the hybrid. The same synthesizer logic applies to code, a
 * design, an idea, a plan, or an argument; only the noun for "the solution" and
 * what counts as an element change, and this table adapts them.
 */
export const MERGE_DOMAIN_SPECS = Object.freeze({
  code: {
    label: "source code",
    instruction: "Produce a unified code change or implementation. An element is a concrete piece of the solution and may include code.",
  },
  architecture: {
    label: "system architecture",
    instruction: "Produce a unified design. An element is a component, boundary, or data flow decision and its justification.",
  },
  idea: {
    label: "product idea",
    instruction: "Produce a unified concept. An element is a product or go-to-market choice and why it is retained.",
  },
  plan: {
    label: "project plan",
    instruction: "Produce a unified plan. An element is a step or phase and why it is ordered as it is.",
  },
  logic: {
    label: "argument or reasoning",
    instruction: "Produce a unified line of reasoning. An element is a premise or inference and why it holds.",
  },
});

// Fields that reveal who produced a proposal. Removed before synthesis so the
// judgment is of the work, not its author.
const IDENTITY_FIELDS = ["model", "modelId", "author", "authorId", "provider", "createdBy", "agent"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stripIdentity(proposal) {
  if (!isPlainObject(proposal)) return {};
  const clone = { ...proposal };
  for (const key of IDENTITY_FIELDS) delete clone[key];
  return clone;
}

function labelFor(index) {
  return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
}

function proposalIdOf(proposal) {
  const id = proposal?.id ?? proposal?.proposalId;
  return isNonEmptyString(id) ? id : null;
}

/**
 * Build the single synthesis prompt.
 *
 * @param {object} input
 * @param {Array}  input.proposals         surviving proposals
 * @param {Array}  [input.crucibleFindings] P0/P1 findings ({ id, severity, vector, title, ... })
 * @param {string} [input.domain]          code | architecture | idea | plan | logic
 * @returns {string}
 */
export function buildMergePrompt({ proposals = [], crucibleFindings = [], domain = "code" } = {}) {
  const list = Array.isArray(proposals) ? proposals : [];
  const findings = Array.isArray(crucibleFindings) ? crucibleFindings : [];
  const domainSpec = MERGE_DOMAIN_SPECS[domain] ?? MERGE_DOMAIN_SPECS.code;

  const proposalBlocks = list.map((proposal, index) => {
    const label = labelFor(index);
    const id = proposalIdOf(proposal) ?? `unlabeled-${index + 1}`;
    return [
      `### Proposal ${label} (id: ${id})`,
      JSON.stringify(stripIdentity(proposal), null, 2),
    ].join("\n");
  });

  const findingBlocks = findings.map((finding) => {
    const id = finding?.id ?? finding?.finding_id ?? "?";
    const parts = [finding?.severity, finding?.vector].filter(isNonEmptyString);
    const headline = parts.length > 0 ? `${parts.join(" / ")}` : "finding";
    const title = isNonEmptyString(finding?.title) ? finding.title : "(untitled)";
    const against = isNonEmptyString(finding?.proposal_id) ? ` [raised against proposal ${finding.proposal_id}]` : "";
    const detail = isNonEmptyString(finding?.explanation) ? ` -- ${finding.explanation}` : "";
    return `- ${id} (${headline})${against}: ${title}${detail}`;
  });

  return [
    `DOMAIN: ${domainSpec.label}.`,
    domainSpec.instruction,
    "",
    `You have been handed ${list.length} proposal${list.length === 1 ? "" : "s"} that survived external cross-examination.`,
    "Each is labelled anonymously. Strip author identity entirely; use the exact ids shown for provenance.",
    "",
    "## Proposals",
    ...(proposalBlocks.length > 0 ? proposalBlocks : ["(none)"]),
    "",
    "## Critical findings to account for (P0 = fatal, P1 = major)",
    ...(findingBlocks.length > 0 ? findingBlocks : ["(none)"]),
    "",
    "Produce the hybrid now, as one JSON object conforming to the schema in your instructions.",
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

function parseMergeJson(text) {
  const source = typeof text === "string" ? text : "";
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const slice = extractBalancedObject(body);
  if (slice === null) return { ok: false, error: "no JSON object found in merge output" };
  try {
    const value = JSON.parse(slice);
    if (!isPlainObject(value)) return { ok: false, error: "merge output is not a JSON object" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `merge output is not valid JSON: ${err.message}` };
  }
}

/**
 * Run one synthesis.
 *
 * @param {object} input
 * @param {Array}    input.proposals
 * @param {Array}    [input.crucibleFindings]
 * @param {Function} input.completeFn        gateway complete(config, modelId, prompt, opts)
 * @param {string}   [input.modelId]
 * @param {object}   [input.options]         { config, domain, opts: { timeoutMs, maxTokens, temperature, system }, now }
 * @returns {Promise<
 *   { status: "OK", report: object, modelId: string|null, elapsed_ms: number } |
 *   { status: "INVALID_MERGE", rawResponse: string|null, errors: string[], modelId: string|null, elapsed_ms: number }
 * >}
 */
export async function runMerge({
  proposals = [],
  crucibleFindings = [],
  completeFn,
  modelId = null,
  options = {},
} = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const began = now();

  const errors = [];
  if (typeof completeFn !== "function") errors.push("a completeFn() function is required");
  if (!Array.isArray(proposals)) errors.push("proposals must be an array");

  const list = Array.isArray(proposals) ? proposals : [];
  const proposalIds = list.map(proposalIdOf).filter((id) => id !== null);
  const domain = options.domain ?? "code";

  const invalid = (rawResponse, errorList) => ({
    status: INVALID_MERGE,
    rawResponse: rawResponse ?? null,
    errors: errorList,
    modelId,
    elapsed_ms: Math.max(0, now() - began),
  });

  if (errors.length > 0) return invalid(null, errors);

  const prompt = buildMergePrompt({ proposals: list, crucibleFindings, domain });

  let text;
  try {
    const response = await completeFn(options.config ?? null, modelId, prompt, {
      ...(options.opts ?? {}),
      system: options.opts?.system ?? MERGE_SYSTEM_PROMPT,
    });
    text = response?.text ?? response?.output ?? "";
  } catch (err) {
    return invalid(null, [`completion failed: ${err.message}`]);
  }

  const parsed = parseMergeJson(text);
  if (!parsed.ok) return invalid(text, [parsed.error]);

  const check = validateMergeReport(parsed.value, proposalIds);
  if (!check.valid) return invalid(text, check.errors);

  // Redact before the report leaves the module: a synthesizer quoting a secret
  // from a proposal must not carry it into downstream state.
  return {
    status: "OK",
    report: redactDeep(parsed.value),
    modelId,
    elapsed_ms: Math.max(0, now() - began),
  };
}

function findingsOfResult(result) {
  if (Array.isArray(result?.aggregatedFindings)) return result.aggregatedFindings;
  const reports = Array.isArray(result?.reports) ? result.reports : [];
  const flat = [];
  for (const report of reports) {
    if (Array.isArray(report?.findings)) flat.push(...report.findings);
  }
  return flat;
}

/**
 * Pull every P0/P1 finding out of a Crucible stage result, flattened and
 * tagged with the proposal it was raised against.
 *
 * @param {object} crucibleStageResult  the object runCrucibleStage() returned
 * @returns {Array<object>}  findings, each with an added `proposal_id`
 */
export function extractCriticalFindings(crucibleStageResult) {
  const results = Array.isArray(crucibleStageResult?.results) ? crucibleStageResult.results : [];
  const critical = new Set(CRITICAL_SEVERITIES);
  const found = [];

  for (const result of results) {
    const proposalId = result?.proposalId ?? result?.proposal_id ?? null;
    for (const finding of findingsOfResult(result)) {
      if (!critical.has(finding?.severity)) continue;
      found.push({ ...finding, proposal_id: proposalId });
    }
  }

  found.sort((a, b) => {
    const bySeverity = (CRUCIBLE_SEVERITY_RANK[a.severity] ?? 99) - (CRUCIBLE_SEVERITY_RANK[b.severity] ?? 99);
    if (bySeverity !== 0) return bySeverity;
    return String(a.title ?? "").localeCompare(String(b.title ?? ""));
  });

  return found;
}

/**
 * Decide whether a merge is worth attempting, from the Crucible's survival
 * scores alone. This is the gate the stage reads before spending a model call.
 *
 * @param {object} crucibleStageResult
 * @param {object} [options]
 * @param {number} [options.minSurvivalScore=0.3]
 * @returns {{ attempt: boolean, reason: string, viableProposalIds: string[], threshold: number }}
 */
export function shouldAttemptMerge(crucibleStageResult, options = {}) {
  const threshold = typeof options.minSurvivalScore === "number" ? options.minSurvivalScore : DEFAULT_MIN_SURVIVAL_SCORE;
  const results = Array.isArray(crucibleStageResult?.results) ? crucibleStageResult.results : [];

  const viableProposalIds = [];
  for (const result of results) {
    const score = typeof result?.survivalScore === "number" ? result.survivalScore : 0;
    if (score >= threshold) viableProposalIds.push(result?.proposalId ?? result?.proposal_id ?? null);
  }

  if (viableProposalIds.length === 0) {
    return { attempt: false, reason: "All proposals below survival threshold", viableProposalIds, threshold };
  }
  if (viableProposalIds.length === 1) {
    return { attempt: true, reason: "Single viable proposal — will retain", viableProposalIds, threshold };
  }
  return { attempt: true, reason: "Multiple viable proposals — will synthesize", viableProposalIds, threshold };
}

export default {
  INVALID_MERGE,
  DEFAULT_MIN_SURVIVAL_SCORE,
  CRITICAL_SEVERITIES,
  MERGE_SYSTEM_PROMPT,
  MERGE_DOMAIN_SPECS,
  buildMergePrompt,
  runMerge,
  extractCriticalFindings,
  shouldAttemptMerge,
};
