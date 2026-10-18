// Plugin provider registration.
//
// The extension point behind `context.registerProvider({ id, name, models,
// complete })`. A provider declared by a plugin becomes a routable provider
// whose model ids look like:
//
//     plugin__<pluginId>__<providerId>/<model>
//
// e.g. `plugin__local__ollama/llama3`. The namespacing is the security
// boundary: a plugin provider can never shadow a builtin provider id, and
// transcripts always show which plugin answered.
//
// Integration with the routing engine goes through the dispatch layer the
// chat engine already owns: `installPluginProviderDispatch` wraps the
// session's complete/stream functions and routes requests for a plugin
// provider to the plugin's `complete` implementation. Everything else --
// failover, health memory, failure classification -- runs exactly as it does
// for the 12 builtin providers, because the router calls through the same
// wrapper.

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;
const MODEL_NAME_RE = /^[a-z0-9][\w.-]{0,63}$/i;
// A plugin that answers the chat must do so inside the model-call patience a
// user would tolerate anywhere else.
export const DEFAULT_COMPLETE_TIMEOUT_MS = 120_000;
// Cap the number of providers any single plugin may register.
export const MAX_PROVIDERS_PER_PLUGIN = 8;

/** The provider-part of a routed model id, e.g. for routing prefix checks. */
export function pluginProviderId(pluginId, providerId) {
  return `plugin__${pluginId}__${providerId}`;
}

/** True when a provider part of a model id belongs to a plugin provider. */
export function isPluginProvider(provider) {
  return String(provider ?? "").startsWith("plugin__");
}

export function validateProviderDef(def) {
  const errors = [];
  if (!def || typeof def !== "object") return ["registerProvider: definition must be an object"];
  if (typeof def.id !== "string" || !PROVIDER_ID_RE.test(def.id)) {
    errors.push(`registerProvider: id must match ${PROVIDER_ID_RE.source}`);
  }
  if (typeof def.name !== "string" || def.name.trim() === "") {
    errors.push("registerProvider: name is required");
  }
  if (!Array.isArray(def.models) || def.models.length === 0) {
    errors.push("registerProvider: models must be a non-empty array of model names");
  } else {
    for (const m of def.models) {
      if (typeof m !== "string" || !MODEL_NAME_RE.test(m)) {
        errors.push(`registerProvider: model name ${JSON.stringify(m)} is not a valid model id`);
      }
    }
  }
  if (typeof def.complete !== "function") {
    errors.push("registerProvider: complete must be a function");
  }
  return errors;
}

export class PluginProviderRegistry {
  constructor({ timeoutMs = DEFAULT_COMPLETE_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, {pluginId: string, def: object, providerId: string}>} */
    this.byProviderId = new Map();
    this.byPlugin = new Map();
  }

  /**
   * Register a provider.
   *
   * @param {string} pluginId
   * @param {{ id: string, name: string, models: string[], complete: Function }} def
   * @returns {{ ok: boolean, providerId?: string, error?: string, errors?: string[] }}
   */
  register(pluginId, def) {
    const errors = validateProviderDef(def);
    if (errors.length > 0) {
      return { ok: false, error: errors[0], errors };
    }
    const owned = this.byPlugin.get(pluginId) ?? [];
    if (owned.length >= MAX_PROVIDERS_PER_PLUGIN) {
      return {
        ok: false,
        error: `registerProvider: plugin "${pluginId}" hit the ${MAX_PROVIDERS_PER_PLUGIN}-provider cap`,
      };
    }
    const providerId = pluginProviderId(pluginId, def.id);
    if (this.byProviderId.has(providerId)) {
      return { ok: false, error: `registerProvider: "${providerId}" is already registered` };
    }
    const entry = {
      pluginId,
      providerId,
      def: {
        id: providerId,
        name: def.name,
        models: [...new Set(def.models)],
        complete: def.complete,
      },
    };
    this.byProviderId.set(providerId, entry);
    this.byPlugin.set(pluginId, [...owned, providerId]);
    return { ok: true, providerId };
  }

  /** Provider entry by namespaced provider id, or undefined. */
  get(providerId) {
    return this.byProviderId.get(providerId);
  }

  has(providerId) {
    return this.byProviderId.has(providerId);
  }

  /** All full model ids this plugin provider advertises. */
  modelIds() {
    const out = [];
    for (const entry of this.byProviderId.values()) {
      for (const model of entry.def.models) out.push(`${entry.providerId}/${model}`);
    }
    return out.sort();
  }

  byPluginProviders(pluginId) {
    return (this.byPlugin.get(pluginId) ?? []).map((id) => this.byProviderId.get(id));
  }

  removePlugin(pluginId) {
    const ids = this.byPlugin.get(pluginId) ?? [];
    for (const id of ids) this.byProviderId.delete(id);
    this.byPlugin.delete(pluginId);
    return ids.length;
  }

