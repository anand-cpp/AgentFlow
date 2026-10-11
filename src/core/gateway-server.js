// Standalone in-repo gateway server.
//
// AgentFlow has always been a CLIENT: it talks to an external 9Router-derived
// gateway over an OpenAI-compatible API. That is a real deployment tax -- the
// CLI is useless until someone stands up a separate service on port 20127.
// This module is the first step of removing it: a zero-dependency HTTP server,
// built on node:http alone, that can answer the few endpoints AgentFlow actually
// calls and route completions to a local Ollama instance.
//
// Design commitments:
//
//   Zero dependencies.  No Express, no Fastify. The whole surface is three
//                       routes over node:http; a framework would be more code
//                       than the thing it wraps.
//   Honest health.      An unreachable Ollama is not a crash and not a 500. The
//                       gateway answers from its static fallback and says so,
//                       because "no models" and "no *reachable* models" are
//                       different facts and the client can only tell them apart
//                       if we preserve the difference.
//   Bounded.            Request bodies are capped, upstream calls are
//                       time-bounded, and shutdown closes the socket set rather
//                       than hoping keep-alive clients go away.
//   OpenAI on the wire. Callers speak OpenAI to /v1/chat/completions no matter
//                       which backend answers. The gateway translates the
//                       request into Ollama's native /api/chat and translates
//                       the reply back: NDJSON -> SSE when streaming, and
//                       { message } -> { choices[].message } when not. The
//                       client and any external consumer therefore see exactly
//                       one contract, regardless of backend.

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import os from "node:os";
import process from "node:process";

// Kept in lockstep with the CLI's VERSION and package.json. Duplicated rather
// than imported from ../cli/index.js because core/ must not depend on the CLI
// layer (that import would drag in the whole command surface just for a string).
export const GATEWAY_VERSION = "0.1.0";

export const GATEWAY_DEFAULTS = Object.freeze({
  port: 20127,
  host: "127.0.0.1",
  ollamaUrl: "http://127.0.0.1:11434",
});

// ---------------------------------------------------------------------------
// Remote provider registry
//
// The gateway is OpenAI-compatible on the wire, and so are the hosted providers
// it forwards to -- Groq, Cerebras, Mistral, Gemini (through its OpenAI-
// compatible endpoint), and OpenRouter all accept POST /chat/completions with a
// Bearer key. So a remote request needs no translation at all: resolve the
// provider, attach its key, and pipe. Only the local Ollama backend needs
// translation, because only Ollama does not speak OpenAI natively.
//
// Keys are read from the environment at request time and never copied onto the
// instance, so a config dump, a process listing, or an error body cannot show a
// provider credential the gateway never held.
// ---------------------------------------------------------------------------

export const PROVIDERS = Object.freeze({
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    envKeys: ["GROQ_API_KEY"],
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
  },
  cerebras: {
    baseUrl: "https://api.cerebras.ai/v1",
    envKeys: ["CEREBRAS_API_KEY"],
    models: ["llama3.1-8b", "llama3.1-70b", "qwen-3-32b"],
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    envKeys: ["MISTRAL_API_KEY"],
    models: ["mistral-small-latest", "mistral-large-latest", "open-mistral-nemo", "codestral-latest"],
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-1.5-pro"],
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    envKeys: ["OPENROUTER_API_KEY"],
    models: ["auto", "meta-llama/llama-3.3-70b-instruct:free", "mistralai/mistral-7b-instruct:free"],
  },
  ollama: {
    baseUrl: GATEWAY_DEFAULTS.ollamaUrl,
    envKeys: [],
    models: [],
    local: true,
  },
});

const GATEWAY_USER_AGENT = `AgentFlow-Gateway/${GATEWAY_VERSION}`;

// Heuristics for a model id that carries *no* provider prefix. Deliberately
// narrow: a wrong guess silently routes a request to the wrong place, so we only
// claim ids whose shape is distinctive, and only when that provider has a key.
// Anything unmatched stays local.
const MODEL_PATTERNS = [
  { provider: "gemini", re: /^gemini-/i },
  { provider: "mistral", re: /^(mistral-|codestral|open-mistral|open-mixtral|pixtral)/i },
  { provider: "cerebras", re: /^llama3\.\d/i },
  { provider: "groq", re: /^(llama-|mixtral|gemma|deepseek-)/i },
];

