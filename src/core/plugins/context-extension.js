// Plugin context providers.
//
// The extension point behind `context.registerContextProvider({ name,
// getContext })`. A provider contributes a text block that is injected into
// the agent's context packet before LLM calls.
//
// The only hard currency here is the token budget: a context packet is
// finite, so providers are invoked serially and each block is admitted while
// the budget lasts, in registration order. Provision is best-effort, not a
// race: a provider that returns an empty string contributes nothing, and one
// that overflows the remaining budget is skipped (not truncated) -- a
// silently chopped block reads as valid text to the model, which is how
// wrong decisions get defended.
//
// Everything is fail-isolated: a provider that throws or hangs becomes a
// recorded error and the packet continues.

const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const DEFAULT_PROVIDER_TIMEOUT_MS = 2000;
// Actual prompt tokenisation is len/4 across the codebase's context packer;
// use the same arithmetic so plugin blocks budget identically to repo-map
// sections.
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

export function validateContextDef(def) {
  const errors = [];
  if (!def || typeof def !== "object") {
    return ["registerContextProvider: definition must be an object"];
  }
  if (typeof def.name !== "string" || !PROVIDER_NAME_RE.test(def.name)) {
    errors.push(`registerContextProvider: name must match ${PROVIDER_NAME_RE.source}`);
  }
  if (typeof def.getContext !== "function") {
    errors.push("registerContextProvider: getContext must be a function");
  }
  return errors;
}

export class PluginContextRegistry {
  constructor({ timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, {pluginId: string, def: object}>} internal name -> entry */
    this.byName = new Map();
    this.byPlugin = new Map();
  }

  /**
   * @param {string} pluginId
   * @param {{ name: string, description?: string, getContext: Function }} def
   * @returns {{ ok: boolean, name?: string, error?: string }}
   */
  register(pluginId, def) {
    const errors = validateContextDef(def);
    if (errors.length > 0) return { ok: false, error: errors[0], errors };
    const name = `plugin__${pluginId}__${def.name}`;
    if (this.byName.has(name)) {
      return { ok: false, error: `registerContextProvider: "${name}" already registered` };
    }
    const entry = { pluginId, def: { ...def, name } };
    this.byName.set(name, entry);
    this.byPlugin.set(pluginId, [...(this.byPlugin.get(pluginId) ?? []), name]);
    return { ok: true, name };
  }

  get(name) {
    return this.byName.get(name);
  }

  providersForPlugin(pluginId) {
    return (this.byPlugin.get(pluginId) ?? []).map((n) => this.byName.get(n));
  }

  /** All entries, sorted by internal name for deterministic ordering. */
  list() {
    return [...this.byName.values()].sort((a, b) => (a.def.name < b.def.name ? -1 : 1));
  }

  removePlugin(pluginId) {
    const names = this.byPlugin.get(pluginId) ?? [];
    for (const n of names) this.byName.delete(n);
    this.byPlugin.delete(pluginId);
    return names.length;
  }

  get size() {
    return this.byName.size;
  }

  /**
   * Collect context blocks from every registered provider under a budget.
   *
   * @param {object} payload arbitrary enrichment input (task/query fields)
   * @param {{ tokenBudget?: number|null, timeoutMs?: number }} [opts]
   *   tokenBudget null means unbounded.
   * @returns {{ ok: boolean, blocks: Array<{pluginId: string, name: string, tokenEstimate: number, text: string}>,
   *            skipped: Array<{pluginId: string, name: string, reason: string}>,
   *            errors: Array<{pluginId: string, message: string}>,
   *            tokensUsed: number }}
   */
  async enrich(payload, { tokenBudget = null, timeoutMs = this.timeoutMs } = {}) {
    const blocks = [];
    const skipped = [];
    const errors = [];
    let tokensUsed = 0;
    let remaining = tokenBudget == null ? Number.POSITIVE_INFINITY : tokenBudget;

    const entries = this.list();
    for (const { pluginId, def } of entries) {
      let text;
      try {
        let timer = null;
        const call = Promise.resolve(def.getContext(payload)).finally(() => {
          clearTimeout(timer);
        });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        });
        const raw = await Promise.race([call, timeout]);
        text = typeof raw === "string" ? raw.trim() : "";
      } catch (error) {
        errors.push({ pluginId, message: error?.message ?? String(error) });
        continue;
      }
      if (!text) continue; // nothing to contribute; skipped list is for politeness, not silence
      const cost = estimateTokens(text);
      if (cost > remaining) {
        skipped.push({
          pluginId,
          name: def.name,
          reason: `needs ~${cost} tokens, ${remaining == null || remaining === Number.POSITIVE_INFINITY ? "unbounded" : remaining} left`,
        });
        continue;
      }
      blocks.push({ pluginId, name: def.name, tokenEstimate: cost, text });
      tokensUsed += cost;
      remaining -= cost;
    }
    return { ok: true, blocks, skipped, errors, tokensUsed };
  }
}

/** Join collected blocks into a text section the agent context can inject. */
export function renderPluginContext(enrichment) {
  const blocks = enrichment?.blocks ?? [];
  if (blocks.length === 0) return "";
  const sections = blocks
    .map((b) => `<plugin-context provider="${b.name}" plugin="${b.pluginId}">\n${b.text}\n</plugin-context>`)
    .join("\n\n");
  let header = `plugin context (${blocks.length} blocks)`;
  if (enrichment?.errors?.length > 0) {
    header += `; ${enrichment.errors.length} provider error(s)`;
  }
  if (enrichment?.skipped?.length > 0) {
    header += `; ${enrichment.skipped.length} skipped (budget)`;
  }
  return `${header}:\n${sections}`;
}
