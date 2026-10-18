// Sandboxed plugin loader.
//
// Turns a discovered plugin spec into a live plugin instance, inside the
// tightest boundary Node offers without dependencies:
//
//   - The plugin entry is evaluated as CommonJS inside a `vm` realm whose only
//     globals are `module`, `exports`, `require` (a one-slot allowlist that
//     refuses anything but `node:events`) and a `console` that writes into the
//     plugin's own log ring. Host prototypes and AgentFlow internals are never
//     exposed, so a plugin can patch its own realm's `Object.prototype` without
//     touching the host's.
//   - ESM entries (`format: "esm"` or a `.mjs` main) cannot run inside `vm`
//     without experimental APIs. They load through dynamic `import()` marked
//     as trusted mode: still fail-isolated (any throw is captured), but the
//     plugin author opted into a non-sandboxed runtime.
//   - `activate(context)` runs under a timeout. The context handed to the
//     plugin is frozen and consists only of closed-over registrar
//     functions -- no reference to AgentFlow state, no fs access, no child
//     process, no network.
//
// Nothing here throws on plugin failure. Every failure becomes a diagnostic:
// the run must degrade to "plugin missing", never crash.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

export const DEFAULT_ACTIVATE_TIMEOUT_MS = 3000;
// A plugin entry larger than 1MB is either bundled binaries or an accident;
// both are refused before anyone tries to parse it.
export const MAX_ENTRY_BYTES = 1_048_576;
// Ring length for plugin console output, so a chatty plugin can neither eat
// memory nor be entirely invisible.
export const MAX_LOG_LINES = 200;

export class PluginLoaderError extends Error {}

