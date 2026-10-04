// Routing policy engine.
//
// The gateway advertises hundreds of models and reaches almost none of them
// without credentials. Choosing a model is therefore not a lookup, it is a
// sequence of decisions under uncertainty -- and the interesting question is
// never "which model did you pick" but "why, and what did you try first".
//
// This module owns that reasoning and makes it observable. Every branch emits
// a structured event, so a routing decision can be reconstructed from the log
// rather than guessed at.
//
// Three ideas do most of the work:
//
//  1. Tiers. Group candidates into quality tiers, then walk down. Users think
//     "use the best thing that works", not "use model X".
//  2. Health memory. A provider that failed thirty seconds ago is probably
//     still failing. Probe results are cached so a cascade does not retry a
//     known-dead endpoint on every request.
//  3. Distinguish failure kinds. "Rate limited" means retry elsewhere.
//     "No credentials" means every model on that provider will fail, so stop
//     trying that provider. "Empty response" means reachable but useless, which
//     is the failure mode free tiers actually exhibit -- and the one a naive
//     retry loop will happily hammer forever.

import { EVENTS } from "./events.js";

/** Why an attempt failed. Determines what happens next. */
export const FAILURE = {
  RATE_LIMITED: "rate_limited",
  NO_CREDENTIALS: "no_credentials",
  EMPTY: "empty",
  TIMEOUT: "timeout",
  NETWORK: "network",
  SERVER: "server",
  UNKNOWN: "unknown",
};

// How each failure changes the cascade. This table is the policy.
const FAILURE_DISPOSITION = {
  [FAILURE.RATE_LIMITED]: { retry: true, penaliseProvider: false, retryable: true },
  [FAILURE.TIMEOUT]: { retry: true, penaliseProvider: false, retryable: true },
  [FAILURE.SERVER]: { retry: true, penaliseProvider: false, retryable: true },
  [FAILURE.NETWORK]: { retry: true, penaliseProvider: true, retryable: true },
  [FAILURE.EMPTY]: { retry: true, penaliseProvider: true, retryable: true },
  // No credentials will not fix itself mid-cascade. Skip the whole provider.
  [FAILURE.NO_CREDENTIALS]: { retry: true, penaliseProvider: true, skipProvider: true, retryable: false },
  [FAILURE.UNKNOWN]: { retry: true, penaliseProvider: false, retryable: true },
};

export function dispositionFor(kind) {
  return FAILURE_DISPOSITION[kind] || FAILURE_DISPOSITION[FAILURE.UNKNOWN];
}

/**
 * Classify an error into a failure kind.
 *
 * Ordering matters: check for missing credentials before generic auth errors,
 * because "no key configured" and "key rejected" call for the same action --
 * stop using this provider -- but only the first is fixable by the operator.
 */
export function classifyFailure(err) {
  if (!err) return FAILURE.UNKNOWN;
  const text = `${err.code || ""} ${err.status || err.statusCode || ""} ${err.message || err}`.toLowerCase();

  if (/missing api key|no api key|api key (?:not )?(?:required|missing)|unauthorized|401|invalid_api_key|missing.*key/.test(text)) {
    return FAILURE.NO_CREDENTIALS;
  }
  if (/429|rate.?limit|too many requests|quota|overloaded/.test(text)) return FAILURE.RATE_LIMITED;
  if (/abort|timeout|etimedout|etimedout|socket hang up|deadline/.test(text)) return FAILURE.TIMEOUT;
  if (/econnrefused|enotfound|network|fetch failed|dns|socket|offline|unreachable/.test(text)) return FAILURE.NETWORK;
  if (/50\d|502|503|504|bad gateway|service unavailable|upstream/.test(text)) return FAILURE.SERVER;
  if (/empty|no content|zero.?token|no choices/.test(text)) return FAILURE.EMPTY;
  return FAILURE.UNKNOWN;
}

/** Split "provider/model" into its parts. Bare ids are treated as providers. */
export function parseModelId(id) {
  const raw = String(id || "").trim();
  const slash = raw.indexOf("/");
  if (slash === -1) return { provider: raw, model: raw, raw };
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1), raw };
}

/**
 * Bounded health memory.
 *
 * The point is not to be clever, it is to avoid the failure mode where a
 * cascade hammers a dead provider on every single request. Entries expire so a
 * provider that recovers is retried rather than written off forever.
 */
