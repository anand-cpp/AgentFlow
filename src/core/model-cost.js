// Model cost classification.
//
// AgentFlow is a free-first client: the README recommends providers with a free
// tier, the setup wizard stores their keys, and the router is built to fall back
// when a free request fails. What was missing is the policy layer that actually
// *uses* cost when ordering candidates. Catalogue order is not a cost policy --
// it is whatever order the gateway happened to advertise.
//
// The classification is deliberately conservative. A model is only called
// "free" when there is direct evidence: a local provider, an OpenRouter-style
// `:free` suffix, or an explicit user declaration. A provider that advertises a
// no-card free tier gets the weaker label "free-tier", because the free quota is
// rate-limited and may not cover every model forever. Everything else is
// "unknown", never silently "free".
//
// Routing order is free -> free-tier -> unknown -> paid. The sort is stable, so
// within a class the catalogue's own order is preserved. Explicit intent (a
// pinned model, a preferred model, a named model, a user-supplied fallback
// list) always wins; this module only orders the remainder.

export const COST_CLASS = Object.freeze({
  FREE: "free",
  FREE_TIER: "free-tier",
  UNKNOWN: "unknown",
  PAID: "paid",
});

const COST_RANK = Object.freeze({
  [COST_CLASS.FREE]: 0,
  [COST_CLASS.FREE_TIER]: 1,
  [COST_CLASS.UNKNOWN]: 2,
  [COST_CLASS.PAID]: 3,
});

/**
 * Provider-level cost evidence.
 *
 * Kept here rather than imported from `gateway-server.js` so the agent and chat
 * paths do not pull an HTTP server into their module graph. `test/model-cost.test.js`
 * asserts that every provider in the registry has an entry, so adding a provider
 * without deciding its cost class fails the suite rather than silently becoming
 * "unknown".
 *
 * `openrouter` is intentionally unknown: only its `:free` models are free, and
 * `auto` may route to a paid model. `together` and `fireworks` are signup credits,
 * not an ongoing free tier, so they are unknown too.
 */
export const PROVIDER_COST = Object.freeze({
  groq: COST_CLASS.FREE_TIER,
  cerebras: COST_CLASS.FREE_TIER,
  mistral: COST_CLASS.FREE_TIER,
  gemini: COST_CLASS.FREE_TIER,
  openrouter: COST_CLASS.UNKNOWN,
  cloudflare: COST_CLASS.FREE_TIER,
  hf: COST_CLASS.FREE_TIER,
  together: COST_CLASS.UNKNOWN,
  fireworks: COST_CLASS.UNKNOWN,
  deepinfra: COST_CLASS.FREE_TIER,
  sambanova: COST_CLASS.FREE_TIER,
  ollama: COST_CLASS.FREE,
});

/** Canonicalise a user- or catalogue-supplied cost label. */
export function normaliseCostClass(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/_/g, "-");
  if (v === "free") return COST_CLASS.FREE;
  if (v === "free-tier" || v === "freetier" || v === "tier") return COST_CLASS.FREE_TIER;
  if (v === "paid" || v === "metered") return COST_CLASS.PAID;
  if (v === "unknown" || v === "unclassified") return COST_CLASS.UNKNOWN;
  return null;
}

function splitModelId(modelId) {
  const id = String(modelId || "").trim();
  const slash = id.indexOf("/");
  if (slash === -1) return { id, provider: null, model: id };
  return { id, provider: id.slice(0, slash), model: id.slice(slash + 1) };
}

/**
 * Classify one model.
 *
 * Precedence is explicit declaration, then catalogue metadata, then the
 * `:free` suffix, then the provider's default class. A declaration of "paid" on
 * a local model is honoured -- the user knows about a proxy or a metered
 * endpoint we do not.
 *
 * Returns `{ class, source, reason }` rather than a bare string so a receipt can
 * explain *why* a model was considered free.
 *
 * @param {string} modelId
 * @param {{ declared?: object|null, catalogueEntry?: object|null }} [options]
 */
