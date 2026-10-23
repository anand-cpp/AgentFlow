// Plugin manifest schema.
//
// A plugin declares itself with an `agentflow.plugin.json` file in its
// directory, or with an `agentflowPlugin` key in its package.json. Both forms
// carry the same fields; the JSON file is the preferred, dependency-free form,
// while the package.json key lets npm-published plugins ship as normal
// packages.
//
// Everything here is pure validation and parsing: no filesystem writes, no
// evaluation. The manifest file itself is never executed -- only the plugin's
// `main` entry, much later and only by the loader, ever runs.

import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILE = "agentflow.plugin.json";
export const PKG_KEY = "agentflowPlugin";

// Identifiers are namespaced into tool names (`plugin__<id>__<tool>`) and
// command names, so they are restricted to a conservative charset. Case is
// preserved for display, matched case-insensitively, and the whole string is
// capped at 64 chars.
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Version fields accept plain semver (`1.2.3`) plus prerelease/build suffixes.
// Ranges (`^1.0.0`) are deliberately rejected: plugin authors should pin the
// minimum they actually tested against.
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

// The five permission domains a plugin may declare. Unknown keys in
// `permissions` are rejected rather than ignored: a typo like `provders`
// silently granting nothing is a worse failure than a load-time error.
// `context` governs context-provider registration; it is enforced as an
// active gate in PluginManager, not just declared metadata.
export const PERMISSION_KEYS = ["tools", "providers", "hooks", "commands", "context"];

/** Read a JSON file, tolerating BOM and absent files. Returns null on any problem. */
export function readManifestJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const cleaned = raw.replace(/^\uFEFF/, "");
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the manifest for a plugin directory. Tries `agentflow.plugin.json`
 * first, then package.json's `agentflowPlugin` key.
 *
 * @param {string} dir absolute plugin directory
 * @returns {{ manifest: object|null, source: string|null, error: string|null }}
 *   manifest is null when neither source exists or JSON is unparseable; error
 *   carries a one-line diagnostic for the doctor and CLI.
 */
export function readPluginManifest(dir) {
  const file = path.join(dir, MANIFEST_FILE);
  let raw = readManifestJson(file);
  if (raw) {
    if (raw[PKG_KEY] && typeof raw[PKG_KEY] === "object") {
      return { manifest: raw[PKG_KEY], source: MANIFEST_FILE, error: null };
    }
    return { manifest: raw, source: MANIFEST_FILE, error: null };
  }
  // The plugin file exists but failed to parse -- a diagnostic beats silence.
  if (fs.existsSync(file)) {
    return { manifest: null, source: MANIFEST_FILE, error: `${MANIFEST_FILE}: invalid JSON` };
  }
  // package.json form.
  const pkgPath = path.join(dir, "package.json");
  const pkg = readManifestJson(pkgPath);
  if (pkg && pkg[PKG_KEY]) {
    if (typeof pkg[PKG_KEY] === "object") {
      return { manifest: pkg[PKG_KEY], source: "package.json", error: null };
    }
    return { manifest: null, source: "package.json", error: "package.json: agentflowPlugin must be an object" };
  }
  return { manifest: null, source: null, error: null };
}

/**
 * Validate a manifest object.
 *
 * @param {object|null} manifest candidate manifest
 * @returns {{ valid: boolean, errors: string[] }} all problems at once, so
 *   plugin authors fix everything in a single round trip.
 */
