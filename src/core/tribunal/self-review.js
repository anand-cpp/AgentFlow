// Self-review: one model, asked to attack its own proposal.
//
// The rule this module enforces is structural, not rhetorical. The reviewer is
// invoked through the same `complete` gateway the author used, but with a
// reviewer system prompt, a fresh stateless call, and a prompt that carries the
// proposal's *content* and nothing about who produced it. "Identity-blind" and
// "separate context" fall out of that: every gateway call already starts from
// zero, so the only thing that could leak authorship is the prompt, and this
// module does not put it there.
//
// The output is untrusted model prose until it passes the schema. A review that
// does not validate is returned as `{ ok: false, errors }` -- never repaired,
// never partially trusted -- because coercion is how an invented defect becomes
// a persisted "reproduced" finding.

import { redactDeep } from "../redact.js";
import { validateSelfReview } from "./review-schema.js";

/**
 * The adversarial reviewer's system prompt.
 *
 * Written as a role and a set of obligations, not a request for a specific
 * number of findings -- the schema's rationale field is what stops padding, so
 * the prompt does not need to demand a count.
 */
export const SELF_REVIEW_SYSTEM_PROMPT = [
  "You are a hostile but fair reviewer. You are reviewing a proposal that you yourself produced, but you must judge it as if it came from an untrusted stranger.",
  "Your job is not to agree, and it is not to perform disagreement. Your job is to find out whether the proposal is actually correct.",
  "",
  "Rules:",
  "- Do not defend the proposal because you wrote it. Your previous confidence is irrelevant to whether it is right.",
  "- A finding only counts as REPRODUCED if you can state a concrete reproduction: an input, a sequence of steps, or a counterexample that shows the failure. If you cannot, it is a HYPOTHESIS, and you must label it as one.",
  "- Do not invent defects to reach a count. If there is genuinely nothing to add, say so in failureHypothesesRationale instead of fabricating findings.",
  "- Challenge the proposal's hidden assumptions and any claim it states as fact without evidence.",
  "- Lower your confidence when the findings warrant it, and justify every change in confidence.",
  "",
  "Respond with a single JSON object and nothing else. It must match the schema you were given exactly. No prose before or after the JSON.",
].join("\n");

/**
 * Build the user prompt for a review.
 *
 * Authorship is deliberately absent: no model id, no provider, no "you wrote
 * this earlier" framing beyond the system prompt's acknowledgement that the
 * proposal may be the reviewer's own. The reviewer sees the proposal as text.
 */
export function buildReviewPrompt({ candidate, schemaVersion } = {}) {
  const c = candidate ?? {};
  const proposal = {
    id: c.id ?? null,
    approach: c.approach ?? null,
    rationale: c.rationale ?? null,
    assumptions: Array.isArray(c.assumptions) ? c.assumptions : [],
    expectedBehavior: c.expectedBehavior ?? null,
    proposedTests: c.proposedTests ?? null,
  };

  return [
    "Review the following proposal.",
    "",
    "PROPOSAL (JSON):",
    JSON.stringify(proposal, null, 2),
    "",
    "Return one JSON object with these fields:",
    "- schemaVersion: leave as the required constant.",
    "- candidateId: copy the proposal id.",
    "- originalApproach: restate the proposal's approach in your own words.",
    "- strongestCounterArgument: the single best argument against the proposal.",
    "- failureHypotheses: array of { statement, severity (info|low|medium|high|critical), category (correctness|logic|edge_case|security|assumption|missing_evidence|unverified_claim|compatibility|performance|other), evidence (reproduced|hypothesis), reproduction (string when evidence is reproduced, else null) }.",
    "- failureHypothesesRationale: required when you list fewer than three hypotheses; explain why there are not more.",
    "- assumptions, missingEvidence, securityWeaknesses, logicRisks, edgeCases, performanceConcerns: arrays of strings.",
    "- proposedTests: array of { description, expected (pass|fail), executed (boolean), observed (string or null) }.",
    "- confidenceBefore: your honest confidence in the proposal before this review (0..1).",
    "- confidenceAfter: your confidence after the review (0..1).",
    "- confidenceJustification: why confidence moved (or did not).",
    "- decision: REVISE | REJECT | RETAIN_WITH_EVIDENCE.",
    "- revisedApproach: the improved approach when decision is REVISE, else null.",
    "",
    `schemaVersion must be ${schemaVersion}.`,
  ].join("\n");
}

/**
 * Pull the first JSON object out of model output.
 *
 * Models fence JSON in ```json blocks and wrap it in a sentence or two even
 * when told not to. A balanced-brace scan is more robust than a greedy regex,
 * which fails the moment the JSON contains a nested object followed by prose.
 *
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parseReview(text) {
  const source = typeof text === "string" ? text : "";
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : source;
  const slice = extractBalancedObject(body);
  if (slice === null) return { ok: false, error: "no JSON object found in review output" };
  try {
    const value = JSON.parse(slice);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "review output is not a JSON object" };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `review output is not valid JSON: ${err.message}` };
  }
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

/**
 * Run one self-review.
 *
 * @param {object} input
 * @param {Function} input.complete   gateway complete(config, modelId, prompt, opts)
 * @param {object}   [input.config]   passed through to complete
 * @param {string}   input.modelId    the *same* model that produced the candidate
 * @param {object}   input.candidate  { id, approach, rationale, assumptions, ... }
 * @param {object}   [input.opts]     { timeoutMs, maxTokens, temperature, system }
 * @returns {Promise<{ ok: boolean, review: object|null, errors: string[] }>}
 */
export async function runSelfReview({ complete, config = null, modelId = null, candidate = null, opts = {} } = {}) {
  const errors = [];
  if (typeof complete !== "function") errors.push("a complete() function is required");
  if (!modelId) errors.push("modelId is required");
  if (candidate === null || typeof candidate !== "object") errors.push("candidate is required");
  if (errors.length > 0) return { ok: false, review: null, errors };

  const system = opts.system ?? SELF_REVIEW_SYSTEM_PROMPT;
  const prompt = buildReviewPrompt({ candidate, schemaVersion: 1 });

  let text;
  try {
    const result = await complete(config, modelId, prompt, {
      system,
      timeoutMs: opts.timeoutMs ?? null,
      maxTokens: opts.maxTokens ?? null,
      temperature: opts.temperature ?? null,
      signal: opts.signal ?? null,
    });
    text = typeof result?.text === "string" ? result.text : result?.output;
  } catch (err) {
    return { ok: false, review: null, errors: [`self-review call failed: ${err?.message || err}`] };
  }

  const parsed = parseReview(text);
  if (!parsed.ok) return { ok: false, review: null, errors: [parsed.error] };

  const validation = validateSelfReview(parsed.value);
  if (!validation.ok) return { ok: false, review: null, errors: validation.errors };

  // Redact before the review leaves this module: whatever downstream persists or
  // prints it (audit trail, session record, test failure output) gets a value
  // already safe to store.
  return { ok: true, review: redactDeep(parsed.value), errors: [] };
}

export default { SELF_REVIEW_SYSTEM_PROMPT, buildReviewPrompt, parseReview, runSelfReview };
