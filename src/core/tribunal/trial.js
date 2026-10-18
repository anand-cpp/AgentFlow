// Stage 4 -- The Trial: adversarial review of the merge.
//
// The Crucible attacked proposals; the Trial attacks the thing the proposals
// were merged into. Its failure class is synthesis-induced -- a defect in the
// seam between two individually-fine proposals, or one the synthesizer invented
// while combining them -- so the persona is a prosecutor, the vectors are the
// five from trial-schema.js, and the subject is always the merge.
//
// Two properties are enforced by construction, not by prompt wording:
//
//   * The prosecutor is identity-blind. The merge report and the input proposals
//     are both stripped of model/synthesizer/author fields before they are
//     serialized, so the attack lands on the work, not on whose work it was.
//
//   * An unreadable trial is a MISTRIAL, not an exception. Transport failure,
//     non-JSON, or a report the schema refuses all return a MISTRIAL result
//     carrying the raw response, so "we could not judge" is never mistaken for
//     "it is fine".

import { redactDeep } from "../redact.js";
import {
  CRITICAL_SEVERITIES,
  TRIAL_SCHEMA_VERSION,
  TRIAL_VECTOR,
  TRIAL_VECTOR_SPECS,
  TRIAL_VERDICT,
  validateTrialReport,
} from "./trial-schema.js";

/** Status on a trial we could not read. Equal to the MISTRIAL verdict. */
export const MISTRIAL = TRIAL_VERDICT.MISTRIAL;

/** Default retry budget when a caller does not set one. */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * The prosecutor's system prompt. Identity, the five vectors, the falsifiable
 * requirement, and the schema are all stated up front -- an unknown vector or an
 * empty proof the model invents is a report the validator will reject, so the
 * prompt spends its words preventing both.
 */
export const TRIAL_SYSTEM_PROMPT = [
  "You are a prosecutor attacking a MERGED solution in a proposal tribunal.",
  "Your job is to find flaws the synthesizer introduced or missed. You are NOT reviewing the original proposals -- you are attacking the merge specifically, for defects that exist in the hybrid and in none of its inputs.",
  "You are identity-blind: judge the work, never speculate about which model synthesized it or who wrote the proposals.",
  "",
  "Attack only along these five merge-specific vectors:",
  ...Object.values(TRIAL_VECTOR).map(
    (vector) => `  ${vector} -- ${TRIAL_VECTOR_SPECS[vector].description}.`,
  ),
  "",
  "Every finding MUST be falsifiable: its falsifiable_proof carries a kind (TEST_CASE, COUNTER_EXAMPLE, BOUNDARY_INPUT, or LOGICAL_PROOF) and a non-empty payload showing the proof. A finding with an empty payload is not a finding.",
  "Every finding MUST name the merge element ids it implicates in affected_element_ids, and a FINDING_REGRESSION finding MUST set regression_of to the id of the original Crucible finding that came back.",
  "",
  "Verdicts:",
  `  ${TRIAL_VERDICT.ACQUITTED} -- no critical issues; the merge may proceed. findings must contain no P0/P1.`,
  `  ${TRIAL_VERDICT.CONVICTED_RETRY} -- critical issues found; the merge should be re-run. Requires at least one P0/P1 finding and a non-empty recommended_retry_focus.`,
  `  ${TRIAL_VERDICT.CONVICTED_FINAL} -- critical issues that re-merging cannot fix. Requires at least one P0/P1 finding.`,
  "",
  "Reply with a single JSON object and nothing else -- no prose, no markdown fences.",
  `It must have exactly these fields: schema_version (must be ${TRIAL_SCHEMA_VERSION}), verdict, findings, prosecution_summary, recommended_retry_focus.`,
  "Each finding has exactly: id, severity (P0_CRITICAL, P1_MAJOR, P2_MINOR, P3_INFORMATIONAL), vector, title, explanation, affected_element_ids, regression_of, falsifiable_proof.",
  "falsifiable_proof has exactly: kind and payload.",
].join("\n");

