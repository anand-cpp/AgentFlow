// Repository map, phase 5: orchestration and the disk cache.
//
// The pipeline is walk → extract → graph → pagerank → snapshot. The snapshot
// is everything a later phase needs — per-file symbols/imports, the ranked
// scores, and the mtime index — persisted to `<root>/.agentflow/repo-map.json`
// with the same atomic-write discipline the other stores use.
//
// Incremental refresh re-reads nothing it does not have to: a fresh walk is
// cheap, extraction is not. Files whose mtime+size match the cache reuse their
// old extracted unit verbatim; new files are extracted; vanished files are
// dropped. The graph and rank are always recomputed — both are cheap, and
// correctness beats cleverness on the parts that take milliseconds.
//
// Failure policy: a map is an optimisation. Any read/parse error degrades to
// "no map" or "stale map", never a crash in the caller.

import fs from "node:fs";
import path from "node:path";

import { walkWorkspace } from "./walk.js";
import { extractSource, detectLanguage } from "./extract.js";
import { buildRefGraph } from "./graph.js";
import { pagerank } from "./pagerank.js";
import { writeAtomicFile, readJsonFile } from "../persist.js";

export const CACHE_RELATIVE = ".agentflow/repo-map.json";
export const SNAPSHOT_VERSION = 1;

/** Read+extract all walkable files, honouring an optional language allowlist. */
function extractUnits(walk, languages) {
  const wanted = Array.isArray(languages) && languages.length ? new Set(languages) : null;
  const units = [];
  for (const file of walk.files) {
    if (wanted && !wanted.has(detectLanguage(file.rel))) continue;
    let text;
    try {
      text = fs.readFileSync(file.abs, "utf8");
    } catch {
      continue; // raced with a delete; the map ships without this file
    }
    units.push(extractSource(file.rel, text));
  }
  return units;
}

/** Absolute path of the map cache for a workspace root. */
export function cachePathFor(root) {
  return path.join(String(root), CACHE_RELATIVE);
}

/**
 * Build (or rebuild) the map for a workspace and write the cache.
 *
 * @param {string} root absolute workspace root
 * @param {{ maxFiles?: number, gitignore?: boolean, biases?: Map<string, number>, languages?: string[], write?: boolean }} [options]
 */
export function buildMap(root, options = {}) {
  const walk = walkWorkspace(root, {
    maxFiles: options.maxFiles,
    gitignore: options.gitignore,
  });

  const units = extractUnits(walk, options.languages);

  const fileSet = new Set(walk.files.map((f) => f.rel));
  const { graph, unresolved } = buildRefGraph(units, { fileSet });
  const scores = pagerank(graph, { biases: options.biases ?? null });
  const size = graph.size();

  const snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: Date.now(),
    root: String(root),
    files: walk.files.map(({ rel, size: bytes, mtimeMs }) => ({ rel, size: bytes, mtimeMs })),
    truncated: walk.truncated,
    units,
    scores: [...scores.entries()].map(([id, score]) => ({ id, score })),
    unresolved: unresolved.slice(0, 500),
    stats: { files: walk.files.length, nodes: size.nodes, edges: size.edges },
  };

  if (options.write !== false) {
    writeSnapshot(root, snapshot);
  }
  return snapshot;
}

/**
 * Load a cached snapshot. Corrupt or foreign-version caches read as absent —
 * the map is derived data, so silently rebuilding is always correct.
 *
 * @param {string} root
 * @returns {object|null}
 */
export function loadMap(root) {
  let result;
  try {
    result = readJsonFile(cachePathFor(root));
  } catch {
    return null;
  }
  if (!result || !result.ok) return null;
  const parsed = result.value;
  if (parsed.version !== SNAPSHOT_VERSION) return null;
  if (!Array.isArray(parsed.files) || !Array.isArray(parsed.scores)) return null;
  return parsed;
}

/**
 * Refresh the map, re-extracting only what changed.
 *
 * @param {string} root
 * @param {{ maxFiles?: number, biases?: Map<string, number>, languages?: string[], write?: boolean }} [options]
 * @returns {{ snapshot: object, changed: string[], removed: string[], rebuilt: boolean }}
 */
export function refreshMap(root, options = {}) {
  const previous = loadMap(root);
  if (!previous) {
    return { snapshot: buildMap(root, options), changed: [], removed: [], rebuilt: true };
  }

  const walk = walkWorkspace(root, { maxFiles: options.maxFiles });
  const current = new Map(walk.files.map((f) => [f.rel, f]));
  const prior = new Map(previous.files.map((f) => [f.rel, f]));
  const priorUnits = new Map((previous.units ?? []).map((u) => [u.file, u]));

  const changed = [];
  const removed = [];
  const units = [];

  const wanted = Array.isArray(options.languages) && options.languages.length
    ? new Set(options.languages)
    : null;

  for (const [rel, file] of current) {
    if (wanted && !wanted.has(detectLanguage(rel))) continue;
    const old = prior.get(rel);
    if (old && old.size === file.size && old.mtimeMs === file.mtimeMs && priorUnits.has(rel)) {
      units.push(priorUnits.get(rel));
      continue;
    }
    changed.push(rel);
    let text;
    try {
      text = fs.readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    units.push(extractSource(rel, text));
  }
  for (const rel of prior.keys()) {
    if (!current.has(rel)) removed.push(rel);
  }

  const fileSet = new Set(current.keys());
  const { graph, unresolved } = buildRefGraph(units, { fileSet });
  const scores = pagerank(graph, { biases: options.biases ?? null });
  const size = graph.size();

  const snapshot = {
    version: SNAPSHOT_VERSION,
    generatedAt: Date.now(),
    root: String(root),
    files: walk.files.map(({ rel, size: bytes, mtimeMs }) => ({ rel, size: bytes, mtimeMs })),
    truncated: walk.truncated,
    units,
    scores: [...scores.entries()].map(([id, score]) => ({ id, score })),
    unresolved: unresolved.slice(0, 500),
    stats: { files: walk.files.length, nodes: size.nodes, edges: size.edges },
  };

  if (options.write !== false) {
    writeSnapshot(root, snapshot);
  }
  return { snapshot, changed, removed, rebuilt: false };
}

/**
 * Is the cache missing or provably behind at least one file on disk? A cheap
 * mtime comparison over the cached index — no extraction, no graph.
 *
 * @param {string} root
 * @returns {{ present: boolean, stale: boolean, ageMs: number|null, reason: string|null }}
 */
export function mapFreshness(root) {
  const map = loadMap(root);
  if (!map) return { present: false, stale: true, ageMs: null, reason: "not built" };
  const generatedAt = Number(map.generatedAt) || 0;
  for (const file of map.files) {
    try {
      const st = fs.statSync(path.join(String(root), file.rel));
      if (Math.round(st.mtimeMs) > file.mtimeMs) {
        return { present: true, stale: true, ageMs: Date.now() - generatedAt, reason: file.rel };
      }
    } catch {
      return { present: true, stale: true, ageMs: Date.now() - generatedAt, reason: file.rel };
    }
  }
  return { present: true, stale: false, ageMs: Date.now() - generatedAt, reason: null };
}

function writeSnapshot(root, snapshot) {
  try {
    writeAtomicFile(cachePathFor(root), JSON.stringify(snapshot));
  } catch {
    // A read-only workspace or a full disk loses the cache, not the run.
  }
}

/** Default workspace root: cwd, or the nearest thing that looks like a repo. */
export function defaultRoot() {
  return path.resolve(process.cwd());
}

export default { buildMap, loadMap, refreshMap, mapFreshness, cachePathFor, CACHE_RELATIVE };