export function classifyModelCost(modelId, { declared = null, catalogueEntry = null } = {}) {
  const { id, provider, model } = splitModelId(modelId);
  if (!id) return { class: COST_CLASS.UNKNOWN, source: "none", reason: "empty model id" };

  const declaredClass = normaliseCostClass(declared?.costClass ?? declared?.cost);
  if (declaredClass) {
    return { class: declaredClass, source: "declared", reason: `model hint declares ${declaredClass}` };
  }
  if (typeof declared?.free === "boolean") {
    const cls = declared.free ? COST_CLASS.FREE : COST_CLASS.PAID;
    return { class: cls, source: "declared", reason: `model hint declares free: ${declared.free}` };
  }

  const advertised = normaliseCostClass(catalogueEntry?.costClass ?? catalogueEntry?.cost_class);
  if (advertised) {
    return { class: advertised, source: "catalogue", reason: `gateway advertises ${advertised}` };
  }

  if (model.toLowerCase().endsWith(":free")) {
    return { class: COST_CLASS.FREE, source: "model-id", reason: "model id ends in :free" };
  }

  const providerClass = provider ? PROVIDER_COST[provider] : null;
  if (providerClass) {
    return {
      class: providerClass,
      source: "provider",
      reason:
        providerClass === COST_CLASS.FREE
          ? `${provider} is a local provider`
          : `${provider} advertises a no-card free tier`,
    };
  }

  return {
    class: COST_CLASS.UNKNOWN,
    source: "unknown",
    reason: provider ? `no cost evidence for provider ${provider}` : "no cost evidence for a bare model id",
  };
}

function catalogueIndex(catalogue = []) {
  const index = new Map();
  for (const entry of Array.isArray(catalogue) ? catalogue : []) {
    if (typeof entry === "string") index.set(entry, null);
    else if (entry && typeof entry === "object" && entry.id) index.set(String(entry.id), entry);
  }
  return index;
}

function rowFor(model, hints, index) {
  const id = typeof model === "string" ? model.trim() : String(model?.id ?? "").trim();
  if (!id) return null;
  const entry = index.get(id) ?? (model && typeof model === "object" ? model : null);
  return {
    id,
    cost: classifyModelCost(id, { declared: hints?.[id] ?? null, catalogueEntry: entry }),
  };
}

/**
 * Order models free-first.
 *
 * The result is a list of ids, because every caller (the planner and the chat
 * engine) ultimately hands ids to the Router. Duplicates are preserved: callers
 * already deduplicate explicit choices, and silently merging rows here would
 * hide a caller's mistake.
 *
 * @param {Array<string|{id: string}>} models
 * @param {{ hints?: object, catalogue?: Array<string|object>, preferFree?: boolean, allowPaid?: boolean }} [options]
 */
export function orderByCost(models, { hints = {}, catalogue = [], preferFree = true, allowPaid = true } = {}) {
  const index = catalogueIndex(catalogue);
  const rows = [];
  for (const model of Array.isArray(models) ? models : []) {
    const row = rowFor(model, hints, index);
    if (!row) continue;
    // Paid fallback is opt-in. Dropping paid rows here keeps the decision in the
    // cost policy instead of teaching every caller to filter afterwards. An
    // explicit choice is never passed through this function, so intent still
    // wins over the default.
    if (!allowPaid && row.cost.class === COST_CLASS.PAID) continue;
    rows.push({ ...row, at: rows.length });
  }
  if (!preferFree) return rows.map((r) => r.id);
  rows.sort((a, b) => COST_RANK[a.cost.class] - COST_RANK[b.cost.class] || a.at - b.at);
  return rows.map((r) => r.id);
}

/** Cost class for each model, for plan receipts and event payloads. */
export function costClassesFor(models, { hints = {}, catalogue = [] } = {}) {
  const index = catalogueIndex(catalogue);
  const out = {};
  for (const model of Array.isArray(models) ? models : []) {
    const row = rowFor(model, hints, index);
    if (row) out[row.id] = row.cost.class;
  }
  return out;
}

/** Count classes in a `costClassesFor` result. */
export function countCostClasses(classes = {}) {
  const counts = {
    [COST_CLASS.FREE]: 0,
    [COST_CLASS.FREE_TIER]: 0,
    [COST_CLASS.UNKNOWN]: 0,
    [COST_CLASS.PAID]: 0,
  };
  for (const value of Object.values(classes)) {
    const cls = normaliseCostClass(value) ?? COST_CLASS.UNKNOWN;
    counts[cls] += 1;
  }
  return counts;
}

export default {
  COST_CLASS,
  PROVIDER_COST,
  normaliseCostClass,
  classifyModelCost,
  orderByCost,
  costClassesFor,
  countCostClasses,
};