/**
 * Domain framing for the prosecution. The same five vectors apply to code, a
 * design, an idea, a plan, or an argument; only what counts as a "seam" or an
 * "element" changes, and this table adapts them.
 */
export const TRIAL_DOMAIN_SPECS = Object.freeze({
  code: {
    label: "source code",
    instruction: "The merge is a code change. An integration seam is where two merged code paths meet; test the boundaries where they interact.",
  },
  architecture: {
    label: "system architecture",
    instruction: "The merge is a design. An integration seam is where components from different proposals must agree on a protocol; test for contradictions.",
  },
  idea: {
    label: "product idea",
    instruction: "The merge is a product concept. Watch for scope inflation and for ideas that contradict when combined.",
  },
  plan: {
    label: "project plan",
    instruction: "The merge is a plan. An integration seam is where two sequences of work are interleaved; test for ordering and dependency conflicts.",
  },
  logic: {
    label: "argument or reasoning",
    instruction: "The merge is a line of reasoning. An integration seam is where premises from different sources are joined; test the join for contradiction.",
  },
});

// Fields that reveal who produced a proposal or a merge. Removed, at any depth,
// before anything reaches the prosecutor.
const IDENTITY_FIELDS = [
  "model",
  "modelId",
  "model_id",
  "synthesizer",
  "author",
  "authorId",
  "author_id",
  "provider",
  "createdBy",
  "created_by",
  "agent",
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Deep-clone `value`, dropping identity fields from every object encountered. */
function stripIdentityDeep(value) {
  if (Array.isArray(value)) return value.map(stripIdentityDeep);
  if (!isPlainObject(value)) return value;
  const clone = {};
  for (const [key, entry] of Object.entries(value)) {
    if (IDENTITY_FIELDS.includes(key)) continue;
    clone[key] = stripIdentityDeep(entry);
  }
  return clone;
}

function labelFor(index) {
  return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
}

function proposalIdOf(proposal) {
  const id = proposal?.id ?? proposal?.proposalId;
  return isNonEmptyString(id) ? id : null;
}

function elementLines(mergeReport) {
  const elements = mergeReport?.hybrid_solution?.elements;
  if (!Array.isArray(elements) || elements.length === 0) return ["(no elements recorded)"];
  return elements.map((element) => {
    const id = element?.element_id ?? "?";
    const sources = Array.isArray(element?.source_proposal_ids) ? element.source_proposal_ids.join(", ") : "";
    const addresses = Array.isArray(element?.addresses_findings) ? element.addresses_findings.join(", ") : "";
    const rationale = isNonEmptyString(element?.rationale) ? element.rationale : "";
    return `- ${id} (sources: ${sources || "none"}; addresses: ${addresses || "none"}): ${rationale}`;
  });
}

/**
 * Build the single prosecution prompt.
 *
 * @param {object} input
 * @param {object} [input.mergeReport]       the merge under attack
 * @param {Array}  [input.crucibleFindings] original P0/P1 findings (for regression checking)
 * @param {Array}  [input.originalProposals] proposals the merge drew from (for provenance/scope)
 * @param {string} [input.domain]          code | architecture | idea | plan | logic
 * @returns {string}
 */
export function buildTrialPrompt({
  mergeReport,
  crucibleFindings = [],
  originalProposals = [],
  domain = "code",
} = {}) {
  const cleanMerge = stripIdentityDeep(mergeReport);
  const findings = Array.isArray(crucibleFindings) ? crucibleFindings : [];
  const proposals = Array.isArray(originalProposals) ? originalProposals : [];
  const domainSpec = TRIAL_DOMAIN_SPECS[domain] ?? TRIAL_DOMAIN_SPECS.code;

  // Statuses the merge claimed for each original finding -- the prosecutor needs
  // these to spot a FINDING_REGRESSION (claimed ADDRESSED, actually back).
  const statusByFinding = new Map();
  for (const entry of Array.isArray(cleanMerge?.findings_resolution) ? cleanMerge.findings_resolution : []) {
    if (isNonEmptyString(entry?.finding_id)) statusByFinding.set(entry.finding_id, entry.status);
  }

  const findingLines = findings.map((finding) => {
    const id = finding?.id ?? finding?.finding_id ?? "?";
    const meta = [finding?.severity, finding?.vector].filter(isNonEmptyString).join(" / ");
    const title = isNonEmptyString(finding?.title) ? finding.title : "(untitled)";
    const claimed = statusByFinding.get(id);
    const claimedNote = claimed ? ` [merge marked: ${claimed}]` : "";
    const against = isNonEmptyString(finding?.proposal_id) ? ` [raised against ${finding.proposal_id}]` : "";
    return `- ${id} (${meta || "finding"})${against}${claimedNote}: ${title}`;
  });

  const proposalBlocks = proposals.map((proposal, index) => {
    const label = labelFor(index);
    const id = proposalIdOf(proposal) ?? `unlabeled-${index + 1}`;
    return [`### Proposal ${label} (id: ${id})`, JSON.stringify(stripIdentityDeep(proposal), null, 2)].join("\n");
  });

  const vectorLines = Object.values(TRIAL_VECTOR).map(
    (vector) => `- ${vector}: ${TRIAL_VECTOR_SPECS[vector].description}`,
  );

  return [
    `DOMAIN: ${domainSpec.label}.`,
    domainSpec.instruction,
    "",
    "You are a hostile prosecutor attacking a MERGED solution. Your job is to find flaws the synthesizer introduced or missed.",
    "You are not reviewing the original proposals -- you are attacking the merge specifically, for defects that exist in the hybrid and in none of its inputs.",
    "A defect that exists in the hybrid but in none of the inputs is your target. Identity is stripped; judge the work.",
    "",
    "## Vectors to attack (each finding's vector must be one of these)",
    ...vectorLines,
    "",
    "## The merged hybrid under attack",
    `content: ${isNonEmptyString(cleanMerge?.hybrid_solution?.content) ? cleanMerge.hybrid_solution.content : "(no hybrid content)"}`,
    "elements (cite these element_id values in affected_element_ids):",
    ...elementLines(cleanMerge),
    "",
    "## Original Crucible findings (use regression_of to point back at one of these ids)",
    ...(findingLines.length > 0 ? findingLines : ["(none)"]),
    "",
    "## The proposals the merge was built from (check for provenance and scope violations)",
    ...(proposalBlocks.length > 0 ? proposalBlocks : ["(none)"]),
    "",
    "Return the verdict now, as one JSON object conforming to the schema in your instructions.",
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

function parseTrialJson(text) {
  const source = typeof text === "string" ? text : "";
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const slice = extractBalancedObject(body);
  if (slice === null) return { ok: false, error: "no JSON object found in trial output" };
  try {
    const value = JSON.parse(slice);
    if (!isPlainObject(value)) return { ok: false, error: "trial output is not a JSON object" };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `trial output is not valid JSON: ${err.message}` };
  }
}

/**
 * Run one prosecution of the merge.
 *
 * @param {object} input
 * @param {object}   [input.mergeReport]
 * @param {Array}    [input.crucibleFindings]
 * @param {Array}    [input.originalProposals]
 * @param {Function} [input.completeFn]   gateway complete(config, modelId, prompt, opts)
 * @param {string}   [input.modelId]          the adversary/prosecutor model
 * @param {string}   [input.synthesizerModelId]  the model that synthesized the merge
 * @param {object}   [input.options]    { config, domain, opts: { ... }, now }
 * @returns {Promise<
 *   { status: "OK", report: object, modelId: string|null, elapsed_ms: number, rotationGuardEngaged?: boolean } |
 *   { status: "MISTRIAL", rawResponse: string|null, errors: string[], modelId: string|null, elapsed_ms: number }
 * >}
 */
export async function runTrial({
  mergeReport,
  crucibleFindings = [],
  originalProposals = [],
  completeFn,
  modelId = null,
  synthesizerModelId = null,
  options = {},
} = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const began = now();

  const errors = [];
  if (typeof completeFn !== "function") errors.push("a completeFn() function is required");
  if (!isPlainObject(mergeReport)) errors.push("a mergeReport object is required (there is nothing to try)");

  /**
   * @returns {{ status: "MISTRIAL", rawResponse: string|null, errors: string[], modelId: string|null, elapsed_ms: number }}
   */
  const mistrial = (rawResponse, errorList) => ({
    status: MISTRIAL,
    rawResponse: rawResponse ?? null,
    errors: errorList,
    modelId,
    elapsed_ms: Math.max(0, now() - began),
  });

  if (errors.length > 0) return mistrial(null, errors);

  const domain = options.domain ?? "code";
  const prompt = buildTrialPrompt({ mergeReport, crucibleFindings, originalProposals, domain });

  // Rotation guard: the adversary (prosecutor) must differ from the synthesizer.
  // If they are the same model, flag it so the caller can route to a different
  // model rather than let a model prosecute its own merge.
  const rotationGuardEngaged = synthesizerModelId !== null && synthesizerModelId === modelId;

  let text;
  try {
    const response = await completeFn(options.config ?? null, modelId, prompt, {
      ...(options.opts ?? {}),
      system: options.opts?.system ?? TRIAL_SYSTEM_PROMPT,
    });
    text = response?.text ?? response?.output ?? "";
  } catch (err) {
    return mistrial(null, [`completion failed: ${err.message}`]);
  }

  const parsed = parseTrialJson(text);
  if (!parsed.ok) return mistrial(text, [parsed.error]);

  const check = validateTrialReport(parsed.value, mergeReport, { crucibleFindings });
  if (!check.valid) return mistrial(text, check.errors);

  // Redact before the report leaves the module: a prosecutor quoting a secret
  // from the merge must not carry it into downstream state.
  return {
    status: "OK",
    report: redactDeep(parsed.value),
    modelId,
    rotationGuardEngaged,
    elapsed_ms: Math.max(0, now() - began),
  };
}

/**
 * Turn a validated trial report plus the retry budget into a decision.
 *
 * The report's own `verdict` is advisory; this recomputes it from the findings
 * and the budget, because the budget is the part a model cannot see. A merge
 * convicted on its last allowed attempt is CONVICTED_FINAL by construction --
 * there is no iteration left to spend.
 *
 * @param {object} trialReport
 * @param {number} [iteration=0]     zero-based trial number
 * @param {number} [maxRetries=3]    retries allowed after the first trial
 * @returns {{ verdict: string, shouldRetry: boolean, criticalFindings: object[], focus?: string|null, exhaustedBudget?: boolean }}
 */
export function classifyTrialOutcome(trialReport, iteration = 0, maxRetries = DEFAULT_MAX_RETRIES) {
  const findings = Array.isArray(trialReport?.findings) ? trialReport.findings : [];
  const critical = findings.filter((finding) => CRITICAL_SEVERITIES.includes(finding?.severity));

  if (critical.length === 0) {
    return { verdict: TRIAL_VERDICT.ACQUITTED, shouldRetry: false, criticalFindings: [] };
  }

  if (iteration < maxRetries) {
    return {
      verdict: TRIAL_VERDICT.CONVICTED_RETRY,
      shouldRetry: true,
      focus: isNonEmptyString(trialReport?.recommended_retry_focus) ? trialReport.recommended_retry_focus : null,
      criticalFindings: critical,
    };
  }

  return {
    verdict: TRIAL_VERDICT.CONVICTED_FINAL,
    shouldRetry: false,
    exhaustedBudget: true,
    criticalFindings: critical,
  };
}

export default {
  MISTRIAL,
  DEFAULT_MAX_RETRIES,
  TRIAL_SYSTEM_PROMPT,
  TRIAL_DOMAIN_SPECS,
  buildTrialPrompt,
  runTrial,
  classifyTrialOutcome,
};
