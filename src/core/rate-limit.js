// Request-rate limiting and provider feedback.
//
// `ratePerMin` in the provider registry is a *request-rate* hint, not a daily
// quota, token budget, or billing limit. This module treats it as exactly that:
// at most N requests per rolling window, counted at dispatch time, per provider.
//
// Two distinctions drive the design:
//
//  1. Reserved is not dispatched. A permit is held before the executor runs so
//     concurrent callers cannot oversubscribe a known budget. If the executor
//     proves it never reached the network, the permit is released without
//     consuming the window. Once dispatch may have happened, the request stays
//     counted even if it failed -- the provider may have seen it.
//  2. Waiting is bounded. `acquire` never sleeps past its deadline, and it
//     fails fast when the next slot is further away than the caller is willing
//     to wait. Routing then moves to another candidate instead of hanging.
//
// Unknown limits are unlimited *locally* -- not evidence that the provider has
// quota left. Provider feedback (Retry-After) is the only source that can
// establish a cooldown, and that lives in ProviderHealth, not here.

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  maxWaitMs: 5_000,
  pollMs: 25,
  maxProviders: 128,
  maxWindowEntries: 10_000,
});

/** Retry-After values beyond this are clamped rather than trusted forever. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

// The three HTTP-date forms in RFC 9110. Date.parse() alone is too permissive:
// it happily reads "1.5" as a date, which must be malformed for Retry-After.
const HTTP_DATE_RE =
  /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;

export class RateLimitWaitError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, provider?: string, retryAfterMs?: number|null }} [opts]
   */
  constructor(message, { code = "rate_limit_wait_exceeded", provider = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = "RateLimitWaitError";
    this.code = code;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse an HTTP `Retry-After` header.
 *
 * Supports both forms in RFC 9110: delay-seconds and HTTP-date. Missing,
 * malformed, negative, and already-past values are reported rather than turned
 * into a cooldown. A value beyond `MAX_RETRY_AFTER_MS` is clamped and marked so
 * diagnostics can say the wait was capped.
 *
 * @param {string|number|null|undefined} value
 * @param {number} [now]
 * @returns {{ ms: number|null, source: "seconds"|"http-date"|null, raw: string|null, clamped: boolean, expired: boolean, reason: string|null }}
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) {
    return { ms: null, source: null, raw: null, clamped: false, expired: false, reason: "missing" };
  }
  const raw = String(value).trim();
  if (!raw) {
    return { ms: null, source: null, raw, clamped: false, expired: false, reason: "empty" };
  }

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) {
      return { ms: null, source: null, raw, clamped: false, expired: false, reason: "malformed" };
    }
    const ms = seconds * 1000;
    if (ms === 0) {
      return { ms: 0, source: "seconds", raw, clamped: false, expired: true, reason: null };
    }
    if (ms > MAX_RETRY_AFTER_MS) {
      return { ms: MAX_RETRY_AFTER_MS, source: "seconds", raw, clamped: true, expired: false, reason: "clamped" };
    }
    return { ms, source: "seconds", raw, clamped: false, expired: false, reason: null };
  }

  // A negative or fractional number is malformed for Retry-After, not a date.
  if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    return { ms: null, source: null, raw, clamped: false, expired: false, reason: "malformed" };
  }

  if (!HTTP_DATE_RE.test(raw)) {
    return { ms: null, source: null, raw, clamped: false, expired: false, reason: "malformed" };
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return { ms: null, source: null, raw, clamped: false, expired: false, reason: "malformed" };
  }
  const delta = at - now;
  if (delta <= 0) {
    return { ms: 0, source: "http-date", raw, clamped: false, expired: true, reason: null };
  }
  if (delta > MAX_RETRY_AFTER_MS) {
    return { ms: MAX_RETRY_AFTER_MS, source: "http-date", raw, clamped: true, expired: false, reason: "clamped" };
  }
  return { ms: delta, source: "http-date", raw, clamped: false, expired: false, reason: null };
}

