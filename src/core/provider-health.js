// Provider health store: provider-scoped health/classification and circuit breaker.
//
// Keeps bounded history, tracks circuit state (CLOSED/OPEN/HALF_OPEN), and
// maps failure classifications to provider status/backoff. Deterministic via
// injectable now() and bounded structures.

import { redactDeep } from "./redact.js";

export const PROVIDER_STATUS = {
  UNKNOWN: "unknown",
  PROBING: "probing",
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  DEAD: "dead",
  UNAUTHENTICATED: "unauthenticated",
};

export const CIRCUIT_STATE = {
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
};

export const FAILURE_CLASS = {
  RATE_LIMITED: "rate_limited",
  QUOTA: "quota",
  NO_CREDENTIALS: "no_credentials",
  UNAUTHENTICATED: "unauthenticated",
  AUTH: "auth",
  NETWORK: "network",
  SERVER: "server",
  EMPTY: "empty",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
  SUCCESS: "success",
};

const DEFAULT_OPTIONS = {
  ttlMs: 300_000,
  maxHistory: 50,
  maxBackoffMs: 600_000,
  baseBackoffMs: 30_000,
  backoffMultiplier: 2,
  openAfterFailures: 3,
  maxCooldownMs: 24 * 60 * 60 * 1000,
  now: () => Date.now(),
  jitter: (v) => v,
};

export class CircuitBreaker {
  constructor(opts = {}) {
    const o = { ...DEFAULT_OPTIONS, ...opts };
    this.baseBackoffMs = o.baseBackoffMs;
    this.backoffMultiplier = o.backoffMultiplier;
    this.maxBackoffMs = o.maxBackoffMs;
    this.openAfterFailures = o.openAfterFailures;
    this.now = o.now;
    this.jitter = o.jitter;
    this.state = CIRCUIT_STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.openedAt = null;
    this.halfOpenAllowedAt = null;
    this.nextProbeAt = null;
    this.backoffMs = this.baseBackoffMs;
  }

  get stateInfo() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      successCount: this.successCount,
      failureCount: this.failureCount,
      openedAt: this.openedAt,
      halfOpenAllowedAt: this.halfOpenAllowedAt,
      nextProbeAt: this.nextProbeAt,
      backoffMs: this.backoffMs,
    };
  }

  resetToClosed() {
    this.state = CIRCUIT_STATE.CLOSED;
    this.consecutiveFailures = 0;
    this.backoffMs = this.baseBackoffMs;
    this.halfOpenAllowedAt = null;
    this.openedAt = null;
    this.nextProbeAt = null;
  }

  onSuccess() {
    this.successCount += 1;
    this.consecutiveFailures = 0;
    this.resetToClosed();
  }

  onFailure() {
    const now = this.now();
    this.failureCount += 1;
    this.consecutiveFailures += 1;

    if (this.state === CIRCUIT_STATE.CLOSED) {
      if (this.consecutiveFailures >= this.openAfterFailures) {
        this._open(now);
      }
      return;
    }

    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this._open(now, true);
      return;
    }

    if (this.state === CIRCUIT_STATE.OPEN) {
      this.nextProbeAt = this.halfOpenAllowedAt;
      return;
    }
  }

  _open(now, fromHalfOpen = false) {
    this.state = CIRCUIT_STATE.OPEN;
    this.openedAt = now;
    if (fromHalfOpen) {
      this.backoffMs = Math.min(this.backoffMs * this.backoffMultiplier, this.maxBackoffMs);
    }
    const next = this.jitter(this.backoffMs);
    this.halfOpenAllowedAt = now + next;
    this.nextProbeAt = this.halfOpenAllowedAt;
  }

  canAttempt(now = this.now()) {
    if (this.state === CIRCUIT_STATE.CLOSED) return true;
    if (this.state === CIRCUIT_STATE.HALF_OPEN) return true;
    if (this.state === CIRCUIT_STATE.OPEN) {
      if (this.halfOpenAllowedAt == null) return true;
      if (now >= this.halfOpenAllowedAt) {
        this.state = CIRCUIT_STATE.HALF_OPEN;
        this.halfOpenAllowedAt = now;
        this.nextProbeAt = now;
        return true;
      }
      return false;
    }
    return true;
  }

  shouldProbe(now = this.now()) {
    if (this.state === CIRCUIT_STATE.OPEN) {
      if (this.halfOpenAllowedAt == null) return true;
      return now >= this.halfOpenAllowedAt;
    }
    if (this.state === CIRCUIT_STATE.HALF_OPEN) return true;
    return false;
  }

  markProbing() {
    this.state = CIRCUIT_STATE.HALF_OPEN;
  }
}

