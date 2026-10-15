// Model picker — a fuzzy dialog over the gateway's provider catalogue.
//
// The picker is pure: it turns the PROVIDERS registry plus the set of
// configured (credential-present) providers into a flat list of selectable
// items, then hands them to the reusable fuzzy dialog. Grouping puts the local
// provider (ollama) first, then the rest alphabetically, and each row surfaces
// the two facts people actually decide on: whether the provider needs a credit
// card and how many requests per minute it allows.
//
// Providers without a configured credential are present but disabled — you can
// see what exists, but you cannot switch to a model that will just 401.

import { PROVIDERS } from "../core/gateway-server.js";
import { drawBox, drawSelectList } from "./components.js";
import { filterFuzzy } from "./interact.js";
import { dim, bold } from "../cli/ui.js";

const LOCAL_PROVIDER = "ollama";

/**
 * Providers that have at least one credential present in `env`.
 * Ollama is always considered available: it is local and needs no key.
 *
 * @param {object} [providers]
 * @param {object} [env]  Defaults to process.env.
 * @returns {Set<string>}
 */
export function configuredProviders(providers = PROVIDERS, env = process.env) {
  const set = new Set();
  for (const [provider, spec] of Object.entries(providers)) {
    if (provider === LOCAL_PROVIDER) {
      set.add(provider);
      continue;
    }
    if ((spec.envKeys || []).some((k) => env && env[k])) set.add(provider);
  }
  return set;
}

/**
 * Flatten PROVIDERS into picker items, local first then alphabetically.
 *
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.configured]  Providers with credentials.
 * @param {string|null} [options.currentModel]         Active `provider/model` id.
 * @param {object} [options.providers]                 Override the registry (tests).
 * @returns {Array<{label:string,value:string,description:string,disabled:boolean,provider:string,local:boolean}>}
 */
export function buildModelItems(options = {}) {
  const providers = options.providers || PROVIDERS;
  const configured = new Set(options.configured || []);
  const current = options.currentModel || null;
  const items = [];

  const entries = Object.entries(providers).sort(([a], [b]) => a.localeCompare(b));
  // Push the local provider to the front regardless of alphabet.
  entries.sort((a, b) => {
    const la = a[0] === LOCAL_PROVIDER ? 0 : 1;
    const lb = b[0] === LOCAL_PROVIDER ? 0 : 1;
    return la - lb || a[0].localeCompare(b[0]);
  });

  for (const [provider, spec] of entries) {
    const enabled = configured.size === 0 || configured.has(provider);
    for (const model of spec.models || []) {
      const id = `${provider}/${model}`;
      const bits = [];
      if (spec.ratePerMin) bits.push(`${spec.ratePerMin}/min`);
      if (spec.creditCard) bits.push("card");
      else bits.push("no card");
      const prefix = id === current ? "* " : "  ";
      items.push({
        label: `${prefix}${model}`,
        value: id,
        description: `${spec.label} · ${bits.join(" · ")}`,
        disabled: !enabled,
        provider,
        local: provider === LOCAL_PROVIDER,
      });
    }
    // Ollama advertises zero fixed models (they are whatever is pulled); give it
    // a placeholder row so local users are not left with an empty group.
    if ((spec.models || []).length === 0 && spec.label) {
      const enabled2 = configured.size === 0 || configured.has(provider);
      items.push({
        label: `  (any pulled model)`,
        value: `${provider}/`,
        description: `${spec.label} · auto`,
        disabled: !enabled2,
        provider,
        local: provider === LOCAL_PROVIDER,
      });
    }
  }
  return items;
}

/**
 * Render the picker box (grouped select list over a fixed width). Pure; used by
 * tests and by any caller that wants to inline the list rather than open the
 * interactive dialog.
 *
 * @param {object} state
 * @param {Array<object>} state.items
 * @param {number} [state.selected]
 * @param {number} [state.query]
 * @param {number} [width]
 * @returns {string}
 */
export function renderModelPicker(state, width = 72) {
  const items = state.items || [];
  const selected = state.selected || 0;
  const body = drawSelectList(items, selected, { width: width - 4, max: 14 });
  const header = state.query ? `${bold("model")} ${dim(String(state.query))}` : "model";
  return drawBox(header, body, { width, borderColor: "cyan" });
}

/**
 * Fuzzy-filter the model items. Delegates to the shared scorer so ranking is
 * identical to the rest of the TUI.
 *
 * @param {Array<object>} items
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterModels(items, query) {
  return filterFuzzy(items, query);
}

/**
 * Build the dialog spec for a model selection. Returns null if there is nothing
 * to pick (e.g. an empty catalogue), so callers can degrade to a message.
 *
 * @param {object} [options]
 * @param {Set<string>|string[]} [options.configured]
 * @param {string|null} [options.currentModel]
 * @param {object} [options.providers]
 * @returns {{title:string, items:Array<object>, max:number, width:number}|null}
 */
export function createModelDialogSpec(options = {}) {
  const items = buildModelItems(options);
  if (!items.length) return null;
  return { title: "Select model", items, max: 14, width: 72 };
}

export default {
  buildModelItems,
  renderModelPicker,
  filterModels,
  createModelDialogSpec,
  configuredProviders,
};
