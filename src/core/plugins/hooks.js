// Plugin lifecycle hook registry.
//
// Plugins subscribe to named lifecycle events through `ctx.on(name, fn)` and
// the runtime invokes them with a payload. The registry is the boundary that
// makes hooks safe to run inside the agent loop:
//
//   - A throwing or rejecting subscriber becomes a captured error; the chain
//     keeps running past it. A buggy plugin can slow the run, never break it.
//   - Each subscriber runs under a timeout; a hanging one is abandoned (its
//     eventual rejection, if any, is swallowed) and the next one proceeds.
//   - Subscribers run in registration order, serially, so multiple plugins
//     mutating the same payload never race each other.
//
// The registry returns facts ({ok, values, error, timedOut}) and lets the
// caller decide what "deny" or "enrich" mean per hook.

export const HOOK_NAMES = [
  "onInit",
  "beforeAgentRun",
  "afterAgentRun",
  "beforeToolExecute",
  "afterToolExecute",
  "onShutdown",
];

export const DEFAULT_HOOK_TIMEOUT_MS = 3000;

export class UnknownHookError extends Error {}

/**
 * Run one subscriber under a timeout. A timed-out subscriber's late rejection
 * or value is discarded; the returned promise still resolves with the
 * timeout verdict so the chain can continue immediately.
 */
function raceWithTimeout(value, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([value, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @callback HookSubscriber
 * @param {object} payload hook-specific payload; beforeAgentRun may return an
 *   object whose `extra` key merges into context; beforeToolExecute may return
 *   `{ deny: true, reason }`; other hooks observe only.
 */

export class PluginHookRegistry {
  constructor({ timeoutMs = DEFAULT_HOOK_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, Array<{pluginId: string, fn: Function}>>} */
    this.subscribers = new Map();
  }

  /**
   * Subscribe. Unknown hook names are refused loudly: plugin authors should
   * hit a clear error at load time, not a silent list in `inspect`.
   *
   * @param {string} pluginId
   * @param {string} hookName one of HOOK_NAMES
   * @param {Function} fn subscriber
   * @returns {{ ok: boolean, error?: string }}
   */
  add(pluginId, hookName, fn) {
    if (!HOOK_NAMES.includes(hookName)) {
      return { ok: false, error: `unknown hook "${hookName}" (supported: ${HOOK_NAMES.join(", ")})` };
    }
    if (typeof fn !== "function") {
      return { ok: false, error: `hook "${hookName}" requires a function subscriber` };
    }
    if (!this.subscribers.has(hookName)) this.subscribers.set(hookName, []);
    this.subscribers.get(hookName).push({ pluginId, fn });
    return { ok: true };
  }

  /** Drop every subscription a plugin holds (used on unload/shutdown). */
  removePlugin(pluginId) {
    let removed = 0;
    for (const [hookName, subs] of this.subscribers) {
      const kept = subs.filter((s) => s.pluginId !== pluginId);
      removed += subs.length - kept.length;
      if (kept.length === 0) this.subscribers.delete(hookName);
      else this.subscribers.set(hookName, kept);
    }
    return removed;
  }

  /** Subscription count for one hook, or across all hooks when no name given. */
  count(hookName = null) {
    if (hookName) return (this.subscribers.get(hookName) ?? []).length;
    let total = 0;
    for (const subs of this.subscribers.values()) total += subs.length;
    return total;
  }

  /** Plugin ids currently subscribed to a hook. */
  pluginIdsFor(hookName) {
    return [...this.subscribers.get(hookName) ?? []].map((s) => s.pluginId);
  }

  /** Hook names one plugin is subscribed to (sorted, for inspect). */
  hookNamesFor(pluginId) {
    const names = [];
    for (const [hookName, subs] of this.subscribers) {
      if (subs.some((s) => s.pluginId === pluginId)) names.push(hookName);
    }
    return names.sort();
  }

  /**
   * Invoke every subscriber for a hook, serially, with a payload.
   *
   * @param {string} hookName
   * @param {object} payload hook-specific input
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {{ ok: boolean, values: Array<{pluginId: string, value: object}>,
   *            errors: Array<{pluginId: string, message: string}>,
   *            timedOut: string[] }}
   *   Never throws. Subscriber values that are `undefined` are recorded as
   *   null so the values array is JSON-stable.
   */
  async invoke(hookName, payload, { timeoutMs = this.timeoutMs } = {}) {
    if (!HOOK_NAMES.includes(hookName)) throw new UnknownHookError(hookName);
    const subs = this.subscribers.get(hookName) ?? [];
    const values = [];
    const errors = [];
    const timedOut = [];
    for (const { pluginId, fn } of subs) {
      // Settle every failure mode into a value first: a subscriber that
      // throws, rejects, or hangs may never break the chain.
      const outcome = await raceWithTimeout(
        Promise.resolve()
          .then(() => fn(payload))
          .then((value) => ({ value }))
          .catch((error) => ({ error })),
        timeoutMs
      );
      if (outcome && outcome.timedOut) {
        timedOut.push(pluginId);
        continue;
      }
      if (outcome && outcome.error !== undefined) {
        errors.push({
          pluginId,
          message: outcome.error?.message ?? String(outcome.error),
        });
        continue;
      }
      const value = outcome?.value;
      // A subscriber that returns nothing contributed nothing; observers who
      // merely ran side effects stay out of the values list.
      if (value !== undefined) {
        values.push({ pluginId, value });
      }
    }
    return { ok: errors.length === 0, values, errors, timedOut };
  }
}