export class ProviderHealth {
  constructor(opts = {}) {
    const o = { ...DEFAULT_OPTIONS, ...opts };
    this.ttlMs = o.ttlMs;
    this.maxHistory = o.maxHistory;
    this.now = o.now;
    this.jitter = o.jitter;
    this.baseBackoffMs = o.baseBackoffMs;
    this.backoffMultiplier = o.backoffMultiplier;
    this.maxBackoffMs = o.maxBackoffMs;
    this.openAfterFailures = o.openAfterFailures;
    this.maxCooldownMs = o.maxCooldownMs;
    this._providers = new Map();
  }

  _ensure(provider) {
    const key = String(provider || "").trim();
    if (!key) throw new Error("provider id required");
    if (!this._providers.has(key)) {
      this._providers.set(key, this._createRecord(key));
    }
    return this._providers.get(key);
  }

  _createRecord(provider) {
    return {
      provider,
      status: PROVIDER_STATUS.UNKNOWN,
      history: [],
      cb: new CircuitBreaker({
        baseBackoffMs: this.baseBackoffMs,
        backoffMultiplier: this.backoffMultiplier,
        maxBackoffMs: this.maxBackoffMs,
        openAfterFailures: this.openAfterFailures,
        now: this.now,
        jitter: this.jitter,
      }),
      lastSuccessAt: null,
      lastFailureAt: null,
      lastProbeAt: null,
      lastOutcome: null,
      lastFailureType: null,
      cooldownUntil: null,
      cooldownReason: null,
      cooldownSource: null,
      cooldownSetAt: null,
    };
  }

  getProviderStatus(provider) {
    const key = provider == null ? "" : String(provider);
    const rec = key ? this._providers.get(key) : null;
    if (!rec) {
      return {
        provider: key || null,
        status: PROVIDER_STATUS.UNKNOWN,
        circuitState: CIRCUIT_STATE.CLOSED,
        consecutiveFailures: 0,
        failureCount: 0,
        successCount: 0,
        openedAt: null,
        halfOpenAllowedAt: null,
        nextProbeAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastProbeAt: null,
        lastOutcome: null,
        lastFailureType: null,
        cooldownUntil: null,
        cooldownRemainingMs: 0,
        cooldownReason: null,
        cooldownSource: null,
        backoffMs: 0,
        history: [],
      };
    }
    const cb = rec.cb.stateInfo;
    const cooldown = this.getCooldown(provider);
    return {
      provider: rec.provider,
      status: rec.status,
      circuitState: cb.state,
      consecutiveFailures: cb.consecutiveFailures,
      failureCount: cb.failureCount,
      successCount: cb.successCount,
      openedAt: cb.openedAt,
      halfOpenAllowedAt: cb.halfOpenAllowedAt,
      nextProbeAt: cb.nextProbeAt,
      lastSuccessAt: rec.lastSuccessAt,
      lastFailureAt: rec.lastFailureAt,
      lastProbeAt: rec.lastProbeAt,
      lastOutcome: rec.lastOutcome,
      lastFailureType: rec.lastFailureType,
      cooldownUntil: cooldown.until,
      cooldownRemainingMs: cooldown.remainingMs,
      cooldownReason: cooldown.reason,
      cooldownSource: cooldown.source,
      backoffMs: cb.backoffMs,
      history: rec.history.slice(-this.maxHistory),
    };
  }

  shouldProbe(provider, now = this.now()) {
    const rec = this._ensure(provider);
    return rec.cb.shouldProbe(now);
  }

  /**
   * Read the provider-scoped cooldown established by provider feedback.
   *
   * An expired cooldown is cleared on read, so `canAttempt` returns true without
   * needing a separate sweep. The returned object is always defined; `active`
   * is the only field callers need to branch on.
   */
  getCooldown(provider, now = this.now()) {
    const key = provider == null ? "" : String(provider);
    const rec = key ? this._providers.get(key) : null;
    if (!rec || rec.cooldownUntil == null) {
      return { active: false, until: null, remainingMs: 0, reason: null, source: null };
    }
    if (now >= rec.cooldownUntil) {
      this.clearCooldown(key);
      return { active: false, until: null, remainingMs: 0, reason: null, source: null };
    }
    return {
      active: true,
      until: rec.cooldownUntil,
      remainingMs: Math.max(0, rec.cooldownUntil - now),
      reason: rec.cooldownReason,
      source: rec.cooldownSource,
    };
  }