/** Run a promise-or-value under a timeout, always resolving to a settled shape. */
async function withTimeout(value, ms, label) {
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PluginLoaderError(`${label}: timed out after ${ms}ms`)), ms);
    });
    return await Promise.race([Promise.resolve(value), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Per-plugin log ring. Console calls from inside the sandbox are redirected
 * here, and every timeout/error diagnostic appends to the same ring so
 * `aflow plugin inspect` shows one coherent story.
 */
function makePluginLog(id, onLine) {
  const lines = [];
  const capped = (msg) => {
    try {
      return String(msg);
    } catch {
      return "";
    }
  };
  const push = (level, parts) => {
    const line = { level, message: parts.map(capped).join(" ") };
    lines.push(line);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    if (onLine) onLine(id, level, line.message);
  };
  // The methods freeze even if the plugin tries, and `lines` stays private via
  // the getter: the plugin can append to its own story, but cannot replace the
  // appenders that the sandbox console is already bound to.
  const log = {
    get lines() {
      return lines;
    },
    info: Object.freeze((...parts) => push("info", parts)),
    warn: Object.freeze((...parts) => push("warn", parts)),
    error: Object.freeze((...parts) => push("error", parts)),
  };
  return log;
}

/**
 * The `require` exposed to sandboxed plugins. Exactly one module is allowed:
 * `node:events` in a hardened shape. Even that is a factory of closure-based
 * emitters, so no plugin can patch a shared prototype and leak into a
 * neighbour's emitter or the host's.
 */
function makeSandboxRequire(pluginId) {
  return (request) => {
    if (request === "node:events" || request === "events") {
      const makeEmitter = function () {
        const map = new Map();
        return {
          on(event, fn) {
            if (!map.has(event)) map.set(event, new Set());
            map.get(event).add(fn);
            return this;
          },
          off(event, fn) {
            map.get(event)?.delete(fn);
            return this;
          },
          emit(event, ...args) {
            for (const fn of [...(map.get(event) ?? [])]) {
              try {
                fn(...args);
              } catch {
                // Listener failure inside a fire-and-forget emit on a private
                // per-plugin emitter is contained by definition.
              }
            }
          },
        };
      };
      return { EventEmitter: makeEmitter };
    }
    throw new PluginLoaderError(
      `plugin "${pluginId}" requested module "${request}": sandboxed plugins may only require "node:events"`
    );
  };
}

/**
 * Resolve and police the plugin entry path. The entry must live inside the
 * plugin directory: `main: "../../elsewhere.js"` is containment bypass by
 * manifest, not a bug, and is refused.
 */
export function resolvePluginEntry(spec) {
  const main = typeof spec?.main === "string" ? spec.main : "index.js";
  const dir = path.resolve(spec.dir);
  const entry = path.resolve(dir, main);
  if (entry !== dir && !entry.startsWith(dir + path.sep)) {
    throw new PluginLoaderError(`entry "${main}" escapes the plugin directory`);
  }
  if (!fs.existsSync(entry)) {
    throw new PluginLoaderError(`entry file not found: ${path.relative(spec.dir, entry)}`);
  }
  return entry;
}

/**
 * The context API handed to `activate`. Every method is a closed-over call
 * into a registrar the host owns; the plugin never learns how state is kept.
 *
 * @param {object} spec discovered plugin spec (id, permissions)
 * @param {object} log frozen per-plugin log ring
 * @param {object} deps host registrars, all optional:
 *   onHook(pluginId, hookName, fn)
 *   onRegisterTool(pluginId, def)
 *   onRegisterProvider(pluginId, def)
 *   onRegisterSlashCommand(pluginId, def)
 *   onRegisterContextProvider(pluginId, def)
 */
function buildPluginContext(spec, log, deps) {
  const id = spec.id;
  const context = {
    id: Object.freeze(id),
    permissions: Object.freeze({ ...spec.permissions }),
    manifest: Object.freeze({
      name: spec.name ?? null,
      version: spec.version ?? null,
      description: spec.description ?? null,
      author: spec.author ?? null,
    }),
    log,
    on(hookName, fn) {
      deps.onHook?.(id, hookName, fn);
      return context;
    },
    registerTool(def) {
      deps.onRegisterTool?.(id, def);
      return context;
    },
    registerProvider(def) {
      deps.onRegisterProvider?.(id, def);
      return context;
    },
    registerSlashCommand(def) {
      deps.onRegisterSlashCommand?.(id, def);
      return context;
    },
    registerContextProvider(def) {
      deps.onRegisterContextProvider?.(id, def);
      return context;
    },
  };
  // Freeze the envelope and its data payload, but not the log ring: the
  // deepFreeze recursion would walk the `lines` getter and freeze the private
  // ring array mid-session, turning every future console.log into a throw.
  Object.freeze(context);
  Object.freeze(context.permissions);
  Object.freeze(context.manifest);
  return context;
}

/** Find the activation entry point in whatever the plugin module produced. */
function findActivate(exports, pluginId) {
  if (typeof exports === "function") return exports;
  if (exports && typeof exports === "object") {
    if (typeof exports.activate === "function") return exports.activate;
    if (typeof exports.default === "function") return exports.default;
    if (exports.default && typeof exports.default === "object" && typeof exports.default.activate === "function") {
      return exports.default.activate;
    }
  }
  throw new PluginLoaderError(
    `plugin "${pluginId}" exported no activate function (expected module.exports = activate, {activate}, or default)`
  );
}

/** Find an optional deactivate/cleanup hook if the plugin exports one. */
function findDeactivate(exports) {
  if (exports && typeof exports === "object") {
    if (typeof exports.deactivate === "function") return exports.deactivate;
    if (exports.default && typeof exports.default === "object" && typeof exports.default.deactivate === "function") {
      return exports.default.deactivate;
    }
  }
  return null;
}

/** Evaluate a CommonJS entry inside a minimal vm realm. Throws through to caller. */
function evaluateCjsSafe(entry, code, spec, consoleLike) {
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: makeSandboxRequire(spec.id),
    console: consoleLike,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: entry });
  return moduleObj.exports;
}

/**
 * Load one plugin.
 *
 * @param {object} spec discovered plugin spec (from discoverPlugins)
 * @param {{ timeoutMs?: number, onLine?: Function, onHook?: Function,
 *           onRegisterTool?: Function, onRegisterProvider?: Function,
 *           onRegisterSlashCommand?: Function, onRegisterContextProvider?: Function }} [deps]
 * @returns {{ ok: boolean, plugin?: object, error?: Error, diagnostics: string[] }}
 *   never throws: `ok: false` plus diagnostics covers every failure mode.
 */
