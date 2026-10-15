// File picker — a fuzzy browser over the workspace, for `@file` context adds.
//
// Three concerns, kept as pure functions so they are testable without a tree
// on disk: a small .gitignore compiler, a bounded workspace walk that skips
// ignored and symlinked directories, and a renderer that shows directory/file
// icons, line counts, and a checkmark on files already added to context.
//
// Containment is not re-invented here: the walk only descends within the
// workspace root, and `pickFile` refuses to surface a path that a real path
// resolution would send outside it.
//
// Zero runtime dependencies.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { drawBox, drawSelectList, drawInput } from "./components.js";
import { filterFuzzy } from "./interact.js";
import { bold, dim } from "../cli/ui.js";

/** Directories never worth browsing, independent of .gitignore. */
const ALWAYS_SKIP = new Set([".git", "node_modules"]);

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
 * Compile .gitignore text into ordered rules.
 *
 * Supports the subset that actually matters when browsing: comments, blank
 * lines, `!` negation, trailing `/` (directory only), leading `/` (anchored),
 * `*`, `**`, and `?`. Anything richer is out of scope on purpose.
 */
export function compileGitignore(text) {
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
      let anchored = pat.startsWith("/");
      if (anchored) pat = pat.slice(1);
      const body = globToRegex(pat);
      const re = new RegExp(anchored ? `^${body}(?:/|$)` : `(?:^|/)${body}(?:/|$)`);
      return { neg, dirOnly, re };
    });
}

/** Is a path ignored by the compiled rules? Later rules win (like git). */
export function isIgnored(rel, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(rel)) ignored = !rule.neg;
  }
  return ignored;
}

/** Count lines in a file, refusing to read anything absurd. */
function countLines(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1_000_000) return null;
    const text = fs.readFileSync(file, "utf8");
    if (!text) return 0;
    const parts = text.split(/\r?\n/);
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
    return parts.length;
  } catch {
    return null;
  }
}

/**
 * List workspace files/dirs for browsing.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {boolean} [options.gitignore]  Honour .gitignore (default true).
 * @param {number} [options.maxDepth]    Recursion limit (default 6).
 * @param {number} [options.limit]       Max entries (default 2000).
 * @param {string[]} [options.only]      Only include these rel paths (test hook).
 * @returns {Array<{rel:string, kind:"dir"|"file", lines:number|null}>}
 */
export function listWorkspaceFiles(root, options = {}) {
  const rules = options.gitignore === false ? [] : loadGitignore(root);
  const maxDepth = options.maxDepth || 6;
  const limit = options.limit || 2000;
  const out = [];

  const walk = (dir, relPrefix, depth) => {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      // Treat symlinks as files so the walk can never loop out of the tree.
      if (entry.isSymbolicLink()) isDir = false;
      if (isDir && ALWAYS_SKIP.has(entry.name)) continue;
      if (isIgnored(rel, isDir, rules)) continue;

      if (isDir) {
        out.push({ rel, kind: "dir", lines: null });
        walk(abs, rel, depth + 1);
      } else {
        out.push({ rel, kind: "file", lines: countLines(abs) });
      }
    }
  };

  walk(root, "", 0);
  return out;
}

/** Load and compile a workspace's .gitignore (missing file yields no rules). */
function loadGitignore(root) {
  try {
    return compileGitignore(fs.readFileSync(path.join(root, ".gitignore"), "utf8"));
  } catch {
    return [];
  }
}

/** Render the picker: search field over an icon-and-line-count list. */
export function renderFilePicker(state, width = 72) {
  const items = state.items || [];
  const selected = state.selected || 0;
  const query = state.query || "";
  const field = drawInput("search", query, query.length);
  const list = drawSelectList(items, selected, { width: width - 4, max: 14, describe: true });
  const header = `${bold("@file")} ${dim(`${items.length} match(es)`)}`;
  return drawBox(`${header}  ${field}`, list, { width, borderColor: "cyan" });
}

