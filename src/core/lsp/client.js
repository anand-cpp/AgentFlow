// LSP client: a request/response session over one language-server process.
//
// This is the layer that turns "a server on a pipe" into "ask a question, get
// an answer". It owns JSON-RPC ids, the pending-request table with per-request
// timeouts, the document open/version lifecycle, and the file<->URI mapping.
// The diagnostics manager and the capability helpers build on it; nothing
// above this file touches a raw frame.

import path from "node:path";
import { LspProcess } from "./process.js";

export class LspRequestError extends Error {
  /** @param {string} message @param {{ code?: string, method?: string, detail?: unknown }} [opts] */
  constructor(message, { code = "lsp_request_error", method, detail } = {}) {
    super(message);
    this.name = "LspRequestError";
    this.code = code;
    this.method = method ?? null;
    this.detail = detail ?? null;
  }
}

const LANGUAGE_IDS = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".py": "python",
  ".pyi": "python",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".json": "json",
  ".jsonc": "jsonc",
};

/** LSP languageId for a path, defaulting to plaintext. */
export function languageIdFor(filePath) {
  return LANGUAGE_IDS[path.extname(String(filePath ?? "")).toLowerCase()] ?? "plaintext";
}

/**
 * Path to `file://` URI, correctly on both platforms.
 *
 * Windows drive letters need the extra slash (`file:///C:/...`) and backslashes
 * must become forward slashes; a naive `file://` + path yields a URI the server
 * rejects or, worse, interprets as a relative path.
 * @param {string} filePath
 */
export function pathToUri(filePath) {
  const abs = path.resolve(String(filePath)).replace(/\\/g, "/");
  const uriPath = abs.startsWith("/") ? abs : `/${abs}`;
  return `file://${encodeURI(uriPath)}`;
}

/**
 * `file://` URI back to a native filesystem path.
 * @param {string} uri
 */