/**
 * Thrown when a request names a remote provider whose API key is absent.
 *
 * Carries the provider and the env var(s) that would fix it, so the message is
 * actionable -- "set GROQ_API_KEY" rather than "unauthorized" -- while still
 * never containing a key.
 */
export class ProviderAuthMissingError extends Error {
  constructor(provider, envKeys = []) {
    const need =
      envKeys.length <= 1
        ? envKeys[0] || "an API key"
        : `${envKeys[0]} (or ${envKeys.slice(1).join(", ")})`;
    super(`Provider ${provider} requires ${need} to be set in environment`);
    this.name = "ProviderAuthMissingError";
    this.code = "provider_auth_missing";
    this.provider = provider;
    this.envKeys = [...envKeys];
  }
}

/** First non-empty credential among a provider's accepted env vars. */
function resolveProviderKey(spec, env) {
  for (const envKey of spec?.envKeys || []) {
    const value = env?.[envKey];
    if (typeof value === "string" && value.trim()) return { key: value.trim(), envKey };
  }
  return { key: null, envKey: null };
}

/**
 * Shallow-merge provider overrides over the built-in registry.
 *
 * Merging per provider (not replacing the whole table) lets a test point one
 * provider at a mock port while keeping every other provider's key rules and
 * catalogue intact.
 */
export function mergeProviders(overrides = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(PROVIDERS)) out[name] = { ...spec };
  for (const [name, spec] of Object.entries(overrides || {})) {
    out[name] = { ...(out[name] || {}), ...spec };
  }
  return out;
}

/**
 * Decide which upstream answers a chat request.
 *
 * A `<provider>/<model>` prefix wins and is stripped from the upstream model id.
 * A known-prefix remote with no key is a hard error, because the user asked for
 * that provider explicitly. A bare model id is matched against provider-shaped
 * names heuristically; an unmatched id -- or a heuristic match with no
 * credential -- falls back to local Ollama. The returned `apiKey` stays in
 * process memory and must never be logged or reflected to a client.
 */
export function resolveTargetProvider(modelId, env = process.env, providers = PROVIDERS) {
  const id = typeof modelId === "string" ? modelId : "";

  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    const spec = providers[prefix];
    if (spec) {
      const model = id.slice(slash + 1);
      if (spec.local) {
        return { provider: prefix, model, baseUrl: spec.baseUrl, apiKey: null, local: true };
      }
      const { key } = resolveProviderKey(spec, env);
      if (!key) throw new ProviderAuthMissingError(prefix, spec.envKeys || []);
      return { provider: prefix, model, baseUrl: spec.baseUrl, apiKey: key, local: false };
    }
  }

  for (const { provider, re } of MODEL_PATTERNS) {
    if (!re.test(id)) continue;
    const spec = providers[provider];
    if (!spec || spec.local) continue;
    const { key } = resolveProviderKey(spec, env);
    if (!key) continue; // shaped like a remote model, but no credential to use
    return { provider, model: id, baseUrl: spec.baseUrl, apiKey: key, local: false };
  }

  return {
    provider: "ollama",
    model: id,
    baseUrl: providers.ollama?.baseUrl ?? GATEWAY_DEFAULTS.ollamaUrl,
    apiKey: null,
    local: true,
  };
}

// Where the gateway looks on the local Ollama. Ollama's native API is used for
// both: /api/tags lists installed models, /api/chat produces completions and
// streams NDJSON. Making them fields lets a test point a mock at its own paths.
const OLLAMA_TAGS_PATH = "/api/tags";
const OLLAMA_CHAT_PATH = "/api/chat";

