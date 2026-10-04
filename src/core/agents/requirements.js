// Model requirement resolution.
//
// The whole point of an agent saying "I need tool calling" instead of naming a
// model is that something has to turn that into an actual list of candidates. This
// is that something.
//
// It produces tiers for the existing Router, and nothing else. It does not call
// providers, it does not probe, and it does not decide which one won -- the router
// already does that, with health memory and a failure taxonomy. Adding a second
// selector here would mean two answers to "why this model".
//
// What this module has to get right is what it can and cannot know. The gateway
// advertises models with ids and nothing else: there is no capability metadata to
// read. So requirements are resolved against hints the user supplies, and every
// inference is recorded in the receipt. An unresolvable requirement produces a
// clear refusal rather than a silent downgrade to "some model, probably fine".

import { tiersFromList } from "../routing.js";

/**
 * Hints a user can attach to a model so requirements can be resolved against it.
 *
 * Deliberately not inferred from model names. `deepseek-r1-70b` tells you nothing
 * reliable about context length, and guessing from substrings is how an agent ends
 * up silently running with a 4k window and no error.
 */
export const MODEL_HINT_FIELDS = ["capabilities", "contextWindow", "maxTokens", "toolCalling", "provider"];

export class RequirementError extends Error {
  constructor(message, code = "requirement_unsatisfied") {
    super(message);
    this.name = "RequirementError";
    this.code = code;
  }
}

/**
 * Capability hints inferred from a model id.
 *
 * Conservative on purpose. These are the two inferences specific enough to be
 * worth making -- the `oc/` prefix is AgentFlow's own namespace and the suffix
 * forms are used consistently by the configured providers -- and nothing more.
 * A wrong capability here means an agent silently runs with tools it cannot call.
 */
export function inferHints(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return { capabilities: [], source: "none" };

  const slash = id.indexOf("/");
  const provider = slash === -1 ? null : id.slice(0, slash);
  const model = slash === -1 ? id : id.slice(slash + 1);
  const lower = model.toLowerCase();
  const capabilities = [];

  // Substrings only where the match is unambiguous enough to be worth it.
  if (/\b(coder|code|dev)\b/.test(lower) || lower.includes("-code")) capabilities.push("coding");
  if (/\bthink|reason|r1|qwq|o[13]\b/.test(lower)) capabilities.push("reasoning");
  if (lower.includes("search") || lower.includes("research")) capabilities.push("research");

  return {
    capabilities: [...new Set(capabilities)],
    provider,
    source: "inferred",
  };
}

/** Merge a declared hint over an inferred one. Declared always wins. */
export function resolveHints(modelId, declared = null) {
  const inferred = inferHints(modelId);
  if (!declared || typeof declared !== "object") return inferred;

  const merged = { ...inferred };
  merged.capabilities = Array.isArray(declared.capabilities)
    ? [...new Set([...inferred.capabilities, ...declared.capabilities.map(String)])]
    : inferred.capabilities;
  for (const field of ["contextWindow", "maxTokens"]) {
    if (declared[field] !== undefined && declared[field] !== null) merged[field] = Number(declared[field]);
  }
  if (declared.toolCalling !== undefined) merged.toolCalling = Boolean(declared.toolCalling);
  merged.source = "declared";
  return merged;
}

/**
 * Does one model satisfy a set of requirements?
 *
 * Returns a verdict object rather than a boolean, because the caller needs to
 * explain *which* requirement was missing. A bare false produces a refusal the
 * operator cannot act on.
 */
export function checkRequirements(modelId, requirements, hints = null) {
  const need = requirements || [];
  const resolved = hints ? resolveHints(modelId, hints) : inferHints(modelId);
  const have = new Set(resolved.capabilities || []);
  const missing = need.filter((cap) => !have.has(cap));

  return {
    model: modelId,
    ok: missing.length === 0,
    missing,
    capabilities: [...have],
    // Recorded so the receipt can say *why* a model was considered capable, which
    // is the difference between a debuggable failure and "why did it pick that?".
    hintSource: resolved.source,
  };
}

/**
 * Resolve an agent's requirements into an ordered candidate list and tiers.
 *
 * `catalogue` is what the gateway advertises. `hints` is the user's own
 * capability metadata, keyed by model id. A model absent from `hints` still
 * participates via inference, but that fact is reported rather than hidden.
 *
 * Throws RequirementError when nothing satisfies the requirements. Returning an
 * empty candidate list instead would hand the router a stack trace instead of a
 * sentence an operator can act on.
 */
