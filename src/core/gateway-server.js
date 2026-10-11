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
//   Transparent.        Chat traffic is piped through byte-for-byte. This step
//                       does not rewrite OpenAI bodies into Ollama bodies or
//                       back -- it forwards and preserves status, content-type,
//                       and stream framing, so "corruption" is impossible by
//                       construction. Translation is a later step, and doing it
//                       here would be guessing at a contract nobody has asked
//                       for yet.

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
    fetchImpl = globalThis.fetch,
    logger = null,
  } = {}) {
    this.port = Number(port);
    this.host = host;
    this.ollamaUrl = ollamaUrl ? String(ollamaUrl).replace(/\/+$/, "") : null;
    this.staticModels = Array.isArray(models) ? models : [];
    this.timeoutMs = timeoutMs;
    this.bodyLimit = bodyLimit;
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
          Accept: payload.stream ? "text/event-stream" : "application/json",
        },
        // Forward the client's body verbatim. This step is a transport proxy;
        // rewriting it would be inventing a contract.
        body: raw || "{}",
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return; // client already gone; nothing to send
      return this._json(res, 502, {
        error: { message: `local provider unreachable: ${err?.message || err}`, code: "upstream_unreachable" },
      });
    }

    res.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    if (!upstream.body) {
      res.end();
      return;
    }

    try {
      // Stream the upstream body straight through. Works identically for an
      // NDJSON stream and for a single buffered JSON object -- both are just a
      // body, and framing is preserved because we never parse and re-encode it.
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
      // A broken pipe after headers are sent cannot become a clean JSON error;
      // the only correct move is to drop the connection.
      if (!res.writableEnded) res.destroy(err);
    }
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

export default { GatewayServer, GatewayPortConflictError, GATEWAY_VERSION, GATEWAY_DEFAULTS, defaultServerDir, normaliseOllamaModels };