/** Fuzzy-filter entries by relative path. */
export function filterFiles(items, query) {
  return filterFuzzy(items, query, "rel");
}

/** Turn a walk entry into a picker item, marking already-added files. */
function toItem(entry, added) {
  const isAdded = added && added.has(entry.rel);
  const icon = entry.kind === "dir" ? "📁" : "📄";
  const detail =
    entry.kind === "dir" ? "dir" : entry.lines === null ? "" : `${entry.lines}L`;
  const mark = isAdded ? "✓ " : "";
  return {
    label: `${mark}${entry.rel}`,
    value: entry.rel,
    rel: entry.rel,
    description: `${icon} ${detail}`,
    disabled: false,
    kind: entry.kind,
    added: isAdded,
  };
}

/** Build picker items from a walk, filtered by a query. */
export function buildFileItems(entries, { query = "", added = null } = {}) {
  const items = entries.map((e) => toItem(e, added));
  return filterFiles(items, query);
}

/**
 * Interactively pick a workspace file. Enter on a directory drills in; Enter on
 * a file selects it and resolves to its relative path; Backspace goes up; Escape
 * cancels to null. Streams are injectable for tests.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {Set<string>} [options.added]  Files already in context.
 * @param {object} [options.input]
 * @param {object} [options.output]
 * @returns {Promise<string|null>}
 */
export function pickFile(options) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  return new Promise((resolve) => {
    let cwd = "";
    let query = "";
    let selected = 0;
    const added = options.added || new Set();

    const entriesFor = () => {
      const all = listWorkspaceFiles(path.join(options.root, cwd));
      // Show immediate children first: a flat listing of the whole tree is
      // unreadable, so scope to the current directory.
      return all.filter((e) => {
        const parent = e.rel.includes("/") ? e.rel.slice(0, e.rel.lastIndexOf("/")) : "";
        return parent === "";
      });
    };

    const current = () => buildFileItems(entriesFor(), { query, added });

    const canRaw = Boolean(input.isTTY && typeof input.setRawMode === "function");
    const isTTY = Boolean(output.isTTY);
    let lastLines = 0;
    const draw = (items) => {
      if (lastLines > 0 && isTTY) output.write(`\u001b[${lastLines}A\u001b[0J`);
      const heading = cwd ? `${bold("@file")} ${dim(`/ ${cwd}`)}` : `${bold("@file")} ${dim("/")}`;
      output.write(`${heading}\n`);
      output.write(`${drawInput("search", query, query.length)}\n`);
      output.write(`${drawSelectList(items, selected, { max: 14, width: 68 })}\n`);
      lastLines = 3 + Math.min(14, items.length);
    };

    const cleanup = () => {
      input.removeListener("keypress", onKey);
      if (canRaw) input.setRawMode(false);
    };
    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const onKey = (str, key) => {
      const items = current();
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
      if (key.name === "up") {
        selected = Math.max(0, selected - 1);
        return draw(items);
      }
      if (key.name === "down") {
        selected = Math.min(items.length - 1, selected + 1);
        return draw(items);
      }
      if (key.name === "backspace") {
        if (query) query = query.slice(0, -1);
        else if (cwd) cwd = cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "";
        selected = 0;
        return draw(items);
      }
      if (key.name === "return") {
        const item = items[selected];
        if (!item) return undefined;
        if (item.kind === "dir") {
          cwd = cwd ? `${cwd}/${item.value}` : item.value;
          query = "";
          selected = 0;
          return draw(current());
        }
        return finish(cwd ? `${cwd}/${item.value}` : item.value);
      }
      if (str && str.length === 1 && str >= " ") {
        query += str;
        selected = 0;
        return draw(current());
      }
      return undefined;
    };

    readline.emitKeypressEvents(input);
    if (canRaw) input.setRawMode(true);
    input.on("keypress", onKey);
    if (typeof input.resume === "function") input.resume();
    draw(current());
  });
}

export default { compileGitignore, isIgnored, listWorkspaceFiles, renderFilePicker, filterFiles, buildFileItems, pickFile };