export class HealthCache {
  constructor({ ttlMs = 60_000, maxEntries = 512, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return hit;
  }

  /**
   * Record a success, clearing any accumulated penalty.
   *
   * The entry is recorded even when no timing was captured. Forgetting a
   * success would demote the model to "unknown", which is strictly worse than
   * knowing it works -- and the whole point of the cache is that a working
   * provider stays first in line.
   */
  markOk(key, elapsedMs = null) {
    this.map.set(key, {
      ok: true,
      at: this.now(),
      elapsedMs: elapsedMs ?? null,
      failures: 0,
    });
    this.evict();
  }

  /**
   * Record a failure. `skipProvider` entries are remembered so the cascade can
   * stop early -- this is what stops a request from trying nine models on a
   * provider that has no credentials.
   */
  markFailure(key, kind, { skipProvider = false } = {}) {
    const prev = this.map.get(key);
    const entry = {
      ok: false,
      at: this.now(),
      kind,
      skipProvider: Boolean(skipProvider),
      failures: (prev?.failures || 0) + 1,
    };
    this.map.set(key, entry);
    this.evict();
    return entry;
  }

  /** True when this provider should be skipped entirely for now. */
  isProviderSkipped(provider) {
    for (const [key, v] of this.map) {
      if (v.skipProvider && parseModelId(key).provider === provider) return true;
    }
    return false;
  }

  evict() {
    // Map preserves insertion order, so the first key is the oldest.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  /** Forget everything. Useful when credentials change mid-process. */
  clear() {
    this.map.clear();
  }

  stats() {
    let ok = 0;
    let failed = 0;
    let skippedProviders = new Set();
    for (const [key, v] of this.map) {
      if (v.ok) ok += 1;
      else {
        failed += 1;
        if (v.skipProvider) skippedProviders.add(parseModelId(key).provider);
      }
    }
    return { ok, failed, skippedProviders: [...skippedProviders], entries: this.map.size };
  }
}

/**
 * Order candidates for an attempt.
 *
 * Healthy candidates first, then unknown, then known-bad. Within a tier the
 * caller's order is preserved, because that order is the user's stated
 * preference and second-guessing it is how you get "why did it pick that?"
 * with no good answer.
 */
export function orderCandidates(candidates, health) {
  const known = [];
  const unknown = [];
  const bad = [];

  candidates.forEach((id, index) => {
    const entry = health.get(id);
    if (!entry) unknown.push({ id, index });
    else if (entry.ok) known.push({ id, index });
    else bad.push({ id, index, entry });
  });

  const score = (a, b) => {
    if (a.entry?.failures !== b.entry?.failures) {
      return (a.entry?.failures || 0) - (b.entry?.failures || 0);
    }
    return a.index - b.index; // stable, respects user order
  };

  return [...known.sort(score), ...unknown.sort((a, b) => a.index - b.index), ...bad.sort(score)].map(
    (c) => c.id
  );
}

/**
 * The router.
 *
 * `execute(modelId, signal)` is injected rather than imported so this stays a
 * pure decision layer: no HTTP, no globals, fully testable. The caller owns
 * transport; the router owns which model to try and why.
 */
export class Router {
  constructor({ tiers, execute, log = null, health = null, now = () => Date.now() } = {}) {
    if (!Array.isArray(tiers) || !tiers.length) throw new Error("Router requires at least one tier");
    if (typeof execute !== "function") throw new Error("Router requires an execute function");

    this.tiers = tiers;
    this.execute = execute;
    this.log = log;
    this.health = health || new HealthCache();
    this.now = now;
  }

  /** Flatten tiers into an ordered candidate list. */
  candidates() {
    return this.tiers.flatMap((t) => t.models || []);
  }

  /**
   * Walk the tiers until something succeeds.
   *
   * Returns a receipt rather than just the value: which model answered, what
   * was tried, why each failure happened. A router that returns only the answer
   * cannot be debugged.
   */
  async route({ signal, onAttempt = null } = {}) {
    const startedAt = this.now();
    const attempts = [];
    const all = orderCandidates(this.candidates(), this.health);
    const skippedProviders = new Set();
    let tierIndex = null;

    for (let t = 0; t < this.tiers.length; t++) {
      const tier = this.tiers[t];
      tierIndex = t;

      for (const modelId of all) {
        if (!tier.models.includes(modelId)) continue;

        const { provider } = parseModelId(modelId);

        // A provider with no credentials will fail identically for every model
        // it offers. Skip the rest rather than repeating a known answer.
        if (skippedProviders.has(provider) || this.health.isProviderSkipped(provider)) {
          if (!skippedProviders.has(provider)) skippedProviders.add(provider);
          attempts.push({ model: modelId, provider, tier: tier.name, outcome: "provider_skipped", reason: FAILURE.NO_CREDENTIALS });
          continue;
        }

        const attemptStart = this.now();
        let outcome;
        let result = null;
        let error = null;

        try {
          result = await this.execute(modelId, { signal, tier: tier.name });
          // An empty completion is a failure, not a success. Free tiers return
          // HTTP 200 with no content, which is the whole reason this module
          // exists.
          outcome = isEmptyResult(result) ? FAILURE.EMPTY : "ok";
        } catch (err) {
          error = err;
          outcome = classifyFailure(err);
        }

        const elapsedMs = this.now() - attemptStart;
        const record = {
          model: modelId,
          provider,
          tier: tier.name,
          outcome,
          elapsedMs,
          error: error ? String(error.message || error) : null,
        };
        attempts.push(record);

        if (onAttempt) {
          try {
            onAttempt(record);
          } catch {
            /* a reporting callback must not break routing */
          }
        }

        this.log?.emit(EVENTS.ROUTE_ATTEMPT, record, outcome === "ok" ? "info" : "warn");

        if (outcome === "ok") {
          this.health.markOk(modelId, elapsedMs);
          const receipt = {
            ok: true,
            model: modelId,
            provider,
            tier: tier.name,
            elapsedMs,
            totalMs: this.now() - startedAt,
            attempts,
            skippedProviders: [...skippedProviders],
            // The executor's value, so callers get the answer without the
            // router needing to know what a completion looks like.
            value: result,
          };
          this.log?.emit(EVENTS.ROUTE_DECISION, {
            model: modelId,
            provider,
            tier: tier.name,
            attempts: attempts.length,
            totalMs: receipt.totalMs,
          });
          return receipt;
        }

        const disp = dispositionFor(outcome);
        this.health.markFailure(modelId, outcome, { skipProvider: disp.skipProvider });
        if (disp.skipProvider) {
          skippedProviders.add(provider);
          this.log?.emit(
            EVENTS.ROUTE_FALLBACK,
            { from: modelId, reason: outcome, action: "skip_provider", provider },
            "warn"
          );
        } else {
          this.log?.emit(EVENTS.ROUTE_FALLBACK, { from: modelId, reason: outcome, action: "try_next" }, "warn");
        }
      }
    }

    this.log?.emit(
      EVENTS.ROUTE_DECISION,
      { ok: false, attempts: attempts.length, tier: this.tiers[tierIndex]?.name ?? null, totalMs: this.now() - startedAt },
      "error"
    );

    return {
      ok: false,
      model: null,
      attempts,
      // Every attempt failed for a reason the operator can act on, so say which.
      failureKinds: [...new Set(attempts.map((a) => a.outcome).filter((o) => o !== "ok" && o !== "provider_skipped"))],
      skippedProviders: [...skippedProviders],
      totalMs: this.now() - startedAt,
      error: buildNoRouteError(attempts),
    };
  }
}

/**
 * Decide whether a successful response actually contained a completion.
 *
 * Handles both shapes that matter: a string body and an OpenAI-style
 * choices array. A 200 with zero tokens is the single most common way a free
 * tier fails, so this check is load-bearing rather than defensive.
 */
export function isEmptyResult(result) {
  if (result == null) return true;
  if (typeof result === "string") return result.trim().length === 0;
  if (Array.isArray(result)) return result.length === 0;

  if (typeof result === "object") {
    const choices = result.choices;
    if (Array.isArray(choices)) {
      if (choices.length === 0) return true;
      const text = choices
        .map((c) => c?.message?.content ?? c?.text ?? c?.delta?.content ?? "")
        .join("");
      return String(text).trim().length === 0;
    }
    if (typeof result.content === "string") return result.content.trim().length === 0;
    if (typeof result.text === "string") return result.text.trim().length === 0;
    if (result.error) return true;
  }
  return false;
}

/**
 * An error message that tells the operator what to do, not just what failed.
 * The failure-kind tally is the useful part: one dead gateway and one
 * unconfigured provider need very different responses.
 */
export function buildNoRouteError(attempts) {
  const kinds = new Set(attempts.map((a) => a.outcome).filter((o) => o !== "ok" && o !== "provider_skipped"));
  const n = attempts.length;
  const parts = [];

  if (kinds.has(FAILURE.NO_CREDENTIALS)) {
    parts.push("no active credentials for one or more providers");
  }
  if (kinds.has(FAILURE.EMPTY)) {
    parts.push("providers responded 200 with no content");
  }
  if (kinds.has(FAILURE.RATE_LIMITED)) parts.push("rate limited");
  if (kinds.has(FAILURE.TIMEOUT) || kinds.has(FAILURE.NETWORK)) parts.push("network unreachable");

  const detail = parts.length ? parts.join("; ") : "no candidate succeeded";
  const err = new Error(`routing failed after ${n} attempt(s): ${detail}`);
  err.attempts = attempts;
  err.failureKinds = [...kinds];
  return err;
}

/**
 * Build tiers from a flat model list.
 *
 * Slices into tiers of `size`, which keeps ordering meaningful: the first model
 * the user named ends up alone in the best tier, so it is genuinely tried
 * first rather than racing everything else for attention.
 */
export function tiersFromList(models, { size = 2, prefix = "tier" } = {}) {
  const out = [];
  for (let i = 0; i < models.length; i += size) {
    const slice = models.slice(i, i + size);
    out.push({ name: `${prefix}${out.length + 1}`, models: slice });
  }
  return out;
}

export default {
  Router,
  HealthCache,
  FAILURE,
  classifyFailure,
  dispositionFor,
  parseModelId,
  orderCandidates,
  isEmptyResult,
  buildNoRouteError,
  tiersFromList,
};