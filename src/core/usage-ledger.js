// Lightweight usage ledger.
//
// This is deliberately not a billing system. It records what was observed about
// a request and says "unknown" for everything else:
//
//   - Tokens come only from the provider's `usage` object. Missing fields stay
//     null; nothing is estimated from prompt length.
//   - Money is recorded only when the caller supplies both a finite amount and a
//     named pricing source. The ledger never multiplies tokens by a price it
//     guessed.
//   - Quota state is recorded as the source of a local limit (for example the
//     provider registry's `ratePerMin`), never as a remaining account balance.
//
// Records are bounded in memory and contain no prompts, responses, headers, or
// credentials. Optional persistence is delegated to the caller through
// `onRecord`; the chat engine uses it to append a session entry, which keeps the
// write on the same atomic, locked path as the rest of the session.

export const USAGE_LEDGER_VERSION = 1;
export const DEFAULT_MAX_USAGE_RECORDS = 500;

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function boundedString(value, max = 200) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Normalise a provider usage object without inventing missing values.
 *
 * Accepts OpenAI's `prompt_tokens` / `completion_tokens` / `total_tokens` and
 * the input/output aliases used by some providers. `total` is only recorded
 * when the provider sent it; it is not computed from the other two.
 */
export function normaliseUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { tokens: null, source: "unknown" };
  }
  const prompt = finiteNonNegative(usage.prompt_tokens ?? usage.input_tokens);
  const completion = finiteNonNegative(usage.completion_tokens ?? usage.output_tokens);
  const total = finiteNonNegative(usage.total_tokens);
  if (prompt === null && completion === null && total === null) {
    return { tokens: null, source: "unknown" };
  }
  return {
    tokens: { prompt, completion, total },
    source: "provider",
  };
}

export class UsageLedger {
  /**
   * @param {{ now?: () => number, maxRecords?: number, onRecord?: ((record: object) => void)|null, idPrefix?: string }} [options]
   */
  constructor({ now = () => Date.now(), maxRecords = DEFAULT_MAX_USAGE_RECORDS, onRecord = null, idPrefix = "use" } = {}) {
    this.now = now;
    this.maxRecords = Math.max(1, Math.floor(Number(maxRecords) || DEFAULT_MAX_USAGE_RECORDS));
    this.onRecord = typeof onRecord === "function" ? onRecord : null;
    this.idPrefix = idPrefix;
    this._records = [];
    this._seq = 0;
    this.lastWriteError = null;
  }

  /**
   * Append one request record.
   *
   * @param {{ provider?: string|null, model?: string|null, outcome?: string|null, dispatched?: boolean, retryCount?: number, attempt?: number, usage?: object|null, costUsd?: number|null, pricingSource?: string|null, quotaSource?: string|null, elapsedMs?: number|null, errorCode?: string|null }} entry
   */
  record(entry = {}) {
    this._seq += 1;
    const now = this.now();
    const usage = normaliseUsage(entry.usage);
    const costUsd = finiteNonNegative(entry.costUsd);
    const pricingSource = boundedString(entry.pricingSource, 120);
    const record = {
      version: USAGE_LEDGER_VERSION,
      id: `${this.idPrefix}_${now.toString(36)}_${this._seq.toString(36)}`,
      at: new Date(now).toISOString(),
      provider: boundedString(entry.provider, 80),
      model: boundedString(entry.model, 200),
      outcome: boundedString(entry.outcome, 60) ?? "unknown",
      dispatched: entry.dispatched !== false,
      retryCount: Math.max(0, Math.floor(Number(entry.retryCount) || 0)),
      attempt: Math.max(1, Math.floor(Number(entry.attempt) || 1)),
      tokens: usage.tokens,
      usageSource: usage.source,
      // A cost without a named source is not evidence. Drop it rather than
      // letting a caller's guess become a persisted number.
      costUsd: costUsd !== null && pricingSource ? costUsd : null,
      pricingSource: costUsd !== null && pricingSource ? pricingSource : null,
      quotaSource: boundedString(entry.quotaSource, 120),
      elapsedMs: finiteNonNegative(entry.elapsedMs),
      errorCode: boundedString(entry.errorCode, 80),
    };