export function uriToPath(uri) {
  const s = String(uri ?? "");
  if (!s.startsWith("file://")) {
    throw new LspRequestError(`not a file URI: ${s}`, { code: "lsp_bad_uri" });
  }
  let p = decodeURI(s.slice("file://".length));
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // /C:/... -> C:/...
  return process.platform === "win32" ? p.replace(/\//g, "\\") : p;
}

export class LspClient {
  #proc;
  #spawn;
  #server;
  #cwd;
  #rootPath;
  #requestTimeoutMs;
  #log;
  #nextId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, method: string, timer: NodeJS.Timeout }>} */
  #pending = new Map();
  /** @type {Map<string, { version: number }>} */
  #docs = new Map();
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();
  #initialized = false;
  #capabilities = null;
  #serverInfo = null;
  #stopped = false;

  /**
   * @param {{
   *   server: { command: string, args?: string[] },
   *   rootPath: string,
   *   cwd?: string,
   *   process?: LspProcess,
   *   spawn?: Function,
   *   requestTimeoutMs?: number,
   *   log?: object
   * }} options
   */
  constructor({ server, cwd, rootPath, process: proc = null, spawn, requestTimeoutMs = 10000, log = null }) {
    if (!server?.command) throw new LspRequestError("a server with a command is required", { code: "lsp_no_command" });
    this.#server = server;
    this.#cwd = cwd;
    this.#rootPath = path.resolve(String(rootPath ?? process.cwd()));
    this.#proc = proc;
    this.#spawn = spawn;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#log = log;
  }

  get capabilities() {
    return this.#capabilities;
  }

  get serverInfo() {
    return this.#serverInfo;
  }

  get initialized() {
    return this.#initialized;
  }

  get rootPath() {
    return this.#rootPath;
  }

  /** The underlying process (exposed for shutdown and tests). */
  get process() {
    return this.#proc;
  }

  /**
   * Subscribe to `diagnostics`, `notification`, `error` or `exit`.
   * @param {string} type
   * @param {(detail: any) => void} fn
   */
  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  #emit(type, detail) {
    const set = this.#listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(detail);
      } catch (err) {
        this.#log?.error?.(`lsp: ${type} listener threw: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * Spawn the server and complete the LSP handshake.
   * @param {{ timeoutMs?: number }} [opts]
   */
  async start({ timeoutMs = this.#requestTimeoutMs } = {}) {
    if (!this.#proc) {
      this.#proc = new LspProcess({
        command: this.#server.command,
        args: this.#server.args ?? [],
        cwd: this.#cwd,
        spawn: this.#spawn,
        log: this.#log,
      });
    }
    this.#proc.on("message", (message) => this.#handleMessage(message));
    this.#proc.on("error", (err) => this.#emit("error", err));
    this.#proc.on("exit", (detail) => this.#emit("exit", detail));
    this.#proc.start();

    const result = await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: this.#rootPath ? pathToUri(this.#rootPath) : null,
        rootPath: this.#rootPath,
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            synchronization: { didSave: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
          workspace: {},
        },
        clientInfo: { name: "agentflow", version: "1.0.0" },
      },
      { timeoutMs },
    );
    this.#capabilities = result?.capabilities ?? {};
    this.#serverInfo = result?.serverInfo ?? null;
    this.notify("initialized", {});
    this.#initialized = true;
    return result;
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object") return;
    const { id, method, result, error } = message;

    if (id != null && method == null) {
      const entry = this.#pending.get(id);
      if (!entry) return;
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      if (error) {
        entry.reject(
          new LspRequestError(error.message || `${entry.method} failed`, {
            code: error.code != null ? `lsp_${error.code}` : "lsp_server_error",
            method: entry.method,
            detail: error.data ?? null,
          }),
        );
      } else {
        entry.resolve(result);
      }
      return;
    }

    // Server-initiated request: answer with a method-not-found so the server is
    // never left waiting on us.
    if (id != null && method != null) {
      try {
        this.#proc?.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
      } catch {
        /* server already gone */
      }
      return;
    }

    if (method === "textDocument/publishDiagnostics") {
      this.#emit("diagnostics", { uri: message.params?.uri ?? null, diagnostics: message.params?.diagnostics ?? [] });
      return;
    }
    this.#emit("notification", message);
  }

  /**
   * Send a JSON-RPC request and await its result.
   * @param {string} method
   * @param {any} [params]
   * @param {{ timeoutMs?: number }} [opts]
   */
  request(method, params = null, { timeoutMs = this.#requestTimeoutMs } = {}) {
    if (this.#stopped) {
      return Promise.reject(new LspRequestError("client has been stopped", { code: "lsp_stopped", method }));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let state = 'pending';
      const timer = setTimeout(() => {
        if (state === 'pending') {
          state = 'rejected';
          this.#pending.delete(id);
          reject(new LspRequestError(`${method} timed out after ${timeoutMs}ms`, { code: "lsp_timeout", method }));
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#pending.set(id, {
        resolve: (value) => {
          if (state === 'pending') {
            state = 'resolved';
            clearTimeout(timer);
            resolve(value);
          }
        },
        reject: (reason) => {
          if (state === 'pending') {
            state = 'rejected';
            clearTimeout(timer);
            reject(reason);
          }
        },
        method,
        timer,
      });
      try {
        this.#proc.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (state === 'pending') {
          state = 'rejected';
          reject(err);
        }
      }
    });
  }

  /** Fire-and-forget notification. */
  notify(method, params) {
    const message = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    this.#proc.send(message);
  }

  /** Open a document; stores the version so didChange can increment it. */
  didOpen(filePath, text, languageId = null) {
    const uri = pathToUri(filePath);
    const version = 1;
    this.#docs.set(uri, { version });
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageId ?? languageIdFor(filePath), version, text: String(text ?? "") },
    });
    return uri;
  }

  /** Replace a document's text. Opens it first if it was never opened. */
  didChange(filePath, text) {
    const uri = pathToUri(filePath);
    const rec = this.#docs.get(uri);
    if (!rec) {
      this.didOpen(filePath, text);
      return uri;
    }
    rec.version += 1;
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: rec.version },
      contentChanges: [{ text: String(text ?? "") }],
    });
    return uri;
  }

  didSave(filePath, text = null) {
    const uri = pathToUri(filePath);
    const params = { textDocument: { uri } };
    if (text != null) params.text = String(text);
    this.notify("textDocument/didSave", params);
    return uri;
  }

  didClose(filePath) {
    const uri = pathToUri(filePath);
    this.#docs.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
    return uri;
  }

  isOpen(filePath) {
    return this.#docs.has(pathToUri(filePath));
  }

  /** Ask the client to open a file that is on disk but untracked. */
  isTrackedUri(uri) {
    return this.#docs.has(uri);
  }

  /** Gracefully shut the server down, then stop its process. */
  async stop({ timeoutMs = 2000 } = {}) {
    if (this.#stopped) return;
    try {
      if (this.#initialized) await this.request("shutdown", null, { timeoutMs });
    } catch {
      /* server may already be gone */
    }
    this.#stopped = true;
    try {
      this.notify("exit", undefined);
    } catch {
      /* stdin already closed */
    }
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(new LspRequestError("client stopped", { code: "lsp_stopped", method: entry.method }));
    }
    this.#pending.clear();
    await this.#proc?.stop({ timeoutMs });
  }
}

export default { LspClient, LspRequestError, pathToUri, uriToPath, languageIdFor };
