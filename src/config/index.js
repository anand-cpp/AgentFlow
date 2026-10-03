// Configuration hierarchy with documented precedence.
//
// Precedence, lowest to highest:
//
//   1. built-in defaults        (DEFAULTS below)
//   2. global config file        ~/.config/agentflow/config.json
//   3. project config file       ./.agentflow.json   (walked up from cwd)
//   4. environment variables     AGENTFLOW_*
//   5. command-line flags       --port, --json, ...
//
// Later layers override earlier ones. Object values are merged shallowly;
// a project config that sets only `port` does not erase a global `theme`.
//
// Design note: modelled on OpenCode's config/paths.ts, which walks up from the
// worktree collecting <name>.json then reverses so nearer files win.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_BASENAME = ".agentflow.json";

export const DEFAULTS = Object.freeze({
  // Local gateway to talk to. AgentFlow is a client; the gateway is external.
  baseUrl: "http://localhost:20127",
  apiKey: null,
  // How long to wait on a provider probe, in ms.
  probeTimeoutMs: 15000,
  // Model used when a command needs one and none was given.
  defaultModel: null,
  // Minimum confidence before doctor reports a provider as reachable.
  theme: "auto",
  // Emit structured JSON on stdout instead of human-readable text.
  json: false,
  // Suppress non-essential output.
  quiet: false,
  // Include stack traces and timing detail in errors.
  verbose: false,
  // Disable ANSI colour even when stdout is a TTY.
  noColor: false,
});

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    // A malformed config file must not make the CLI unusable. Report it as a
    // diagnostic and continue with lower-precedence layers.
    return { __parseError: `${file}: ${err.message}` };
  }
}

export function globalConfigPath() {
  const base =
    process.env.AGENTFLOW_CONFIG_DIR ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming", "agentflow")
      : path.join(os.homedir(), ".config", "agentflow"));
  return path.join(base, "config.json");
}

/**
 * Walk up from `startDir` looking for .agentflow.json, stopping at `stopDir`.
 * Returns paths ordered nearest-first so the caller can apply them in order
 * and have the closest file win.
 */
export function projectConfigPaths(startDir = process.cwd(), stopDir) {
  const found = [];
  let dir = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : null;

  for (;;) {
    const candidate = path.join(dir, CONFIG_BASENAME);
    if (fs.existsSync(candidate)) found.push(candidate);
    if (stop && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return found; // nearest first
}

const ENV_MAP = {
  AGENTFLOW_BASE_URL: "baseUrl",
  AGENTFLOW_API_KEY: "apiKey",
  AGENTFLOW_PROBE_TIMEOUT_MS: "probeTimeoutMs",
  AGENTFLOW_DEFAULT_MODEL: "defaultModel",
  AGENTFLOW_THEME: "theme",
  AGENTFLOW_JSON: "json",
  AGENTFLOW_QUIET: "quiet",
  AGENTFLOW_VERBOSE: "verbose",
};

/**
 * Parse an environment string into a boolean.
 * Unrecognised input falls back to the default rather than being coerced to
 * true — `AGENTFLOW_JSON=maybe` must not silently enable JSON output.
 */
function coerce(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function envLayer() {
  const out = {};
  for (const [envName, key] of Object.entries(ENV_MAP)) {
    const raw = process.env[envName];
    if (raw === undefined) continue;
    const target = DEFAULTS[key];
    if (typeof target === "number") {
      const n = Number(raw);
      if (!Number.isNaN(n)) out[key] = n;
    } else if (typeof target === "boolean") {
      out[key] = coerce(raw, target);
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Resolve the effective configuration.
 * Returns { config, sources, diagnostics } — sources records which files and
 * env vars contributed, so `aflow config` can explain where a value came from.
 */
export function resolveConfig({ flags = {}, cwd = process.cwd(), env = process.env } = {}) {
  const prevEnv = process.env;
  process.env = env;
  try {
    const sources = [];
    const diagnostics = [];
    let config = { ...DEFAULTS };

    const gPath = globalConfigPath();
    const gCfg = readJsonFile(gPath);
    if (gCfg) {
      if (gCfg.__parseError) diagnostics.push(gCfg.__parseError);
      else {
        config = { ...config, ...gCfg };
        sources.push(gPath);
      }
    }

    // projectConfigPaths returns nearest-first, but applying those in order
    // would let the *outermost* file win the final merge. Reverse so the
    // closest config to cwd has the last word.
    for (const p of projectConfigPaths(cwd).reverse()) {
      const cfg = readJsonFile(p);
      if (!cfg) continue;
      if (cfg.__parseError) {
        diagnostics.push(cfg.__parseError);
        continue;
      }
      config = { ...config, ...cfg };
      sources.push(p);
    }

    const envCfg = envLayer();
    if (Object.keys(envCfg).length) {
      config = { ...config, ...envCfg };
      sources.push("environment");
    }

    const flagCfg = {};
    if (flags.port) flagCfg.baseUrl = `http://localhost:${flags.port}`;
    for (const k of ["json", "quiet", "verbose", "noColor"]) {
      if (flags[k]) flagCfg[k] = true;
    }
    if (flags.model) flagCfg.defaultModel = flags.model;
    if (flags["base-url"]) flagCfg.baseUrl = flags["base-url"];
    if (Object.keys(flagCfg).length) {
      config = { ...config, ...flagCfg };
      sources.push("flags");
    }

    return { config, sources, diagnostics };
  } finally {
    process.env = prevEnv;
  }
}

export default { resolveConfig, projectConfigPaths, globalConfigPath, DEFAULTS };