const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024; // 10 MiB: plenty for a chat body.
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Typed error for a port already in use.
 *
 * EADDRINUSE is an ordinary, expected outcome -- the user ran `server start`
 * twice, or has another gateway up -- not an internal fault. Catching the raw
 * node error and re-typing it here means the CLI can print "port 20127 is taken"
 * with the port and host, instead of an unhandled 'error' event that crashes the
 * process with a stack trace.
 */
export class GatewayPortConflictError extends Error {
  constructor(host, port) {
    super(`port ${port} on ${host} is already in use`);
    this.name = "GatewayPortConflictError";
    this.code = "EADDRINUSE";
    this.host = host ?? null;
    this.port = port ?? null;
  }
}

/**
 * Refusal to bind a network-reachable address without authentication.
 *
 * 0.0.0.0 with no API key is an open proxy to the local model: anyone who can
 * route to the host can spend its compute and read its replies. This is not a
 * warning-worthy mistake, it is a foot-gun, so start() refuses outright. The
 * message names both fixes (set a key, or stay on loopback) because a refusal
 * that does not say how to proceed is just an obstacle.
 */
export class GatewayInsecureError extends Error {
  constructor(host = "0.0.0.0") {
    super("Refusing to bind 0.0.0.0 without an API key. Set AGENTFLOW_SERVER_API_KEY or bind to 127.0.0.1.");
    this.name = "GatewayInsecureError";
    this.code = "insecure_bind";
    this.host = host;
  }
}

/** Loopback aliases: binding any of these keeps the gateway off the network. */
function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1";
}

/**
 * Enforce the bind/host safety invariant before a socket is ever opened.
 *
 * Exported so the CLI can fail *before* forking a daemon, and so the rule lives
 * in exactly one place shared by the server and its launcher.
 */
export function assertSecureBind({ host = "127.0.0.1", apiKey = null } = {}) {
  if (host === "0.0.0.0" && !apiKey) throw new GatewayInsecureError(host);
}

/** Default directory for gateway runtime state (the PID/state file). */
export function defaultServerDir() {
  if (process.env.AGENTFLOW_STATE_DIR) return path.join(process.env.AGENTFLOW_STATE_DIR, "server");
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "agentflow", "server");
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agentflow", "server");
}

/** Normalise Ollama's /api/tags body into OpenAI's { object:"list", data } shape. */
export function normaliseOllamaModels(body) {
  const list = Array.isArray(body?.models)
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : [];
  return list
    .map((m) => {
      const id = m?.name || m?.model || m?.id || "";
      const parsed = m?.modified_at ? Math.floor(Date.parse(m.modified_at) / 1000) : NaN;
      const created = Number.isFinite(parsed) ? parsed : Number.isFinite(m?.created) ? m.created : 0;
      return { id, object: "model", created, owned_by: m?.owned_by || "ollama" };
    })
    .filter((m) => m.id);
}

// ---------------------------------------------------------------------------
// OpenAI <-> Ollama translation
//
// Ollama's native /api/chat is *not* the OpenAI contract. Its stream is NDJSON
// (one JSON object per line) where OpenAI's is Server-Sent Events; its final
// object carries usage counters named prompt_eval_count/eval_count where OpenAI
// uses usage.prompt_tokens/completion_tokens. A client built against the OpenAI
// contract -- including this repo's own src/core/gateway.js -- reads
// choices[0].message.content and finds nothing in an Ollama reply. Translating
// at the boundary is what makes the gateway backend-agnostic.
// ---------------------------------------------------------------------------

/** A stable completion id, generated once per request (OpenAI's `chatcmpl-` shape). */
export function newCompletionId() {
  return `chatcmpl-${randomBytes(12).toString("hex")}`;
}

/** Coerce an Ollama token count to a non-negative integer (missing -> 0). */
function tokenCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Ollama `done_reason` -> OpenAI `finish_reason`. Length is the only one we distinguish. */
function finishReasonFor(ollama, fallback = "stop") {
  if (ollama?.done === false) return null;
  return ollama?.done_reason === "length" ? "length" : fallback;
}

