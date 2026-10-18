// Repository map, phase 1: the workspace walk.
//
// A PageRank map is only as good as its file list, so this walk is deliberately
// boring and deliberately strict: gitignore-honouring (with nested files), a
// hard file cap with deterministic priority, symlink refusal, and binary
// refusal. The walker knows nothing about symbols or ranking — it answers one
// question, "which files are structurally relevant?", and hands on paths,
// sizes, and mtimes for the cache's change detector.
//
// Zero runtime dependencies. No git, no language servers.

import fs from "node:fs";
import path from "node:path";

export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 1_000_000;

/** Directories that are never structurally relevant, no matter what gitignore says. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".cache",
  "target",
  ".gradle",
  ".mypy_cache",
  ".agentflow",
]);

/** Extensions the map can never extract symbols from. */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svgz",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar", ".bz2", ".xz",
  ".pdf", ".exe", ".dll", ".so", ".dylib", ".wasm", ".node",
  ".class", ".jar", ".pyc", ".pyo", ".o", ".a", ".obj", ".lib",
  ".sqlite", ".db", ".dat", ".bin", ".lock",
]);

/**
 * Files the ranker wants first when the file cap bites: source extensions
 * (class 0), docs/config (class 1), everything else (class 2). Within a class
 * the sort key is the path, so the cut is deterministic on every platform.
 */
const SOURCE_EXT = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".hh",
  ".cs", ".php", ".sh", ".bash", ".lua", ".zig", ".sql",
]);
const DOC_EXT = new Set([".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css"]);

/** Which priority class a file belongs to, from its extension. */
export function fileClass(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (SOURCE_EXT.has(ext)) return 0;
  if (DOC_EXT.has(ext)) return 1;
  return 2;
}

/**
 * Compile one .gitignore file's text into rules.
 *
 * Supports the subset that determines 99% of real ignore files: comments,
 * blank lines, `!` negation, trailing `/` (directory-only), leading `/`
 * (anchored to the gitignore's own directory), `*`, `**`, and `?`. Rules carry
 * their base directory; `isIgnored` tests each path relative to the rule's
 * base, which is what makes nested .gitignore files behave like git's.
 *
 * @param {string} text
 * @param {string} baseRel relative directory the file lives at ("" for root)
 */
export function compileGitignore(text, baseRel = "") {
  const base = baseRel.replaceAll("\\", "/");
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      let pat = line;
      let neg = false;
      if (pat.startsWith("!")) {
        neg = true;
        pat = pat.slice(1);
      }
      const dirOnly = pat.endsWith("/");
      if (dirOnly) pat = pat.slice(0, -1);
      const anchored = pat.startsWith("/");
      if (anchored) pat = pat.slice(1);
      const body = globToRegex(pat);
      const re = anchored
        ? new RegExp(`^${body}(?:/|$)`)
        : new RegExp(`^(?:.*/)?${body}(?:/|$)`);
      return { neg, dirOnly, base, anchored, re };
    });
}

/** Convert a glob fragment to a regex body. `**` spans separators. */
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

/**
 * Is a path ignored? Rules are evaluated outermost-first and later rules win,
 * which reproduces git's "innermost file overrides, last pattern wins"
 * closely enough for a structural index without implementing full pattern
 * precedence. Each rule is tested against the path relative to the rule's own
 * base directory, so a nested `libs/.gitignore` governs only the subtree.
 *
 * @param {string} rel   path relative to the workspace root, "/"-separated
 * @param {boolean} isDir
 * @param {Array<{neg:boolean,dirOnly:boolean,base:string,anchored:boolean,re:RegExp}>} rules
 */
export function isIgnored(rel, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    // Rebase: a rule only governs paths under the directory its .gitignore
    // lives in. Everything else in that file cannot match.
    let sub = rel;
    if (rule.base) {
      const prefix = `${rule.base}/`;
      if (!rel.startsWith(prefix)) continue;
      sub = rel.slice(prefix.length);
    }
    // Anchored rules were compiled to match from the base; unanchored rules
    // carry an `(?:.*/)?` prefix so they match a basename at any depth.
    if (!rule.re.test(sub)) continue;
    ignored = !rule.neg;
  }
  return ignored;
}

/**
 * Walk the workspace.
 *
 * @param {string} root absolute workspace root
 * @param {object} [options]
 * @param {number} [options.maxFiles=MAX_FILES]        hard cap on returned files
 * @param {number} [options.maxFileBytes=MAX_FILE_BYTES] files above this are recorded
 *   as skipped (too big) rather than returned
 * @param {boolean} [options.gitignore=true]           honour .gitignore files
 * @returns {{ files: Array<{rel, abs, size, mtimeMs}>, truncated: boolean, skipped: {big:number, ignoredFiles:number} }}
 */
export function walkWorkspace(root, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const honourGitignore = options.gitignore !== false;

  const files = [];
  let truncated = false;
  let big = 0;
  let ignoredFiles = 0;
  // Outermost-first so inner rules override outer ones via last-match-wins.
  let rules = [];

  /**@param {string} dir absolute current directory @param {string} relPrefix */
  const walk = (dir, relPrefix) => {
    if (truncated) return;
    let ownRules = [];
    if (honourGitignore) {
      try {
        const text = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
        ownRules = compileGitignore(text, relPrefix);
        rules = rules.concat(ownRules);
      } catch {
        // no .gitignore here — fine
      }
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, never crash the map
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      // Symlinks are refused outright: a structural map must not chase links
      // out of the workspace or loop through an in-tree cycle.
      if (entry.isSymbolicLink()) continue;
      const isDir = entry.isDirectory();
      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (honourGitignore && isIgnored(rel, true, rules)) continue;
        walk(abs, rel);
        continue;
      }
      if (honourGitignore && isIgnored(rel, false, rules)) {
        ignoredFiles += 1;
        continue;
      }
      if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // raced with a delete between readdir and stat
      }
      if (stat.size > maxFileBytes) {
        big += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push({ rel, abs, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    }
    if (ownRules.length) rules = rules.slice(0, rules.length - ownRules.length);
  };

  walk(root, "");

  // Deterministic priority when the cap bites and always, so `aflow map show`
  // is stable across runs and platforms: source first, then docs, then the
  // rest, each alphabetical.
  files.sort((a, b) => {
    const ca = fileClass(a.rel);
    const cb = fileClass(b.rel);
    if (ca !== cb) return ca - cb;
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
  });

  return { files, truncated, skipped: { big, ignoredFiles } };
}

export default { walkWorkspace, compileGitignore, isIgnored, fileClass, MAX_FILES, MAX_FILE_BYTES };
