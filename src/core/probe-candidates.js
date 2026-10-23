// Probe targets for `aflow doctor` and `aflow dashboard`.
//
// Both commands answer the same question -- "which of these models actually
// returns content?" -- so they must choose the same models. A literal list in
// each command drifts, and it drifts in a way that is hard to see: the gateway
// treats an unknown `<prefix>/<model>` id as a *local* model name, so a stale
// entry (say, a provider this build no longer serves) is silently sent to
// Ollama and fails for a reason that has nothing to do with the user's keys.
//
// Deriving the list from the provider registry makes that class of bug
// impossible: every candidate is `<known-provider>/<model that provider
// serves>`. Only configured providers are probed, because probing a provider
// with no credential can only fail -- and doctor already reports that case
// explicitly, with the fix.

import { PROVIDERS } from "./gateway-server.js";
import { configuredProviderNames } from "./keys.js";

/** Probing is a live request per model; three is enough to show the pattern. */
export const MAX_DEFAULT_PROBES = 3;

/**
 * One model per configured provider, in registry order, capped.
 *
 * Returns an empty list when nothing is configured. That is deliberate: there
 * is no honest probe to run without a credential, and pretending otherwise
 * would produce failures that look like provider outages.
 *
 * @param {Record<string, unknown>} [env]
 * @param {Record<string, { models?: string[], local?: boolean }>} [providers]
 * @param {number} [max]
 * @returns {string[]}
 */
export function defaultProbeCandidates(env = process.env, providers = PROVIDERS, max = MAX_DEFAULT_PROBES) {
  const candidates = [];
  for (const name of configuredProviderNames(env, providers)) {
    const model = providers?.[name]?.models?.[0];
    if (!model) continue;
    candidates.push(`${name}/${model}`);
    if (candidates.length >= max) break;
  }
  return candidates;
}