/**
 * Translate an OpenAI chat request into Ollama's native /api/chat body.
 *
 * The two contracts overlap on `model`, `messages`, and `stream`; they diverge
 * on generation knobs, which OpenAI puts at the top level (max_tokens,
 * temperature, top_p, stop) and Ollama nests under `options` with different
 * names (num_predict, temperature, top_p, stop). Translating them means a client
 * that caps `max_tokens` actually gets a bounded reply instead of an ignored
 * field.
 */
export function toOllamaChatRequest(payload = {}) {
  const body = {
    model: payload?.model,
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    stream: payload?.stream === true,
  };

  const options = {};
  if (payload?.temperature != null) options.temperature = payload.temperature;
  if (payload?.top_p != null) options.top_p = payload.top_p;
  const maxTokens = payload?.max_tokens ?? payload?.max_completion_tokens;
  if (maxTokens != null) options.num_predict = maxTokens;
  if (payload?.stop != null) options.stop = payload.stop;
  if (Object.keys(options).length) body.options = options;

  return body;
}

/**
 * Translate a non-streaming Ollama /api/chat reply into an OpenAI chat.completion.
 *
 * Usage is summed from Ollama's counters; when they are absent (some models /
 * older servers omit them) the counts are 0 rather than omitted, because a
 * downstream billing or budget check that reads `usage.prompt_tokens` should get
 * a number, not `undefined`.
 */
