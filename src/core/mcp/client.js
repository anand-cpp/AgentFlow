// MCP Client protocol lifecycle and handshake.
//
// Implements JSON-RPC 2.0 session management for MCP servers per the
// 2024-11-05 specification. Handles initialize/initialized handshake,
// request/response with ids and timeouts, and graceful shutdown.
import { StdioTransport } from "./transports/stdio.js";
import { SseTransport } from "./transports/sse.js";

export class McpRequestError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "McpRequestError";
    if (code !== undefined) this.code = code;
  }
}

export class McpClient {
  constructor(options = {}) {
    this.transport = options.transport || null;
    this.transportType = options.transportType || "stdio";
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.url = options.url;
    this.headers = options.headers || {};
    this.requestTimeoutMs = options.requestTimeoutMs || 10000;
    this.protocolVersion = options.protocolVersion || "2024-11-05";
    this.log = options.log || null;
    this._nextId = 1;
    this._pending = new Map();
    this._connected = false;
    this._wired = false;
    this._initialized = false;
    this._capabilities = null;
    this._serverInfo = null;
    this._listeners = new Map();
  }

  _emit(type, detail) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(detail); } catch { /* ignore */ }
    }
  }

  on(type, fn) {
    let set = this._listeners.get(type);
    if (!set) { set = new Set(); this._listeners.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  _createTransport() {
    if (this.transport) return this.transport;
    if (this.transportType === "sse" || this.url) {
      return new SseTransport({ url: this.url, headers: this.headers, requestTimeoutMs: this.requestTimeoutMs });
    }
    return new StdioTransport({ command: this.command, args: this.args, cwd: this.cwd, env: this.env });
  }

  /**
   * Attach listeners and start the transport exactly once.
   *
   * Requests must never go out before the client is listening: a reply that
   * arrives before the message wiring is attached would be silently lost. So
   * both connect() and request() funnel through here.
   */
  _wire() {
    if (this._wired) return;
    this.transport ??= this._createTransport();
    this.transport.on("message", (msg) => this._handleMessage(msg));
    this.transport.on("error", (err) => {
      // A spawn failure means no server will ever answer: settle every pending
      // request immediately instead of letting each one ride out its timeout.
      if (err?.type === "spawn") this.#failAll(new McpRequestError(err.err?.message ?? "the server process could not be spawned"));
      this._emit("error", err);
    });
    this.transport.on("exit", (detail) => this._emit("exit", detail));
    this.transport.on("open", (detail) => this._emit("open", detail));
    this.transport.connect();
    this._wired = true;
    this._connected = true;
  }

  #failAll(cause) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(cause);
    }
    this._pending.clear();
  }

  connect() {
    this._wire();
  }

  /** True while the transport exists and has been connected. */
  get connected() {
    return this._connected;
  }

  /** True once the initialize handshake has completed. */
  get initialized() {
    return this._initialized;
  }

  /** Server capabilities from the initialize response. */
  get capabilities() {
    return this._capabilities;
  }

  /** Server info from the initialize response. */
  get serverInfo() {
    return this._serverInfo;
  }

  async initialize() {
    if (this._initialized) return { capabilities: this._capabilities, serverInfo: this._serverInfo };
    this._wire();
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      clientInfo: { name: "AgentFlow", version: "0.3.0" },
      capabilities: {
        roots: { listChanged: false },
        sampling: {},
      },
    }, { timeoutMs: this.requestTimeoutMs });
    this._capabilities = result?.capabilities || {};
    this._serverInfo = result?.serverInfo || null;
    this.notify("notifications/initialized", {});
    this._initialized = true;
    return { capabilities: this._capabilities, serverInfo: this._serverInfo };
  }

  async ping() {
    return this.request("ping", {});
  }

  request(method, params = null, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this._wired) {
      // A request without a handshake is legal for a caller that only pings or
      // lists; wire (and for stdio, spawn) here so replies cannot be lost.
      this._wire();
    }
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new McpRequestError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this._pending.set(id, { resolve, reject, method, timer });
      try {
        this.transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (!this.transport) throw new Error("transport not connected");
    const msg = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.transport.send(msg);
  }

  _handleMessage(message) {
    if (!message || typeof message !== "object") return;
    const { id, method, result, error } = message;
    if (id != null && method == null) {
      const entry = this._pending.get(id);
      if (!entry) return;
      this._pending.delete(id);
      clearTimeout(entry.timer);
      if (error) {
        const err = new McpRequestError(error.message || `${entry.method} failed`, error.code);
        entry.reject(err);
      } else {
        entry.resolve(result);
      }
      return;
    }
    if (id != null && method != null) {
      try {
        this.transport.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
      } catch { /* ignore */ }
      return;
    }
    this._emit("notification", message);
  }

  async close() {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("client closed"));
    }
    this._pending.clear();
    try { this.transport?.close?.(); } catch { /* ignore */ }
    this._connected = false;
    this._initialized = false;
  }
}

export default { McpClient, McpRequestError };