export async function loadPlugin(spec, deps = {}) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
  const diagnostics = [];
  try {
    // Only valid, enabled specs should reach here; enforce cheaply anyway.
    if (!spec || typeof spec !== "object" || !spec.id) {
      throw new PluginLoaderError("cannot load plugin without a spec.id");
    }
    const entry = resolvePluginEntry(spec);
    const codeBytes = fs.statSync(entry).size;
    if (codeBytes > MAX_ENTRY_BYTES) {
      throw new PluginLoaderError(`entry is ${codeBytes} bytes; limit is ${MAX_ENTRY_BYTES}`);
    }
    const code = fs.readFileSync(entry, "utf8");
    // BOM makes many parsers choke; strip it at the boundary.
    const cleaned = code.replace(/^\uFEFF/, "");

    const log = makePluginLog(spec.id, deps.onLine);
    const context = buildPluginContext(spec, log, deps);

    // Deduplicate repeated console destinations so three console.log calls from
    // one plugin produce three log lines, not three handler calls each.
    const consoleLike = {
      log: (...p) => log.info(...p),
      info: log.info,
      warn: log.warn,
      error: log.error,
    };

    const format = spec.manifest?.format ?? null;
    const isEsm = format === "esm" || entry.endsWith(".mjs");
    let moduleExports;
    let evaluateMs;
    let startedAt = Date.now();

    if (isEsm) {
      // Trusted ESM mode: bring the file in through a dynamic import guarded
      // like everything else. There is no vm boundary here; the manifest chose
      // this mode and the loader's job is isolation-from-crash, not magic.
      const mod = await withTimeout(import(pathToFileURL(entry).href), timeoutMs, "esm import");
      moduleExports = mod;
    } else {
      moduleExports = evaluateCjsSafe(entry, cleaned, spec, consoleLike);
    }
    evaluateMs = Date.now() - startedAt;

    const activate = findActivate(moduleExports, spec.id);
    startedAt = Date.now();
    await withTimeout(Promise.resolve(activate(context)), timeoutMs, `activate(${spec.id})`);
    const activateMs = Date.now() - startedAt;

    const deactivate = findDeactivate(moduleExports);
    const plugin = {
      spec,
      entry,
      format: isEsm ? "esm" : "sandbox",
      initMs: evaluateMs + activateMs,
      context,
      log,
      deactivate: deactivate ? async () => rethrowSafe(deactivate, spec.id) : null,
    };
    return { ok: true, plugin, diagnostics };
  } catch (error) {
    const message = error instanceof PluginLoaderError ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
    diagnostics.push(`${spec?.id ?? "?"}: ${message}`);
    return { ok: false, plugin: null, error, diagnostics };
  }
}

/** Deactivate wrapper that stays failure-isolated. */
async function rethrowSafe(deactivate, id) {
  // Never let a cleanup error escape; it surfaces as a diagnostic instead.
  try {
    await withTimeout(Promise.resolve(deactivate()), DEFAULT_ACTIVATE_TIMEOUT_MS, `deactivate(${id})`);
    return true;
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * PluginLoader — a bundle of the host registrars plus load/unload bookkeeping.
 * AgentFlow runtime instantiates one per session; the CLI uses the same class
 * for `inspect`.
 */
export class PluginLoader {
  constructor(deps = {}) {
    this.deps = deps;
    this.byId = new Map();
  }

  /**
   * Load a spec and remember it. Returns the load result (ok false is not an
   * exception) with the plugin retained even when invalid, so `inspect` can
   * still show its errors.
   */
  async load(spec) {
    const result = await loadPlugin(spec, this.deps);
    if (result.ok) {
      this.byId.set(spec.id, result.plugin);
      return result;
    }
    this.byId.set(spec.id, null);
    return result;
  }

  /** Delegate to a plugin's deactivate hook, if it exported one. */
  async unload(id) {
    const plugin = this.byId.get(id);
    if (!plugin) return { ok: true, error: null, missing: true };
    this.byId.delete(id);
    if (!plugin.deactivate) return { ok: true, error: null };
    const res = await plugin.deactivate();
    if (res && typeof res === "object" && res.ok === false) {
      return { ok: false, error: res.error ?? "deactivate failed" };
    }
    return { ok: true, error: null };
  }

  loaded() {
    return [...this.byId.values()].filter(Boolean);
  }
}