export function ollamaToOpenAIResponse(ollama = {}, { model, id, created } = {}) {
  const message = ollama?.message ?? {};
  const promptTokens = tokenCount(ollama?.prompt_eval_count);
  const completionTokens = tokenCount(ollama?.eval_count);
  return {
    id: id ?? newCompletionId(),
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? ollama?.model ?? "",
    choices: [
      {
        index: 0,
        message: {
          role: typeof message.role === "string" ? message.role : "assistant",
          content: typeof message.content === "string" ? message.content : "",
        },
        finish_reason: finishReasonFor(ollama, "stop") ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** Serialise one OpenAI chunk as an SSE event. */
function sseChunk({ id, created, model, delta, finishReason }) {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Translate Ollama's NDJSON chat stream into OpenAI SSE.
 *
 * `ollamaStream` is any async iterable of Buffers/strings (a node:Readable is
 * the usual caller). Yields complete SSE events, ending with `data: [DONE]`.
 *
 * The one subtle rule is `delta.role`: OpenAI's first delta carries the role and
 * every later one carries only content. We track that with `sentRole`, so the
 * role is emitted exactly once even when Ollama's first line has empty content.
 * A malformed line is skipped rather than fatal: dropping one bad line beats
 * killing a stream the client is already reading.
 */
export async function* translateOllamaStreamToOpenAI(ollamaStream, modelId, { id, created } = {}) {
  const completionId = id ?? newCompletionId();
  const createdTs = created ?? Math.floor(Date.now() / 1000);
  const model = modelId ?? "";

  const decoder = new TextDecoder();
  let buffer = "";
  let sentRole = false;
  let finishSent = false;

  const contentChunk = (obj) => {
    const content = typeof obj?.message?.content === "string" ? obj.message.content : "";
    const delta = {};
    if (!sentRole) {
      delta.role = typeof obj?.message?.role === "string" ? obj.message.role : "assistant";
      sentRole = true;
    }
    if (content) delta.content = content;
    if (!Object.keys(delta).length) return null;
    return sseChunk({ id: completionId, created: createdTs, model, delta, finishReason: null });
  };

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null; // skip a malformed line instead of aborting the stream
    }
    if (obj?.error) return null; // an error line carries no delta
    const events = [];
    const content = contentChunk(obj);
    if (content) events.push(content);
    if (obj?.done === true && !finishSent) {
      finishSent = true;
      const reason = obj?.done_reason === "length" ? "length" : "stop";
      events.push(sseChunk({ id: completionId, created: createdTs, model, delta: {}, finishReason: reason }));
    }
    return events;
  };

  for await (const chunk of ollamaStream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const events = processLine(line);
      if (events) for (const e of events) yield e;
    }
  }
  buffer += decoder.decode();
  const tail = processLine(buffer);
  if (tail) for (const e of tail) yield e;

  // A stream that ended without a done:true line still needs a terminator, or
  // the client waits forever for finish_reason.
  if (!finishSent) {
    yield sseChunk({ id: completionId, created: createdTs, model, delta: {}, finishReason: "stop" });
  }
  yield "data: [DONE]\n\n";
}

/** Read a request body as UTF-8, refusing anything past `limit`. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error(`request body exceeds ${limit} bytes`);
        err.code = "body_too_large";
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Constant-time comparison of two strings (equal length required by the primitive). */
function timingSafeEqualString(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export class GatewayServer {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.port=20127]     listen port; 0 lets the OS pick one.
   * @param {string}  [opts.host="127.0.0.1"] loopback by default -- an unauthenticated
   *                                        local gateway must not face the network.
   * @param {string}  [opts.ollamaUrl]      base URL of the local Ollama instance.
   * @param {Array}   [opts.models=[]]      static fallback models for /v1/models.
   * @param {number}  [opts.timeoutMs]      upstream request budget.
   * @param {number}  [opts.bodyLimit]      max request body bytes.
   * @param {string}  [opts.apiKey]         require `Authorization: Bearer <key>` on /v1/*.
   *                                        Null (default) means no auth -- correct for
   *                                        loopback-only use, refused on 0.0.0.0.
   * @param {Function}[opts.fetchImpl]      injectable fetch (tests / instrumentation).
   * @param {object}  [opts.logger=null]    optional { info, warn, error } sink.
   */
  constructor({
    port = GATEWAY_DEFAULTS.port,
    host = GATEWAY_DEFAULTS.host,
    ollamaUrl = GATEWAY_DEFAULTS.ollamaUrl,
    models = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    bodyLimit = DEFAULT_BODY_LIMIT,
    apiKey = null,
    fetchImpl = globalThis.fetch,
    logger = null,
  } = {}) {
    this.port = Number(port);
    this.host = host;
    this.ollamaUrl = ollamaUrl ? String(ollamaUrl).replace(/\/+$/, "") : null;
    this.staticModels = Array.isArray(models) ? models : [];
    this.timeoutMs = timeoutMs;
    this.bodyLimit = bodyLimit;
    this.apiKey = apiKey ? String(apiKey) : null;
    // Bound, not looked up per call: an injected fetch and the global fetch are
    // both "the fetch", and resolving that at construction keeps the request
    // path free of a global read that a test cannot replace.
    this.fetchImpl = fetchImpl;
    this.log = logger;

    this.server = null;
    this.startedAt = null;
    // Track sockets ourselves so close() can force keep-alive connections shut
    // instead of waiting on a client that has no reason to hang up.
    this._sockets = new Set();
  }

  /** True once the server is listening. */
  get listening() {
    return Boolean(this.server?.listening);
  }

  /** The bound address, with the real port (resolves port 0 to what the OS chose). */
  address() {
    const a = this.server?.address();
    if (!a || typeof a !== "object") return null;
    const host = a.address === "::" || a.address === "0.0.0.0" ? this.host : a.address;
    return { host, port: a.port };
  }

  url() {
    const a = this.address();
    return a ? `http://${a.host}:${a.port}` : null;
  }

  /**
   * Bind and start listening.
   *
   * Rejects with GatewayPortConflictError on EADDRINUSE; every other listen
   * error is re-thrown unchanged. Resolves once the socket is accepting, so a
   * caller that awaits start() may immediately issue a request.
   */
  async start() {
    if (this.server) throw new Error("gateway server already started");

    // Refuse the insecure combination before opening a socket.
    assertSecureBind({ host: this.host, apiKey: this.apiKey });
    // A key on a loopback-only bind is a no-op for security but often a sign the
    // operator *meant* to expose the server. Say so rather than staying silent.
    if (this.apiKey && isLoopbackHost(this.host)) {
      this.log?.warn?.(
        "API key configured but server bound to loopback ΓÇö consider setting serverHost to 0.0.0.0 for remote access."
      );
    }

    const server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => this._fail(res, err));
    });

    server.on("connection", (socket) => {
      this._sockets.add(socket);
      socket.on("close", () => this._sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        if (err?.code === "EADDRINUSE") {
          reject(new GatewayPortConflictError(this.host, this.port));
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener("error", onError);
        // Post-listen errors (a rare accept() failure) must not crash the
        // process. Log and carry on; the socket is still bound.
        server.on("error", (err) => this.log?.error?.(`gateway server error: ${err.message}`));
        const addr = server.address();
        // Port 0 means "OS, pick one" -- record the chosen port so address(),
        // url(), and the state file report reality, not the request.
        if (addr && typeof addr === "object") this.port = addr.port;
        this.server = server;
        this.startedAt = Date.now();
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, this.host);
    });

    this.log?.info?.(`gateway server listening on ${this.url()}`);
    return this;
  }

  /**
   * Stop listening and release the port.
   *
   * Idempotent: closing an unstarted server is a no-op. Known sockets are
   * destroyed so a keep-alive client (fetch keeps connections warm) cannot hold
   * the port open past close().
   */
  async close() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of this._sockets) socket.destroy();
      this._sockets.clear();
    });
    this.log?.info?.("gateway server stopped");
  }

  // -------------------------------------------------------------------------
  // routing
  // -------------------------------------------------------------------------

  async _handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    // Auth covers the model surface only. /api/version and /health stay open so
    // a load balancer or `aflow server status` can probe liveness without a key
    // -- a health check that needs a credential is a health check that fails
    // exactly when you need it.
    if (url.pathname.startsWith("/v1/") && !this._authorized(req)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="agentflow"');
      return this._json(res, 401, {
        error: { message: "Invalid API key", type: "auth_error", code: "invalid_api_key" },
      });
    }

    if (method === "GET" && url.pathname === "/api/version") {
      return this._json(res, 200, { version: GATEWAY_VERSION, status: "ok" });
    }
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return this._json(res, 200, { status: "ok", uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0 });
    }
    if (method === "GET" && url.pathname === "/v1/models") {
      return this._models(res);
    }
    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      return this._chat(req, res);
    }

    return this._json(res, 404, {
      error: { message: `not found: ${method} ${url.pathname}`, code: "not_found" },
    });
  }

  async _models(res) {
    let data = [];
    let source = "ollama";

    if (this.ollamaUrl) {
      try {
        const upstream = await this.fetchImpl(`${this.ollamaUrl}${OLLAMA_TAGS_PATH}`, {
          method: "GET",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (upstream.ok) {
          data = normaliseOllamaModels(await upstream.json());
        } else {
          source = `ollama_http_${upstream.status}`;
        }
      } catch (err) {
        // Unreachable Ollama is expected (it may not be installed) and must not
        // take the gateway down. Fall through to the static list.
        source = "ollama_unreachable";
        this.log?.warn?.(`models: ollama unreachable (${err?.message || err})`);
      }
    } else {
      source = "unconfigured";
    }

    if (!data.length && this.staticModels.length) {
      data = this.staticModels.map((m) =>
        typeof m === "string"
          ? { id: m, object: "model", created: 0, owned_by: "static" }
          : { object: "model", created: 0, owned_by: "static", ...m }
      );
      source = `${source}_fallback`;
    }

    return this._json(res, 200, { object: "list", data, source });
  }

  async _chat(req, res) {
    let raw;
    try {
      raw = await readBody(req, this.bodyLimit);
    } catch (err) {
      const status = err?.code === "body_too_large" ? 413 : 400;
      return this._json(res, status, { error: { message: err.message, code: err.code || "bad_request" } });
    }

    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      return this._json(res, 400, { error: { message: "invalid JSON body", code: "invalid_json" } });
    }
    if (!payload || typeof payload !== "object") {
      return this._json(res, 400, { error: { message: "body must be a JSON object", code: "invalid_body" } });
    }

    if (!this.ollamaUrl) {
      return this._json(res, 501, {
        error: { message: "no local provider configured (set ollamaUrl)", code: "no_provider" },
      });
    }

    const stream = payload.stream === true;
    const model = typeof payload.model === "string" ? payload.model : "";
    // One id per request, shared by every chunk, so a client can group a stream.
    const id = newCompletionId();
    const created = Math.floor(Date.now() / 1000);

    // Abort the upstream call if the client hangs up mid-stream, so a cancelled
    // request does not leave a provider connection running to nowhere.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    let upstream;
    try {
      upstream = await this.fetchImpl(`${this.ollamaUrl}${OLLAMA_CHAT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: stream ? "text/event-stream" : "application/json",
        },
        // Send Ollama its own contract, not the OpenAI one the client used.
        body: JSON.stringify(toOllamaChatRequest(payload)),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return; // client already gone; nothing to send
      return this._json(res, 502, {
        error: { message: `local provider unreachable: ${err?.message || err}`, code: "upstream_unreachable" },
      });
    }

    // A non-2xx upstream is a real answer (model missing, bad request). Translate
    // Ollama's `{ error }` into the OpenAI error envelope and preserve the status
    // rather than pretending it succeeded.
    if (!upstream.ok) {
      let detail = null;
      try {
        detail = await upstream.json();
      } catch {
        /* non-JSON error body */
      }
      const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      return this._json(res, status, {
        error: {
          message: detail?.error || `local provider returned ${upstream.status}`,
          type: "upstream_error",
          code: "upstream_error",
        },
      });
    }

    return stream
      ? this._chatStream(res, upstream, { model, id, created })
      : this._chatOnce(res, upstream, { model, id, created });
  }

  /** Non-streaming path: buffer Ollama's reply and re-shape it as chat.completion. */
  async _chatOnce(res, upstream, ctx) {
    let ollama;
    try {
      ollama = await upstream.json();
    } catch {
      return this._json(res, 502, {
        error: { message: "local provider returned an unreadable body", type: "upstream_error", code: "upstream_bad_body" },
      });
    }
    return this._json(res, 200, ollamaToOpenAIResponse(ollama, ctx));
  }

  /** Streaming path: NDJSON from Ollama in, OpenAI SSE to the client out. */
  async _chatStream(res, upstream, ctx) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Defeat proxy buffering so tokens arrive as they are produced.
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    if (!upstream.body) {
      res.end("data: [DONE]\n\n");
      return;
    }

    const source = Readable.fromWeb(upstream.body);
    const sse = Readable.from(translateOllamaStreamToOpenAI(source, ctx.model, { id: ctx.id, created: ctx.created }));
    try {
      // pipeline handles backpressure and propagates a mid-stream error.
      await pipeline(sse, res);
    } catch (err) {
      // Headers are already sent; a clean JSON error is no longer possible.
      if (!res.writableEnded) res.destroy(err);
    }
  }

  /** Validate the bearer token when an API key is configured. */
  _authorized(req) {
    if (!this.apiKey) return true;
    const header = req.headers["authorization"];
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return timingSafeEqualString(match[1].trim(), this.apiKey);
  }

  _json(res, status, body) {
    if (res.writableEnded) return;
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(text));
    res.end(text);
  }

  _fail(res, err) {
    this.log?.error?.(`gateway request failed: ${err?.message || err}`);
    if (res.writableEnded || res.headersSent) {
      res.destroy(err);
      return;
    }
    this._json(res, 500, { error: { message: "internal gateway error", code: "internal_error" } });
  }
}

export default {
  GatewayServer,
  GatewayPortConflictError,
  GatewayInsecureError,
  ProviderAuthMissingError,
  assertSecureBind,
  GATEWAY_VERSION,
  GATEWAY_DEFAULTS,
  PROVIDERS,
  mergeProviders,
  resolveTargetProvider,
  defaultServerDir,
  normaliseOllamaModels,
  newCompletionId,
  toOllamaChatRequest,
  ollamaToOpenAIResponse,
  translateOllamaStreamToOpenAI,
};