export function validatePluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest must be a JSON object"] };
  }

  const id = manifest.id;
  if (typeof id !== "string" || id.trim() === "") {
    errors.push("id: required, must be a non-empty string");
  } else if (!ID_RE.test(id)) {
    errors.push(
      `id: must match ${ID_RE.source} (letters, digits, dot, dash, underscore; max 64 chars)`
    );
  }

  for (const key of ["name", "description", "author"]) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      errors.push(`${key}: must be a string`);
    }
  }

  for (const key of ["version", "minAgentFlowVersion"]) {
    if (manifest[key] !== undefined && !VERSION_RE.test(manifest[key])) {
      errors.push(`${key}: must be plain semver like 1.2.3 (optional -suffix)`);
    }
  }

  if (manifest.main !== undefined) {
    const main = manifest.main;
    if (typeof main !== "string" || main.trim() === "") {
      errors.push("main: must be a non-empty relative path");
    } else if (path.isAbsolute(main)) {
      errors.push("main: must be a relative path, not absolute");
    } else if (main.split(/[\\/]/).includes("..")) {
      errors.push("main: must not traverse outside the plugin directory");
    }
  }

  if (manifest.permissions !== undefined) {
    const perms = manifest.permissions;
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) {
      errors.push("permissions: must be an object");
    } else {
      for (const [key, value] of Object.entries(perms)) {
        if (!PERMISSION_KEYS.includes(key)) {
          errors.push(`permissions.${key}: unknown permission (expected one of: ${PERMISSION_KEYS.join(", ")})`);
        } else if (typeof value !== "boolean" && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
          errors.push(`permissions.${key}: must be boolean or an array of strings`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compare a minimum-required version against the running AgentFlow version.
 * Numeric triple comparison on the release part; prerelease tags are ignored
 * (a plugin asking for 1.2.3 runs on 1.2.3-beta -- erring toward accepting
 * same-version prerelease rather than rejecting a plugin over a tag).
 *
 * @param {string} min minimum version, e.g. "1.2.0"
 * @param {string} current running version, e.g. VERSION
 * @returns {boolean} true when current >= min
 */
export function satisfiesMinVersion(min, current) {
  const triple = (v) => String(v ?? "").split("-", 1)[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [a, b, c] = triple(min);
  const [x, y, z] = triple(current);
  if (x !== a) return x > a;
  if (y !== b) return y > b;
  return z >= c;
}

/**
 * Build a normalized plugin specification from a directory: manifest read,
 * validated, enriched with dir/source/error metadata. Never throws -- an
 * invalid manifest yields a spec with `valid: false` and errors, which the
 * discovery layer and doctor surface as diagnostics.
 *
 * @param {string} dir absolute plugin directory
 * @param {{ currentVersion?: string }} [opts]
 */
export function loadPluginSpec(dir, { currentVersion = "" } = {}) {
  const base = {
    id: null,
    name: null,
    version: null,
    description: null,
    author: null,
    main: null,
    permissions: { tools: false, providers: false, hooks: false, commands: false },
    minAgentFlowVersion: null,
    versionOk: true,
    dir,
    source: null,
    valid: false,
    errors: [],
  };

  const { manifest, source, error } = readPluginManifest(dir);
  if (error) {
    return { ...base, source, errors: [error] };
  }
  if (!manifest) {
    return { ...base, errors: [`no ${MANIFEST_FILE} and no package.json ${PKG_KEY} key`] };
  }

  const { valid: schemaValid, errors } = validatePluginManifest(manifest);
  // Missing id: fall back to the directory name as the identifier so the
  // plugin can still be listed and disabled, but keep the validation errors.
  const id = typeof manifest.id === "string" && ID_RE.test(manifest.id) ? manifest.id : path.basename(dir);

  const perms = {};
  for (const key of PERMISSION_KEYS) perms[key] = false;
  if (manifest.permissions && typeof manifest.permissions === "object") {
    for (const key of PERMISSION_KEYS) {
      if (key in manifest.permissions) perms[key] = manifest.permissions[key];
    }
  }

  const minVersion = typeof manifest.minAgentFlowVersion === "string" ? manifest.minAgentFlowVersion : null;
  const versionOk = minVersion && currentVersion ? satisfiesMinVersion(minVersion, currentVersion) : true;

  return {
    ...base,
    id,
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    description: typeof manifest.description === "string" ? manifest.description : null,
    author: typeof manifest.author === "string" ? manifest.author : null,
    // Default entry: index.js, unless an ESM index.mjs exists. Manifest authors
    // who write either explicitly always win.
    main:
      typeof manifest.main === "string" && manifest.main.trim() !== ""
        ? manifest.main
        : fs.existsSync(path.join(dir, "index.mjs"))
          ? "index.mjs"
          : "index.js",
    permissions: perms,
    minAgentFlowVersion: minVersion,
    versionOk,
    dir,
    source,
    valid: schemaValid && versionOk,
    errors: versionOk
      ? errors
      : [...errors, `requires AgentFlow >= ${minVersion}, running ${currentVersion || "(unknown)"}`],
  };
}
