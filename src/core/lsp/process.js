// Language-server process supervision.
//
// A language server is a long-lived child process that speaks LSP over stdio.
// Two things must never happen: it must not take AgentFlow down with it when it
// crashes, and a crash must not silently disable every LSP feature for the rest
// of the session. So this wrapper owns the child lifecycle -- spawn, frame the
// streams, restart on an unexpected exit with a bounded backoff -- and reports
// every state change as an event. The client above it only sees messages.

import { spawn } from "node:child_process";
import { LspFrameDecoder, encodeLspMessage } from "./framing.js";

/**
 * Quote one argument for a Windows `cmd.exe` command line.
 *
 * npm-installed language servers land as `.cmd` shims, which CreateProcess
 * cannot execute directly, so on Windows we launch through the command
 * interpreter. That means every argument -- including absolute paths with
 * spaces -- has to be quoted by us; Node's `shell: true` does not do it and
 * instead emits a deprecation warning about exactly that.
 */
function quoteWinArg(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (!/[\s"]/.test(s)) return s;
  return `"${s}"`;
}

/**
 * Default launcher: a thin Windows-aware wrapper over child_process.spawn.
 *
 * On Windows the command line is routed through cmd.exe with
 * `windowsVerbatimArguments`, so the quoting we build is exactly what the
 * interpreter sees (Node does not add a second layer), and npm `.cmd` shims
 * become runnable.
 */
function defaultSpawn(command, args, options) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    const line = [command, ...args].map(quoteWinArg).join(" ");
    return spawn(comspec, ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, args, options);
}

export class LspProcessError extends Error {
  /** @param {string} message @param {{ code?: string, cause?: unknown }} [opts] */
  constructor(message, { code = "lsp_process_error", cause } = {}) {
    super(message);
    if (cause) this.cause = cause;
    this.name = "LspProcessError";
    this.code = code;
  }
}

/**
 * @typedef {object} LspProcessOptions
 * @property {string} command executable name or path
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {Record<string, string>} [env] extra environment merged over process.env
 * @property {number} [maxRestarts] consecutive crash restarts before giving up
 * @property {number} [restartDelayMs] base backoff between restarts
 * @property {Function} [spawn] injectable child_process.spawn (tests)
 * @property {object} [log] optional { debug, warn, error }
 */

/**
 * Events: `message` (parsed LSP object), `stderr` (string), `restart`
 * ({ attempt }), `error` (LspProcessError), `exit` ({ code, signal, willRestart }).
 */
export class LspProcess {
  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();
  /** @type {string} */
  #command;
  /** @type {string[]} */
  #args;
  /** @type {string|undefined} */
  #cwd;
  /** @type {Record<string,string>|undefined} */
  #env;
  #maxRestarts;
  #restartDelayMs;
  #spawn;
  /** @type {import("node:child_process").ChildProcess|null} */
  #child = null;
  #decoder = new LspFrameDecoder();
  #running = false;
  #stopping = false;
  #starts = 0;
  #restarts = 0;
  /** @type {NodeJS.Timeout|null} */
  #restartTimer = null;
  #log;

  /** @param {LspProcessOptions} options */
  constructor({ command, args = [], cwd, env, maxRestarts = 3, restartDelayMs = 500, spawn: spawnFn = defaultSpawn, log = null }) {
    if (!command || typeof command !== "string") {
      throw new LspProcessError("a language server command is required", { code: "lsp_no_command" });
    }
    this.#command = command;
    this.#args = args;
    this.#cwd = cwd;
    this.#env = env;
    this.#maxRestarts = maxRestarts;
    this.#restartDelayMs = restartDelayMs;
    this.#spawn = spawnFn;
    this.#log = log;
  }

  get command() {
    return this.#command;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  /** True while a child is alive and accepting writes. */
  get running() {
    return this.#running && this.#child != null && this.#child.exitCode == null;
  }

  /** How many times the server has been started (first run included). */
  get starts() {
    return this.#starts;
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
   * Subscribe to a lifecycle event. Returns an unsubscribe function.
   *
   * Events: `message`, `stderr`, `restart`, `error`, `exit`. A listener error
   * is contained -- one bad subscriber must not stop the supervisor.
   *
   * @param {string} type
   * @param {(detail: any) => void} fn
   * @returns {() => void}
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

  /**
   * Spawn the server. Idempotent: calling it while running is a no-op.
   * @returns {this}
   */
  start() {
    if (this.running) return this;
    this.#stopping = false;
    this.#decoder = new LspFrameDecoder();
    this.#starts += 1;

    let child;
    try {
      child = this.#spawn(this.#command, this.#args, {
        cwd: this.#cwd,
        env: this.#env ? { ...process.env, ...this.#env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      const error = new LspProcessError(`failed to spawn ${this.#command}: ${err.message}`, {
        code: "lsp_spawn_failed",
        cause: err,
      });
      this.#emit("error", error);
      throw error;
    }

    this.#child = child;
    this.#running = true;

    child.stdout?.on("data", (chunk) => this.#onData(chunk));
    child.stderr?.on("data", (chunk) => this.#emit("stderr", String(chunk)));
    child.on("error", (err) => {
      this.#emit(
        "error",
        new LspProcessError(`language server error: ${err.message}`, { code: "lsp_spawn_failed", cause: err }),
      );
    });
    child.on("exit", (code, signal) => this.#onExit(code, signal));

    this.#log?.debug?.(`lsp: started ${this.#command} (pid ${child.pid})`);
    return this;
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.#decoder.push(chunk);
    } catch (err) {
      // A framing fault means the stream is unrecoverable; surface it and let
      // the supervisor restart rather than emit garbage forever.
      this.#emit("error", err);
      this.#restart("framing error");
      return;
    }
    for (const message of messages) this.#emit("message", message);
  }

  #onExit(code, signal) {
    this.#running = false;
    this.#child = null;
    const willRestart = !this.#stopping && this.#restarts < this.#maxRestarts;
    this.#emit("exit", { code, signal, willRestart });
    this.#log?.warn?.(`lsp: ${this.#command} exited (code ${code}, signal ${signal})`);

    if (this.#stopping) return;
    if (this.#restarts >= this.#maxRestarts) {
      this.#emit(
        "error",
        new LspProcessError(
          `language server ${this.#command} exited ${this.#restarts + 1} time(s); giving up`,
          { code: "lsp_restart_exhausted" },
        ),
      );
      return;
    }
    this.#restart("exit");
  }

  #restart(reason) {
    if (this.#stopping) return;
    this.#restarts += 1;
    const delay = this.#restartDelayMs * this.#restarts;
    this.#log?.warn?.(`lsp: restarting ${this.#command} (${reason}) in ${delay}ms`);
    this.#emit("restart", { attempt: this.#restarts, delayMs: delay, reason });
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping) this.start();
    }, delay);
    if (typeof this.#restartTimer.unref === "function") this.#restartTimer.unref();
  }

  /**
   * Write one message to the server's stdin as a framed LSP packet.
   * @param {any} message
   */
  send(message) {
    if (!this.running || !this.#child?.stdin) {
      throw new LspProcessError(`cannot send: ${this.#command} is not running`, { code: "lsp_not_running" });
    }
    this.#child.stdin.write(encodeLspMessage(message));
  }

  /**
   * Terminate the child (and, on Windows, its whole tree).
   *
   * On Windows the server is launched under cmd.exe, so `child.kill()` would
   * only reap the interpreter and leave the real server orphaned. `taskkill /T`
   * takes the tree down. Elsewhere a plain signal is correct.
   */
  #killTree(child, force) {
    if (process.platform === "win32" && child.pid) {
      try {
        const args = ["/pid", String(child.pid), "/T"];
        if (force) args.push("/F");
        spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      } catch {
        try { child.kill(); } catch { /* already gone */ }
      }
      return;
    }
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  /**
   * Stop the server and wait for it to exit. No restart follows.
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ code: number|null, signal: string|null }>}
   */
  stop({ timeoutMs = 2000 } = {}) {
    this.#stopping = true;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (!child || child.exitCode != null) {
      this.#child = null;
      this.#running = false;
      return Promise.resolve({ code: child?.exitCode ?? null, signal: null });
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ code: child.exitCode ?? null, signal: child.signalCode ?? null });
      };
      // Escalation: a server that ignores a soft kill (or is wedged) still has
      // to die so the CLI can exit.
      const killTimer = setTimeout(() => {
        this.#killTree(child, true);
        // Last resort: resolve even if no exit event ever arrives.
        const bail = setTimeout(done, 500);
        if (typeof bail.unref === "function") bail.unref();
      }, timeoutMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
      child.once("exit", done);
      this.#killTree(child, false);
    });
  }
}

export default { LspProcess, LspProcessError };