  /**
   * Apply a provider-scoped cooldown from external evidence (Retry-After).
   *
   * `retryAfterMs` is clamped to `maxCooldownMs` so a broken or hostile header
   * cannot park a provider forever. A zero/past value clears the cooldown
   * instead of creating a no-op one.
   *
   * @param {string} provider
   * @param {{ retryAfterMs?: number|null, until?: number|null, reason?: string|null, source?: string|null, meta?: object }} [opts]
   */
  setCooldown(provider, { retryAfterMs = null, until = null, reason = FAILURE_CLASS.RATE_LIMITED, source = "provider", meta = {} } = {}) {
    const rec = this._ensure(provider);
    const now = this.now();
    const requested = Number.isFinite(until)
      ? Number(until)
      : Number.isFinite(Number(retryAfterMs))
        ? now + Math.max(0, Number(retryAfterMs))
        : now;
    if (!Number.isFinite(requested) || requested <= now) {
      this.clearCooldown(provider);
      return this.getCooldown(provider, now);
    }
    const cap = now + this.maxCooldownMs;
    const clamped = requested > cap;
    rec.cooldownUntil = clamped ? cap : requested;
    rec.cooldownReason = reason ?? FAILURE_CLASS.RATE_LIMITED;
    rec.cooldownSource = source ?? "provider";
    rec.cooldownSetAt = now;
    this._pushHistory(rec, {
      ts: now,
      type: "cooldown",
      ok: false,
      meta: redactDeep({
        reason: rec.cooldownReason,
        source: rec.cooldownSource,
        retryAfterMs: Number.isFinite(Number(retryAfterMs)) ? Number(retryAfterMs) : null,
        until: rec.cooldownUntil,
        clamped,
        ...(meta && typeof meta === "object" ? meta : {}),
      }),
    });
    return this.getCooldown(provider, now);
  }

  clearCooldown(provider) {
    const key = provider == null ? "" : String(provider);
    const rec = key ? this._providers.get(key) : null;
    if (!rec) return;
    rec.cooldownUntil = null;
    rec.cooldownReason = null;
    rec.cooldownSource = null;
    rec.cooldownSetAt = null;
  }

  canAttempt(provider, now = this.now()) {
    if (this.getCooldown(provider, now).active) return false;
    const rec = this._ensure(provider);
    return rec.cb.canAttempt(now);
  }

  markProbing(provider) {
    const rec = this._ensure(provider);
    rec.status = PROVIDER_STATUS.PROBING;
    rec.lastProbeAt = this.now();
    rec.cb.markProbing();
    return this.getProviderStatus(provider);
  }

  onSuccess(provider, meta = {}) {
    const rec = this._ensure(provider);
    const now = this.now();
    rec.cb.onSuccess();
    this.clearCooldown(provider);
    rec.status = PROVIDER_STATUS.HEALTHY;
    rec.lastSuccessAt = now;
    rec.lastOutcome = FAILURE_CLASS.SUCCESS;
    this._pushHistory(rec, { ts: now, type: FAILURE_CLASS.SUCCESS, ok: true, meta: redactDeep(meta || {}) });
    return this.getProviderStatus(provider);
  }

  onFailure(provider, failureType = FAILURE_CLASS.UNKNOWN, meta = {}) {
    const ft = this._normalizeFailureType(failureType);
    const rec = this._ensure(provider);
    const now = this.now();
    rec.cb.onFailure();
    rec.lastFailureAt = now;
    rec.lastFailureType = ft;
    rec.lastOutcome = ft;
    rec.status = this._mapStatusForFailure(ft);
    this._pushHistory(rec, { ts: now, type: ft, ok: false, meta: redactDeep(meta || {}) });
    return this.getProviderStatus(provider);
  }

  _normalizeFailureType(ft) {
    if (!ft) return FAILURE_CLASS.UNKNOWN;
    const v = String(ft).toLowerCase();
    if (v === "rate_limited" || v === "rate-limit" || v === "429") return FAILURE_CLASS.RATE_LIMITED;
    if (v === "quota" || v === "quota_exceeded") return FAILURE_CLASS.QUOTA;
    if (v === "no_credentials" || v === "no-credentials" || v === "missing_api_key" || v === "missing key") return FAILURE_CLASS.NO_CREDENTIALS;
    if (v === "unauthenticated" || v === "unauthorized" || v === "401" || v === "auth" || v === "authentication") return FAILURE_CLASS.UNAUTHENTICATED;
    if (v === "network" || v === "econnrefused" || v === "enotfound" || v === "unreachable" || v === "fetch failed") return FAILURE_CLASS.NETWORK;
    if (v === "server" || v === "5xx" || v === "bad gateway" || v === "service unavailable" || v === "502" || v === "503" || v === "504") return FAILURE_CLASS.SERVER;
    if (v === "empty" || v === "no content") return FAILURE_CLASS.EMPTY;
    if (v === "timeout" || v === "timedout" || v === "etimedout" || v === "aborted" || v === "abort") return FAILURE_CLASS.TIMEOUT;
    if (v === "success" || v === "ok") return FAILURE_CLASS.SUCCESS;
    return FAILURE_CLASS.UNKNOWN;
  }