    this._records.push(record);
    if (this._records.length > this.maxRecords) {
      this._records.splice(0, this._records.length - this.maxRecords);
    }

    if (this.onRecord) {
      try {
        this.onRecord(record);
      } catch (err) {
        this.lastWriteError = err?.message || String(err);
      }
    }
    return record;
  }

  /** Bounded copy, oldest first. */
  records() {
    return this._records.slice();
  }

  /** Aggregate only what was actually observed. */
  summary() {
    const byProvider = {};
    const byModel = {};
    const byOutcome = {};
    let dispatched = 0;
    let notDispatched = 0;
    let retries = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let tokenRequests = 0;
    // Each token field is observed independently. A provider that sent only
    // prompt tokens must not produce a fabricated total of 0.
    let promptObserved = 0;
    let completionObserved = 0;
    let totalObserved = 0;
    let costUsd = 0;
    let costRequests = 0;
    let unknownCostRequests = 0;

    const bucket = (map, key) => {
      const k = key || "(unknown)";
      if (!map[k]) {
        map[k] = {
          requests: 0,
          ok: 0,
          failed: 0,
          dispatched: 0,
          retries: 0,
          totalTokens: null,
          costUsd: 0,
        };
      }
      return map[k];
    };

    for (const r of this._records) {
      if (r.dispatched) dispatched += 1;
      else notDispatched += 1;
      retries += r.retryCount;
      byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;

      if (r.tokens) {
        tokenRequests += 1;
        if (r.tokens.prompt !== null) {
          promptTokens += r.tokens.prompt;
          promptObserved += 1;
        }
        if (r.tokens.completion !== null) {
          completionTokens += r.tokens.completion;
          completionObserved += 1;
        }
        if (r.tokens.total !== null) {
          totalTokens += r.tokens.total;
          totalObserved += 1;
        }
      }
      if (r.costUsd !== null) {
        costUsd += r.costUsd;
        costRequests += 1;
      } else {
        unknownCostRequests += 1;
      }

      for (const [map, key] of [
        [byProvider, r.provider],
        [byModel, r.model],
      ]) {
        const b = bucket(map, key);
        b.requests += 1;
        if (r.outcome === "ok") b.ok += 1;
        else b.failed += 1;
        if (r.dispatched) b.dispatched += 1;
        b.retries += r.retryCount;
        if (r.tokens?.total !== null && r.tokens?.total !== undefined) {
          b.totalTokens = (b.totalTokens ?? 0) + r.tokens.total;
        }
        if (r.costUsd !== null) b.costUsd += r.costUsd;
      }
    }

    return {
      requests: this._records.length,
      dispatched,
      notDispatched,
      retries,
      outcomes: byOutcome,
      tokens: {
        prompt: promptObserved ? promptTokens : null,
        completion: completionObserved ? completionTokens : null,
        total: totalObserved ? totalTokens : null,
        observedRequests: tokenRequests,
        promptObservedRequests: promptObserved,
        completionObservedRequests: completionObserved,
        totalObservedRequests: totalObserved,
      },
      cost: {
        usd: costRequests ? Number(costUsd.toFixed(6)) : null,
        observedRequests: costRequests,
        unknownRequests: unknownCostRequests,
      },
      byProvider,
      byModel,
      firstAt: this._records[0]?.at ?? null,
      lastAt: this._records[this._records.length - 1]?.at ?? null,
    };
  }

  toJSON() {
    return { version: USAGE_LEDGER_VERSION, records: this.records() };
  }

  fromJSON(obj) {
    this._records = [];
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.records)) return this;
    this._records = obj.records
      .filter((r) => r && typeof r === "object")
      .slice(-this.maxRecords)
      .map((r) => ({ ...r }));
    return this;
  }

  clear() {
    this._records = [];
    return this;
  }
}

export default { USAGE_LEDGER_VERSION, DEFAULT_MAX_USAGE_RECORDS, normaliseUsage, UsageLedger };