/** Default sleep that honours cancellation. */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RateLimitWaitError("request cancelled while waiting for a rate-limit slot", { code: "rate_limit_cancelled" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RateLimitWaitError("request cancelled while waiting for a rate-limit slot", { code: "rate_limit_cancelled" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** One held permit. `dispatch()` is the line between reserved and possibly-seen. */
class Reservation {
  constructor(limiter, provider, limit) {
    this.limiter = limiter;
    this.provider = provider;
    this.limit = limit;
    this.state = "reserved";
    this.reservedAt = limiter.now();
    this.dispatchedAt = null;
    this.outcome = null;
  }

  /** True once the request may have reached the provider. */
  get dispatched() {
    return this.state === "dispatched" || this.state === "completed";
  }

  /** Mark the request as actually sent. Counts against the rolling window. */
  dispatch() {
    if (this.state !== "reserved") return this;
    if (this.limit != null) this.limiter._dispatch(this);
    this.state = "dispatched";
    this.dispatchedAt = this.limiter.now();
    return this;
  }

  /** Finish the attempt. A still-reserved permit was never dispatched. */
  complete(outcome = "ok") {
    this.outcome = outcome;
    if (this.state === "reserved") {
      this.release("never_dispatched");
    } else if (this.state === "dispatched") {
      this.state = "completed";
    }
    return this;
  }

  /**
   * Release a permit.
   *
   * `notDispatched` is the only way to un-count a dispatched permit: it is for
   * an executor that can prove the request never left the process. Without that
   * proof the conservative answer is to leave it counted.
   */
  release(reason = "released", { notDispatched = false } = {}) {
    if (this.state === "released") return this;
    if (this.state === "reserved") {
      this.limiter._releasePending(this);
    } else if (this.state === "dispatched") {
      if (notDispatched && this.limit != null) this.limiter._uncount(this);
      else this.state = "completed";
    }
    if (this.state !== "completed") this.state = "released";
    this.outcome = reason;
    return this;
  }
}

export class RollingWindowLimiter {
  /**
   * @param {{ now?: () => number, windowMs?: number, maxWaitMs?: number, pollMs?: number, limits?: object, sleep?: Function, maxProviders?: number, maxWindowEntries?: number }} [options]
   */
  constructor({
    now = () => Date.now(),
    windowMs = RATE_LIMIT_DEFAULTS.windowMs,
    maxWaitMs = RATE_LIMIT_DEFAULTS.maxWaitMs,
    pollMs = RATE_LIMIT_DEFAULTS.pollMs,
    limits = {},
    sleep = defaultSleep,
    maxProviders = RATE_LIMIT_DEFAULTS.maxProviders,
    maxWindowEntries = RATE_LIMIT_DEFAULTS.maxWindowEntries,
  } = {}) {
    this.now = now;
    this.windowMs = normalisePositive(windowMs, RATE_LIMIT_DEFAULTS.windowMs);
    this.maxWaitMs = normaliseNonNegative(maxWaitMs, RATE_LIMIT_DEFAULTS.maxWaitMs);
    this.pollMs = normalisePositive(pollMs, RATE_LIMIT_DEFAULTS.pollMs);
    this.sleep = typeof sleep === "function" ? sleep : defaultSleep;
    this.maxProviders = maxProviders;
    this.maxWindowEntries = maxWindowEntries;
    this._providers = new Map();
    this.setLimits(limits);
  }

  /**
   * Register a provider limit. `limit` is requests per `windowMs`; a non-positive
   * or non-finite value removes the limit, returning the provider to the
   * unlimited-local default.
   *
   * @param {string} provider
   * @param {number|{ limit: number, windowMs?: number, source?: string }} limit
   * @param {{ windowMs?: number, source?: string }} [opts]
   */
  setLimit(provider, limit, { windowMs = this.windowMs, source = "configured" } = {}) {
    const key = normaliseProvider(provider);
    if (!key) return null;
    const spec = limit && typeof limit === "object" ? limit : { limit };
    const n = Number(spec.limit);
    if (!Number.isFinite(n) || n <= 0) {
      this._providers.delete(key);
      return null;
    }
    const cfg = {
      provider: key,
      limit: Math.max(1, Math.floor(n)),
      windowMs: normalisePositive(spec.windowMs ?? windowMs, this.windowMs),
      source: String(spec.source ?? source),
    };
    this._providers.set(key, cfg);
    this._evictProviders();
    return { ...cfg };
  }

  /** Bulk form of setLimit. Values may be numbers or `{ limit, windowMs, source }`. */
  setLimits(limits = {}) {
    if (!limits || typeof limits !== "object") return this;
    for (const [provider, spec] of Object.entries(limits)) this.setLimit(provider, spec);
    return this;
  }

  getLimit(provider) {
    const key = normaliseProvider(provider);
    const cfg = key ? this._providers.get(key) : null;
    return cfg ? { ...cfg } : null;
  }

  hasLimit(provider) {
    return Boolean(this.getLimit(provider));
  }

  _evictProviders() {
    while (this._providers.size > this.maxProviders) {
      const oldest = this._providers.keys().next().value;
      this._providers.delete(oldest);
    }
  }

  _state(provider) {
    const key = normaliseProvider(provider);
    let state = this._providersState?.get?.(key);
    if (!state) {
      if (!this._providersState) this._providersState = new Map();
      state = { provider: key, dispatched: [], pending: new Set(), waitCount: 0, lastWaitMs: 0 };
      this._providersState.set(key, state);
      while (this._providersState.size > this.maxProviders) {
        const oldest = this._providersState.keys().next().value;
        this._providersState.delete(oldest);
      }
    }
    return state;
  }

  _prune(state, now) {
    const windowMs = this._providers.get(state.provider)?.windowMs ?? this.windowMs;
    const cutoff = now - windowMs;
    while (state.dispatched.length && state.dispatched[0] <= cutoff) state.dispatched.shift();
  }

  _dispatch(reservation) {
    const state = this._state(reservation.provider);
    state.pending.delete(reservation);
    state.dispatched.push(this.now());
    if (state.dispatched.length > this.maxWindowEntries) {
      state.dispatched.splice(0, state.dispatched.length - this.maxWindowEntries);
    }
  }

  _releasePending(reservation) {
    this._state(reservation.provider).pending.delete(reservation);
  }

  _uncount(reservation) {
    const state = this._state(reservation.provider);
    const at = reservation.dispatchedAt;
    const idx = state.dispatched.lastIndexOf(at);
    if (idx !== -1) state.dispatched.splice(idx, 1);
  }

  _waitTime(state, cfg, now) {
    const capacity = cfg.limit - state.dispatched.length;
    if (capacity - state.pending.size > 0) return { waitMs: 0, blockedBy: null };

    if (capacity <= 0) {
      const oldest = state.dispatched[0];
      const waitMs = Math.max(1, oldest + cfg.windowMs - now);
      return { waitMs, blockedBy: "window" };
    }

    // Capacity exists but every slot is held by a reservation that has not
    // dispatched yet. Poll: the holder may dispatch (freeing nothing) or
    // release (freeing the slot). A bounded poll avoids a busy loop without
    // pretending we can predict another caller's timing.
    return { waitMs: Math.min(this.pollMs, Math.max(1, cfg.windowMs)), blockedBy: "pending" };
  }

  /**
   * Wait for a permit, bounded by `maxWaitMs` and cancellation.
   *
   * Throws RateLimitWaitError with code `rate_limit_wait_exceeded` when the next
   * slot is beyond the deadline, or `rate_limit_cancelled` when the signal
   * aborts. With no configured limit it returns an unlimited reservation
   * immediately -- unknown local state must not be treated as exhausted.
   *
   * @param {string} provider
   * @param {{ signal?: AbortSignal|null, maxWaitMs?: number }} [opts]
   * @returns {Promise<Reservation>}
   */
  async acquire(provider, { signal = null, maxWaitMs = this.maxWaitMs } = {}) {
    const key = normaliseProvider(provider);
    const cfg = this.getLimit(key);
    const reservation = new Reservation(this, key, cfg?.limit ?? null);
    if (!cfg) return reservation;

    const waitBudget = normaliseNonNegative(maxWaitMs, this.maxWaitMs);
    const deadline = this.now() + waitBudget;
    const state = this._state(key);

    for (;;) {
      if (signal?.aborted) {
        throw new RateLimitWaitError("request cancelled while waiting for a rate-limit slot", {
          code: "rate_limit_cancelled",
          provider: key,
        });
      }
      const now = this.now();
      this._prune(state, now);
      const wait = this._waitTime(state, cfg, now);
      if (wait.waitMs === 0) {
        state.pending.add(reservation);
        state.waitCount += 1;
        state.lastWaitMs = Math.max(0, now - reservation.reservedAt);
        return reservation;
      }

      const remaining = deadline - now;
      if (remaining <= 0 || wait.waitMs > remaining) {
        state.lastWaitMs = Math.max(0, now - reservation.reservedAt);
        throw new RateLimitWaitError(
          `provider ${key} is at its local request limit (${cfg.limit}/${cfg.windowMs}ms); next slot in ${Math.ceil(
            wait.waitMs / 1000
          )}s`,
          { code: "rate_limit_wait_exceeded", provider: key, retryAfterMs: wait.waitMs }
        );
      }

      try {
        await this.sleep(wait.waitMs, signal);
      } catch (err) {
        if (err instanceof RateLimitWaitError) throw err;
        if (signal?.aborted) {
          throw new RateLimitWaitError("request cancelled while waiting for a rate-limit slot", {
            code: "rate_limit_cancelled",
            provider: key,
          });
        }
        throw new RateLimitWaitError(`rate-limit wait failed: ${err?.message || err}`, {
          code: "rate_limit_wait_failed",
          provider: key,
        });
      }
    }
  }

  /** Milliseconds until this provider could accept a request, or 0. */
  availableIn(provider, now = this.now()) {
    const cfg = this.getLimit(provider);
    if (!cfg) return 0;
    const state = this._state(provider);
    this._prune(state, now);
    const wait = this._waitTime(state, cfg, now);
    return wait.waitMs;
  }

  /** Dynamic state for diagnostics. Static limit metadata is included separately. */
  snapshot(provider, now = this.now()) {
    const cfg = this.getLimit(provider);
    if (!cfg) {
      return {
        provider: normaliseProvider(provider),
        limited: false,
        limit: null,
        windowMs: null,
        source: null,
        used: null,
        pending: null,
        remaining: null,
        resetAt: null,
        availableInMs: 0,
      };
    }
    const state = this._state(provider);
    this._prune(state, now);
    const wait = this._waitTime(state, cfg, now);
    return {
      provider: cfg.provider,
      limited: true,
      limit: cfg.limit,
      windowMs: cfg.windowMs,
      source: cfg.source,
      used: state.dispatched.length,
      pending: state.pending.size,
      remaining: Math.max(0, cfg.limit - state.dispatched.length - state.pending.size),
      resetAt: state.dispatched.length ? state.dispatched[0] + cfg.windowMs : null,
      availableInMs: wait.waitMs,
    };
  }

  snapshotAll(now = this.now()) {
    return [...this._providers.keys()].map((p) => this.snapshot(p, now));
  }

  toJSON() {
    const providers = {};
    for (const [provider, cfg] of this._providers) {
      const state = this._state(provider);
      providers[provider] = {
        ...cfg,
        dispatched: state.dispatched.slice(),
      };
    }
    return { version: 1, providers };
  }

  fromJSON(obj) {
    this._providers.clear();
    this._providersState = new Map();
    if (!obj || typeof obj !== "object" || !obj.providers) return this;
    const now = this.now();
    for (const [provider, data] of Object.entries(obj.providers)) {
      const cfg = this.setLimit(provider, data);
      if (!cfg) continue;
      const state = this._state(provider);
      state.dispatched = (Array.isArray(data.dispatched) ? data.dispatched : [])
        .map(Number)
        .filter((t) => Number.isFinite(t) && t > now - cfg.windowMs && t <= now)
        .sort((a, b) => a - b)
        .slice(-this.maxWindowEntries);
    }
    return this;
  }
}

/**
 * Build limiter configuration from the provider registry's `ratePerMin`.
 *
 * Only providers with a positive integer are limited. `null` means the registry
 * has no confirmed request-rate semantics for that provider, so no local limit
 * is invented.
 *
 * @param {object} providers
 * @param {{ windowMs?: number, source?: string }} [opts]
 */
export function rateLimitsFromRegistry(providers, { windowMs = RATE_LIMIT_DEFAULTS.windowMs, source = "provider-registry:ratePerMin" } = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(providers || {})) {
    const n = Number(spec?.ratePerMin);
    if (Number.isFinite(n) && n > 0) {
      out[name] = { limit: Math.floor(n), windowMs, source };
    }
  }
  return out;
}

function normaliseProvider(provider) {
  return String(provider || "").trim();
}

function normalisePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normaliseNonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default {
  RATE_LIMIT_DEFAULTS,
  MAX_RETRY_AFTER_MS,
  RateLimitWaitError,
  RollingWindowLimiter,
  parseRetryAfter,
  rateLimitsFromRegistry,
};