export function resolveModelPlan(agent, { catalogue = [], hints = {}, includeUnhinted = true } = {}) {
  const requirements = agent?.model?.requireCapabilities || [];
  const preferences = agent?.model?.prefer || [];
  const routing = agent?.routing || {};

  if (agent?.model?.pinModel) {
    // A pinned model is explicit intent. It is never filtered, and saying so in
    // the receipt prevents the surprise where a pin silently stops working.
    return {
      pinned: true,
      model: agent.model.pinModel,
      requirements: [],
      candidates: [agent.model.pinModel],
      tiers: [{ name: "pinned", models: [agent.model.pinModel] }],
      considered: [
        { model: agent.model.pinModel, ok: true, missing: [], capabilities: [], hintSource: "pinned" },
      ],
      unfiltered: true,
    };
  }

  const advertised = catalogue.map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
  if (!advertised.length) {
    throw new RequirementError(
      "no models available: the gateway advertised an empty catalogue, so there is nothing to resolve requirements against",
      "empty_catalogue"
    );
  }

  const considered = advertised.map((id) => checkRequirements(id, requirements, hints[id]));
  const capable = considered.filter((v) => v.ok);

  if (!capable.length) {
    const detail = requirements.length
      ? `none of the ${advertised.length} advertised model(s) declare ${requirements.join(", ")}`
      : "no candidates";
    throw new RequirementError(
      `${detail}; declare hints for a model to satisfy requirements. ` +
        `Without hints, capability inference is limited and this is expected for strict requirements.`,
      "no_capable_model"
    );
  }

  // Preferences first, each in its own tier so it is genuinely tried before the
  // rest -- same reasoning as `aflow route --fallback`. Anything named that is
  // not actually capable is dropped with a note rather than silently promoted.
  const prefTiers = [];
  const used = new Set();
  const droppedPreferences = [];
  for (const id of preferences) {
    if (!capable.some((v) => v.model === id)) {
      droppedPreferences.push(id);
      continue;
    }
    prefTiers.push({ name: `pref${prefTiers.length + 1}`, models: [id] });
    used.add(id);
  }

  const rest = capable
    // Filter on the resolved hint source, not on the caller's raw hints object:
    // `hints[id]` is what the user wrote and carries no `source`, so reading it
    // directly would silently exclude every model whenever includeUnhinted is off.
    .filter((v) => includeUnhinted || v.hintSource === "declared")
    .map((v) => v.model)
    .filter((id) => !used.has(id));

  const remainder = rest.length ? tiersFromList(rest, { size: routing.tierSize || 2, prefix: "tier" }) : [];
  const tiers = [...prefTiers, ...remainder];

  if (!tiers.length) {
    throw new RequirementError("every capable model was excluded by the routing policy", "no_tiers");
  }

  return {
    pinned: false,
    model: null,
    requirements: [...requirements],
    candidates: tiers.flatMap((t) => t.models),
    tiers,
    considered,
    unfiltered: false,
    // Surfaced so `aflow agent run` can tell the operator that the model it chose
    // was picked on inference rather than on a declaration they wrote.
    unhinted: capable.filter((v) => v.hintSource !== "declared").map((v) => v.model),
    droppedPreferences,
  };
}

/**
 * A one-line explanation of a resolved plan, for logs and `--json` receipts.
 *
 * Kept here rather than in the command so the runtime and the CLI cannot drift
 * on what "why this model" means.
 */
export function explainPlan(plan, { max = 6 } = {}) {
  if (!plan) return "no plan";
  if (plan.pinned) return `pinned to ${plan.model} by the agent definition`;

  const parts = [];
  if (plan.requirements.length) {
    parts.push(`requires ${plan.requirements.join(" + ")}`);
  } else {
    parts.push("no capability requirements");
  }
  parts.push(`${plan.candidates.length} candidate${plan.candidates.length === 1 ? "" : "s"}`);

  const shown = plan.considered.slice(0, max);
  const rejected = shown.filter((v) => !v.ok);
  if (rejected.length) {
    parts.push(`${rejected.length} rejected (e.g. ${rejected[0].model} missing ${rejected[0].missing.join(", ")})`);
  }
  if (plan.unhinted && plan.unhinted.length) {
    parts.push(`${plan.unhinted.length} matched on inference rather than declared hints`);
  }
  if (plan.droppedPreferences && plan.droppedPreferences.length) {
    parts.push(`ignored preferences not meeting requirements: ${plan.droppedPreferences.join(", ")}`);
  }
  return parts.join("; ");
}

export default {
  resolveModelPlan,
  checkRequirements,
  inferHints,
  resolveHints,
  explainPlan,
  RequirementError,
  MODEL_HINT_FIELDS,
};