  get size() {
    return this.byProviderId.size;
  }
}

/** Race a plugin completion against the timeout; late results are lost. */
function raceTimeout(promise, ms, providerId) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`plugin provider ${providerId} timed out after ${ms}ms`);
      // Node errors carry `code`; the base Error type does not declare it.
      /** @type {any} */ (err).code = "plugin_provider_timeout";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Normalise a plugin completion to the gateway completion shape. */
function normaliseCompletion(providerId, modelId, res) {
  const text = res && typeof res === "object" && typeof res.text === "string" ? res.text.trim() : "";
  return {
    model: modelId,
    text,
    raw: res ?? null,
    finishReason:
      res && typeof res === "object" && res.finishReason != null ? res.finishReason : "stop",
    usage: res && typeof res === "object" && res.usage ? res.usage : null,
    provider: providerId,
  };
}

/**
 * Install a dispatch wrapper in front of the base complete/stream functions.
 * Requested providers that belong to a registered plugin provider are routed
 * into the plugin's `complete`, normalised to the gateway shapes; everything
 * else passes through untouched, so builtin failover behavior is unchanged.
 *
 * @param {{ base: object, registry: PluginProviderRegistry, log?: object }} opts
 * @returns {{ complete: Function, streamComplete: Function }}
 */
export function installPluginProviderDispatch({ base, registry, log = null }) {
  const dispatchComplete = async (cfg, modelId, prompt, opts = {}) => {
    const { provider } = parseModelPrefix(modelId);
    const entry = isPluginProvider(provider) ? registry.get(provider) : null;
    if (!entry) return base.complete(cfg, modelId, prompt, opts);
    log?.info?.(`plugin provider ${provider} -> complete`);
    try {
      const res = await raceTimeout(
        Promise.resolve(
          entry.def.complete(
            modelId,
            {
              system: opts.system ?? null,
              messages: [{ role: "user", content: String(prompt) }],
            },
            opts
          )
        ),
        registry.timeoutMs,
        provider
      );
      return normaliseCompletion(provider, modelId, res);
    } catch (error) {
      // Throw an error message-router-friendly Error: classifyFailure reads
      // the message, so "rate limited" from a plugin provider cascades like
      // any other rate limit.
      const wrapped = new Error(`plugin provider ${provider}: ${error?.message ?? String(error)}`);
      // Node errors carry `code`; the base Error type does not declare it.
      /** @type {any} */ (wrapped).code = error?.code ?? "plugin_provider_error";
      throw wrapped;
    }
  };

  // Plugin providers are not required to implement token streaming, so the
  // stream path calls `complete`, emits the whole answer in one chunk, and
  // returns the same completion object the gateway returns. The object shape
  // is the point: callers read `.text` off it, so a bare string here silently
  // produced empty replies.
  const dispatchStream = async (cfg, modelId, messages, opts = {}) => {
    const { provider } = parseModelPrefix(modelId);
    const entry = isPluginProvider(provider) ? registry.get(provider) : null;
    if (!entry) return base.streamComplete(cfg, modelId, messages, opts);
    const prompt = messages.map((m) => `${m.role ?? "user"}: ${m.content}`).join("\n\n");
    try {
      const res = await raceTimeout(
        Promise.resolve(
          entry.def.complete(modelId, normaliseWire(messages), { ...opts, prompt })
        ),
        registry.timeoutMs,
        provider
      );
      const completion = normaliseCompletion(provider, modelId, res);
      if (typeof opts?.onToken === "function" && completion.text) opts.onToken(completion.text);
      // Return the completion object, not its text. The caller's contract is
      // the gateway shape -- `chat.send` reads `.text` off this result -- and
      // returning a bare string made every plugin-provider reply come back
      // empty even though the tokens had been emitted correctly.
      return { ...completion, streamed: true };
    } catch (error) {
      const wrapped = new Error(`plugin provider ${provider}: ${error?.message ?? String(error)}`);
      // Node errors carry `code`; the base Error type does not declare it.
      /** @type {any} */ (wrapped).code = error?.code ?? "plugin_provider_error";
      throw wrapped;
    }
  };

  return { complete: dispatchComplete, streamComplete: dispatchStream };
}

/** Messages array -> the `{system, messages}` wire shape plugin providers see. */
function normaliseWire(messages) {
  let system = null;
  const rest = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system" && system === null) {
      system = m.content;
      continue;
    }
    rest.push({ role: m.role ?? "user", content: m.content });
  }
  return { system, messages: rest };
}

/** "plugin__a__b/model-name" -> { provider: "plugin__a__b", model: "model-name" }. */
function parseModelPrefix(modelId) {
  const raw = String(modelId ?? "");
  const slash = raw.indexOf("/");
  if (slash === -1) return { provider: raw, model: raw };
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}
