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
  QUOTA: "quota",
  AUTH: "auth",
  INVALID_REQUEST: "invalid_request",
  NO_CREDENTIALS: "no_credentials",
  EMPTY: "empty",
  TIMEOUT: "timeout",
  NETWORK: "network",
  SERVER: "server",
  UNKNOWN: "unknown",
};

// How each failure changes the cascade. This table is the policy.
const FAILURE_DISPOSITION = {
  // A provider that said "slow down" may recover; try elsewhere first. If it
  // sent Retry-After, the router records a cooldown and will not select it again
  // until that time.
  [FAILURE.RATE_LIMITED]: { retry: true, penaliseProvider: false, retryable: true, cooldownFromHeader: true },
  // Exhausted quota, rejected credentials, and malformed requests are permanent
  // for this run. Retrying them just burns the remaining candidates' time.
  [FAILURE.QUOTA]: { retry: false, penaliseProvider: true, skipProvider: true, retryable: false },
  [FAILURE.AUTH]: { retry: false, penaliseProvider: true, skipProvider: true, retryable: false },
  [FAILURE.INVALID_REQUEST]: { retry: false, penaliseProvider: false, retryable: false },
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
  if (/403|forbidden|authentication failed|auth error|permission denied/.test(text)) return FAILURE.AUTH;
  // Quota before rate-limit: "quota exceeded" often arrives with a 429, but it
  // is permanent for the run and must not be retried as a transient slowdown.
  if (/quota|quota_exceeded|insufficient_quota|billing|out of credits|credit balance/.test(text)) return FAILURE.QUOTA;
  if (/400|invalid.?request|bad request|invalid.?argument|validation|unsupported (?:model|parameter)/.test(text)) {
    return FAILURE.INVALID_REQUEST;
  }
  if (/429|rate.?limit|too many requests|overloaded/.test(text)) return FAILURE.RATE_LIMITED;
  if (/abort|timeout|etimedout|socket hang up|deadline/.test(text)) return FAILURE.TIMEOUT;
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
  /**
   * @param {{ tiers?: Array, execute?: Function, log?: object, health?: object, providerHealth?: object, limiter?: object, limiterWaitMs?: number, ledger?: object, now?: () => number }} [options]
   */
  constructor({
    tiers,
    execute,
    log = null,
    health = null,
    providerHealth = null,
    limiter = null,
    limiterWaitMs = null,
    ledger = null,
    now = () => Date.now(),
  } = {}) {
    if (!Array.isArray(tiers) || !tiers.length) throw new Error("Router requires at least one tier");
    if (typeof execute !== "function") throw new Error("Router requires an execute function");

    this.tiers = tiers;
    this.execute = execute;
    this.log = log;
    this.health = health || new HealthCache();
    // Optional provider-level circuit breaker. When absent the router behaves
    // exactly as before: the per-model HealthCache is the only health memory.
    this.providerHealth = providerHealth;
    // Optional rolling-window limiter. A provider with no configured limit is
    // unlimited *locally*; unknown is not treated as exhausted.
    this.limiter = limiter;
    this.limiterWaitMs = limiterWaitMs ?? limiter?.maxWaitMs ?? 5_000;
    // Optional usage ledger. Records observations only; see usage-ledger.js.
    this.ledger = ledger;
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
  /**
   * @param {{ signal?: AbortSignal, onAttempt?: Function }} [opts]
   */
  async route({ signal, onAttempt = null } = {}) {
    const startedAt = this.now();
    const attempts = [];
    const all = orderCandidates(this.candidates(), this.health);
    const skippedProviders = new Set();
    const blockedProviders = new Set();
    const blockReasons = new Map();
    const cooldownProviders = new Set();
    let tierIndex = null;
    let dispatchCount = 0;

    const emitFallback = (from, reason, action, extra = {}) => {
      this.log?.emit(EVENTS.ROUTE_FALLBACK, { from, reason, action, ...extra }, "warn");
    };

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

        // Provider-level circuit breaker and cooldown. A provider that told us
        // "retry after 30s" is not eligible again until then; an open circuit is
        // the same answer from a different source.
        const providerCooldown = this.providerHealth?.getCooldown?.(provider, this.now()) ?? {
          active: false,
          until: null,
          remainingMs: 0,
          reason: null,
          source: null,
        };
        const alreadyBlocked = blockedProviders.has(provider);
        if (alreadyBlocked || providerCooldown.active || (this.providerHealth && !this.providerHealth.canAttempt(provider, this.now()))) {
          const reason = alreadyBlocked
            ? blockReasons.get(provider) || "circuit_open"
            : providerCooldown.active
              ? "cooldown"
              : "circuit_open";
          if (!alreadyBlocked) {
            blockedProviders.add(provider);
            blockReasons.set(provider, reason);
            if (providerCooldown.active) cooldownProviders.add(provider);
            emitFallback(modelId, reason, "skip_provider", {
              provider,
              retryAfterMs: providerCooldown.active ? providerCooldown.remainingMs : null,
            });
          }
          attempts.push({
            model: modelId,
            provider,
            tier: tier.name,
            outcome: reason === "cooldown" ? "provider_cooldown" : "provider_blocked",
            reason,
            retryAfterMs: providerCooldown.active ? providerCooldown.remainingMs : null,
            cooldownUntil: providerCooldown.active ? providerCooldown.until : null,
            dispatched: false,
          });
          continue;
        }

        // Reserve a request slot before executing. With no configured limit this
        // returns immediately; with one it waits only within the bounded budget.
        let reservation = null;
        if (this.limiter) {
          try {
            reservation = await this.limiter.acquire(provider, { signal, maxWaitMs: this.limiterWaitMs });
          } catch (err) {
            const e = /** @type {Error & { code?: string; retryAfterMs?: number|null }} */ (err);
            if (e.code === "rate_limit_cancelled" || signal?.aborted) {
              const cancelled = /** @type {Error & { code: string }} */ (
                new Error("routing cancelled while waiting for a provider")
              );
              cancelled.name = "AbortError";
              cancelled.code = "cancelled";
              return {
                ok: false,
                cancelled: true,
                model: null,
                attempts,
                failureKinds: ["cancelled"],
                skippedProviders: [...skippedProviders],
                blockedProviders: [...blockedProviders],
                cooldownProviders: [...cooldownProviders],
                totalMs: this.now() - startedAt,
                error: cancelled,
              };
            }
            const retryAfterMs = Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : null;
            blockedProviders.add(provider);
            blockReasons.set(provider, "local_rate_limit");
            attempts.push({
              model: modelId,
              provider,
              tier: tier.name,
              outcome: "provider_throttled",
              reason: err?.code || "rate_limit_wait_exceeded",
              retryAfterMs,
              dispatched: false,
              error: String(err?.message || err),
            });
            this.ledger?.record?.({
              provider,
              model: modelId,
              outcome: "provider_throttled",
              dispatched: false,
              retryCount: dispatchCount,
              attempt: dispatchCount + 1,
              quotaSource: this.limiter?.getLimit?.(provider)?.source ?? null,
              errorCode: err?.code || "rate_limit_wait_exceeded",
            });
            emitFallback(modelId, err?.code || "local_rate_limit", "skip_provider", { provider, retryAfterMs });
            continue;
          }
        }

        dispatchCount += 1;
        const attemptNumber = dispatchCount;
        const attemptStart = this.now();
        let outcome;
        let result = null;
        let error = null;
        let dispatched = true;

        // Dispatch is the line between "reserved" and "may have reached the
        // provider". Everything after this point counts against the window even
        // if it fails, unless the executor explicitly proves it never left.
        reservation?.dispatch();

        try {
          result = await this.execute(modelId, { signal, tier: tier.name });
          // An empty completion is a failure, not a success. Free tiers return
          // HTTP 200 with no content, which is the whole reason this module
          // exists.
          outcome = isEmptyResult(result) ? FAILURE.EMPTY : "ok";
        } catch (err) {
          error = err;
          outcome = classifyFailure(err);
          if (err?.dispatched === false) {
            dispatched = false;
            reservation?.release("not_dispatched", { notDispatched: true });
          }
        }

        if (dispatched) reservation?.complete(outcome);

        const elapsedMs = this.now() - attemptStart;
        const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null;
        let appliedCooldown = null;

        // Only provider feedback from a request that may have reached the
        // provider creates a cooldown. A local rate limit is a window, and a
        // request that provably never left the process cannot have been rate
        // limited by the provider.
        if (
          dispatched &&
          outcome === FAILURE.RATE_LIMITED &&
          retryAfterMs != null &&
          retryAfterMs > 0 &&
          this.providerHealth?.setCooldown
        ) {
          appliedCooldown = this.providerHealth.setCooldown(provider, {
            retryAfterMs,
            reason: outcome,
            source: error?.retryAfterSource || "provider",
            meta: { model: modelId },
          });
        }

        const record = {
          model: modelId,
          provider,
          tier: tier.name,
          outcome,
          elapsedMs,
          attempt: attemptNumber,
          retryCount: attemptNumber - 1,
          dispatched,
          retryAfterMs,
          cooldownUntil: appliedCooldown?.until ?? null,
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

        // Ledger observations are per dispatch attempt, not per user turn. A
        // retry is one more request, and a request that never left the process
        // is recorded as such rather than counted as usage.
        this.ledger?.record?.({
          provider,
          model: modelId,
          outcome,
          dispatched,
          retryCount: attemptNumber - 1,
          attempt: attemptNumber,
          usage: outcome === "ok" ? (result?.usage ?? result?.value?.usage ?? null) : null,
          costUsd: result?.costUsd ?? null,
          pricingSource: result?.pricingSource ?? null,
          quotaSource: this.limiter?.getLimit?.(provider)?.source ?? null,
          elapsedMs,
          errorCode: error?.code ?? null,
        });

        if (outcome === "ok") {
          this.health.markOk(modelId, elapsedMs);
          this.providerHealth?.onSuccess(provider, { model: modelId, elapsedMs });
          const receipt = {
            ok: true,
            model: modelId,
            provider,
            tier: tier.name,
            elapsedMs,
            totalMs: this.now() - startedAt,
            attempts,
            skippedProviders: [...skippedProviders],
            blockedProviders: [...blockedProviders],
            cooldownProviders: [...cooldownProviders],
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
        this.providerHealth?.onFailure(provider, outcome, { model: modelId, elapsedMs });

        if (appliedCooldown?.active) {
          blockedProviders.add(provider);
          blockReasons.set(provider, "cooldown");
          cooldownProviders.add(provider);
          emitFallback(modelId, outcome, "cooldown_provider", {
            provider,
            retryAfterMs: appliedCooldown.remainingMs,
            cooldownUntil: appliedCooldown.until,
          });
        } else if (disp.skipProvider) {
          skippedProviders.add(provider);
          emitFallback(modelId, outcome, "skip_provider", { provider });
        } else {
          emitFallback(modelId, outcome, "try_next");
        }
      }
    }

    this.log?.emit(
      EVENTS.ROUTE_DECISION,
      { ok: false, attempts: attempts.length, tier: this.tiers[tierIndex]?.name ?? null, totalMs: this.now() - startedAt },
      "error"
    );

    const error = buildNoRouteError(attempts, this.now());
    return {
      ok: false,
      model: null,
      attempts,
      // Every attempt failed for a reason the operator can act on, so say which.
      failureKinds: [
        ...new Set(
          attempts
            .map((a) => a.outcome)
            .filter((o) => o !== "ok" && o !== "provider_skipped" && o !== "provider_blocked" && o !== "provider_cooldown")
        ),
      ],
      skippedProviders: [...skippedProviders],
      blockedProviders: [...blockedProviders],
      cooldownProviders: [...cooldownProviders],
      totalMs: this.now() - startedAt,
      error,
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
export function buildNoRouteError(attempts, now = Date.now()) {
  const kinds = new Set(
    attempts
      .map((a) => a.outcome)
      .filter((o) => o !== "ok" && o !== "provider_skipped" && o !== "provider_blocked" && o !== "provider_cooldown")
  );
  const n = attempts.length;
  const parts = [];

  if (kinds.has(FAILURE.NO_CREDENTIALS) || kinds.has(FAILURE.AUTH)) {
    parts.push("authentication failed or credentials missing for one or more providers");
  }
  if (kinds.has(FAILURE.QUOTA)) parts.push("provider quota exhausted");
  if (kinds.has(FAILURE.INVALID_REQUEST)) parts.push("provider rejected the request as invalid");
  if (kinds.has(FAILURE.EMPTY)) parts.push("providers responded 200 with no content");
  if (kinds.has(FAILURE.RATE_LIMITED)) parts.push("rate limited");
  if (kinds.has("provider_throttled") || attempts.some((a) => a.reason === "local_rate_limit")) {
    parts.push("local request-rate limit reached");
  }
  if (kinds.has(FAILURE.TIMEOUT) || kinds.has(FAILURE.NETWORK)) parts.push("network unreachable");
  if (attempts.some((a) => a.outcome === "provider_blocked" && a.reason === "circuit_open")) parts.push("provider circuit open");
  if (attempts.some((a) => a.outcome === "provider_cooldown" || a.reason === "cooldown")) {
    parts.push("providers cooling down after provider feedback");
  }

  const detail = parts.length ? parts.join("; ") : "no candidate succeeded";
  const err = /** @type {Error & { attempts: Array, failureKinds: string[], retryAt: number|null }} */ (
    new Error(`routing failed after ${n} attempt(s): ${detail}`)
  );
  err.attempts = attempts;
  err.failureKinds = [...kinds];

  // The earliest moment any cooling-down provider becomes eligible. This is
  // evidence from a header, not an estimate, so it is safe to surface.
  const retryTimes = attempts
    .map((a) => a.cooldownUntil)
    .filter((t) => Number.isFinite(t));
  err.retryAt = retryTimes.length ? Math.min(...retryTimes) : null;
  if (err.retryAt !== null) {
    const waitMs = Math.max(0, err.retryAt - now);
    parts.push(`earliest retry in ${Math.ceil(waitMs / 1000)}s`);
    err.message = `routing failed after ${n} attempt(s): ${parts.join("; ")}`;
  }
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