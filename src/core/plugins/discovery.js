// Plugin discovery.
//
// Scans the three install locations for plugin directories, reads each
// manifest into a normalized spec, and merges the user's enable/disable
// state from `.agentflow/plugins.json`. Discovery never evaluates plugin
// code -- it reads JSON manifests only; the dangerous part lives in the
// loader.
//
// Sources, in precedence order (first hit on an id wins):
//   1. `<workspace>/.agentflow/plugins/*`   -- project-local, highest trust
//   2. `<global-config>/plugins/*`          -- user-wide
//   3. `<workspace>/node_modules/` matching `agentflow-plugin-*` or
//      `@*/agentflow-plugin-*`              -- npm-shipped

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadPluginSpec, readPluginManifest } from "./manifest.js";
import { readJsonFile, writeAtomicFile } from "../persist.js";

const PLUGIN_PREFIX = "agentflow-plugin-";
const MANIFEST_NAME = "agentflow.plugin.json";

/** Directory holding project-local plugin installs. */
export function workspacePluginsDir(root = process.cwd()) {
  return path.join(root, ".agentflow", "plugins");
}

/** Directory holding user-wide plugin installs; mirrors globalConfigPath. */
export function globalPluginsDir() {
  const base =
    process.env.AGENTFLOW_CONFIG_DIR ||
    (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming", "agentflow")
      : path.join(os.homedir(), ".config", "agentflow"));
  return path.join(base, "plugins");
}

/** Enable/disable state file for the workspace. */
export function pluginsStateFile(root = process.cwd()) {
  return path.join(root, ".agentflow", "plugins.json");
}

/**
 * Read plugin enable/disable state. Unknown ids are ignored at use time, so the
 * state file stays safe to hand-edit.
 *
 * @returns {{ enabled: Record<string, boolean>, error: string|null }} empty map
 *   on any problem -- a corrupt state file must not disable plugins.
 */
export function readPluginState(root = process.cwd()) {
  const { ok, value } = readJsonFile(pluginsStateFile(root));
  if (!ok) return { enabled: {}, error: null };
  const plugins =
    value && typeof value === "object" && value.plugins && typeof value.plugins === "object"
      ? value.plugins
      : {};
  const enabled = {};
  for (const [id, entry] of Object.entries(plugins)) {
    // Plain booleans are the canonical on-disk shape; `{ enabled }` wrapper
    // objects are also accepted so hand-edited files are forgiving.
    if (typeof entry === "boolean") {
      enabled[id] = entry;
    } else if (entry && typeof entry === "object" && typeof entry.enabled === "boolean") {
      enabled[id] = entry.enabled;
    }
  }
  return { enabled, error: null };
}

/**
 * Persist enable/disable state. Writes are best-effort with an atomic rename;
 * a read-only workspace loses the toggle, not the run.
 *
 * @param {Record<string, boolean>} enabled map of plugin id -> boolean
 * @returns {{ ok: boolean, error: string|null }}
 */
export function writePluginState(enabled, root = process.cwd()) {
  const file = pluginsStateFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const out = {};
  for (const [id, entry] of Object.entries(enabled)) {
    out[id] = typeof entry === "boolean" ? entry : Boolean(entry?.enabled);
  }
  writeAtomicFile(file, JSON.stringify({ version: 1, plugins: out }, null, 2) + "\n");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Set one plugin's enabled flag, merging into existing state. */
export function setPluginEnabled(id, enabled, root = process.cwd()) {
  const { enabled: current } = readPluginState(root);
  const next = { ...current, [id]: Boolean(enabled) };
  return writePluginState(next, root);
}

/** Subdirectories of `dir` present on disk, path-sorted. Missing dir -> []. */
function subdirs(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => path.join(dir, name));
}

/** npm-style plugin package candidates under a node_modules root. */
function nodeModulePluginDirs(nodeModulesDir) {
  const out = [];
  for (const pkgDir of subdirs(nodeModulesDir)) {
    const name = path.basename(pkgDir);
    if (name.startsWith("@")) {
      // Scoped form: @scope/agentflow-plugin-x
      out.push(...subdirs(pkgDir).filter((d) => path.basename(d).startsWith(PLUGIN_PREFIX)));
    } else if (name.startsWith(PLUGIN_PREFIX)) {
      out.push(pkgDir);
    }
  }
  return out;
}

/**
 * Discover every installable plugin.
 *
 * @param {{ workspaceRoot?: string, globalDir?: string, nodeModulesDir?: string|null,
 *           currentVersion?: string }} [opts]
 * @returns {{ plugins: object[], diagnostics: string[] }} plugins are specs
 *   enriched with `source`, `status` (`enabled`|`disabled`|`invalid`) and the
 *   raw manifest attach; diagnostics carry one line per problem for the doctor.
 */
export function discoverPlugins({
  workspaceRoot = process.cwd(),
  globalDir = globalPluginsDir(),
  nodeModulesDir = path.join(workspaceRoot, "node_modules"),
  currentVersion = "",
} = {}) {
  const { enabled: state } = readPluginState(workspaceRoot);
  const plugins = [];
  const seen = new Set();
  const diagnostics = [];

  const addAll = (dirs, source) => {
    for (const dir of dirs) {
      const spec = loadPluginSpec(dir, { currentVersion });
      if (spec.source === null) {
        // Directory with no manifest: diagnostic in the dedicated plugin
        // trees; for node_modules candidates it is just a name match on a
        // non-plugin package, so stay quiet.
        if (source !== "node_modules") diagnostics.push(`${dir}: no ${MANIFEST_NAME} manifest`);
        continue;
      }
      if (seen.has(spec.id)) {
        diagnostics.push(`${spec.id}: duplicate plugin (shadowed by an earlier ${source})`);
        continue;
      }
      seen.add(spec.id);
      const manifest = readPluginManifest(dir);
      const status = !spec.valid ? "invalid" : state[spec.id] === false ? "disabled" : "enabled";
      plugins.push({
        ...spec,
        source,
        status,
        manifest: manifest.manifest,
        manifestSource: manifest.source,
        manifestError: manifest.error,
      });
      for (const err of spec.errors) diagnostics.push(`${spec.id}: ${err}`);
    }
  };

  addAll(subdirs(workspacePluginsDir(workspaceRoot)), "workspace");
  addAll(subdirs(globalDir), "global");
  addAll(nodeModulePluginDirs(nodeModulesDir), "node_modules");

  return { plugins, diagnostics };
}