  _mapStatusForFailure(ft) {
    switch (ft) {
      case FAILURE_CLASS.NO_CREDENTIALS:
      case FAILURE_CLASS.UNAUTHENTICATED:
      case FAILURE_CLASS.AUTH:
        return PROVIDER_STATUS.UNAUTHENTICATED;
      case FAILURE_CLASS.RATE_LIMITED:
      case FAILURE_CLASS.QUOTA:
      case FAILURE_CLASS.NETWORK:
      case FAILURE_CLASS.SERVER:
      case FAILURE_CLASS.TIMEOUT:
      case FAILURE_CLASS.EMPTY:
      case FAILURE_CLASS.UNKNOWN:
      default:
        return PROVIDER_STATUS.DEGRADED;
    }
  }

  _pushHistory(rec, entry) {
    rec.history.push(entry);
    if (rec.history.length > this.maxHistory) {
      rec.history.splice(0, rec.history.length - this.maxHistory);
    }
  }

  toJSON() {
    const out = {};
    for (const [k, rec] of this._providers) {
      const cb = rec.cb.stateInfo;
      out[k] = {
        provider: rec.provider,
        status: rec.status,
        circuitState: cb.state,
        consecutiveFailures: cb.consecutiveFailures,
        failureCount: cb.failureCount,
        successCount: cb.successCount,
        openedAt: cb.openedAt,
        halfOpenAllowedAt: cb.halfOpenAllowedAt,
        nextProbeAt: cb.nextProbeAt,
        lastSuccessAt: rec.lastSuccessAt,
        lastFailureAt: rec.lastFailureAt,
        lastProbeAt: rec.lastProbeAt,
        lastOutcome: rec.lastOutcome,
        lastFailureType: rec.lastFailureType,
        cooldownUntil: rec.cooldownUntil,
        cooldownReason: rec.cooldownReason,
        cooldownSource: rec.cooldownSource,
        cooldownSetAt: rec.cooldownSetAt,
        backoffMs: cb.backoffMs,
        history: rec.history.slice(-this.maxHistory).map((h) => redactDeep(h)),
      };
    }
    return out;
  }

  fromJSON(obj) {
    this._providers.clear();
    if (!obj || typeof obj !== "object") return this;
    for (const [k, data] of Object.entries(obj)) {
      const rec = this._createRecord(k);
      rec.status = data.status || PROVIDER_STATUS.UNKNOWN;
      rec.lastSuccessAt = data.lastSuccessAt ?? null;
      rec.lastFailureAt = data.lastFailureAt ?? null;
      rec.lastProbeAt = data.lastProbeAt ?? null;
      rec.lastOutcome = data.lastOutcome ?? null;
      rec.lastFailureType = data.lastFailureType ?? null;
      rec.cooldownUntil = Number.isFinite(data.cooldownUntil)
        ? Math.min(Number(data.cooldownUntil), this.now() + this.maxCooldownMs)
        : null;
      rec.cooldownReason = rec.cooldownUntil == null ? null : (data.cooldownReason ?? null);
      rec.cooldownSource = rec.cooldownUntil == null ? null : (data.cooldownSource ?? null);
      rec.cooldownSetAt = rec.cooldownUntil == null ? null : (data.cooldownSetAt ?? null);
      rec.history = Array.isArray(data.history) ? data.history.slice(-this.maxHistory) : [];
      rec.cb.state = data.circuitState || CIRCUIT_STATE.CLOSED;
      rec.cb.consecutiveFailures = data.consecutiveFailures || 0;
      rec.cb.failureCount = data.failureCount || 0;
      rec.cb.successCount = data.successCount || 0;
      rec.cb.openedAt = data.openedAt ?? null;
      rec.cb.halfOpenAllowedAt = data.halfOpenAllowedAt ?? null;
      rec.cb.nextProbeAt = data.nextProbeAt ?? null;
      rec.cb.backoffMs = data.backoffMs || this.baseBackoffMs;
      this._providers.set(k, rec);
    }
    return this;
  }
}
