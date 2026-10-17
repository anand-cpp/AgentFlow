// Diff generation and unified-diff parsing.
//
// We do not compute diffs ourselves: git already emits them, and its hunks are
// the ones that will actually be applied. So this module runs `git diff` and
// parses the unified format into structure. That also keeps it headless -- there
// is no import from src/tui/diff.js, and nothing here draws anything.
//
// Unified-diff grammar we consume:
//   diff --git a/<old> b/<new>
//   new file mode <mode> | deleted file mode <mode> | similarity index N%
//   rename from <old> | rename to <new> | copy from <old> | copy to <new>
//   Binary files a/x and b/x differ
//   --- a/<old>   (or /dev/null)
//   +++ b/<new>   (or /dev/null)
//   @@ -oldStart[,oldCount] +newStart[,newCount] @@ <section>
//    <context> | +<add> | -<delete> | \ No newline at end of file

import { validatePaths } from "./discover.js";

/** @typedef {{ type: "context"|"add"|"delete"|"no-newline", content: string, oldLine: number|null, newLine: number|null }} DiffLine */

/**
 * Strip git's a/ b/ prefixes and normalise /dev/null to null.
 * @param {string} raw
 */
function stripPathPrefix(raw) {
  let text = raw.trim();
  if (text === "/dev/null") return null;
  if (text.startsWith('"') && text.endsWith('"')) {
    // Quoted path (special characters). Best-effort unquote.
    text = text.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (text.startsWith("a/") || text.startsWith("b/")) text = text.slice(2);
  return text;
}

/**
 * Parse the `diff --git a/X b/Y` header as a last-resort path source (quoted or
 * unusual paths are covered by the ---/+++ lines; this is a fallback for pure
 * renames/binary entries that carry no ---/+++).
 * @param {string} header
 */
function pathsFromGitHeader(header) {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  if (!m) return { oldPath: null, newPath: null };
  return { oldPath: stripPathPrefix(`a/${m[1]}`), newPath: stripPathPrefix(`b/${m[2]}`) };
}

/** @param {string} header */
function parseHunkHeader(header) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(header);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
    section: m[5] || "",
  };
}

/**
 * Parse raw unified-diff text into structured files and hunks.
 *
 * Pure function: fixtures drive it, no git required.
 *
 * @param {string} raw
 * @returns {Array<{ file: string|null, oldPath: string|null, newPath: string|null, hunks: Array<object>, additions: number, deletions: number, isNew: boolean, isDeleted: boolean, isBinary: boolean, isRename: boolean, isCopy: boolean, renameFrom: string|null, renameTo: string|null }>}
 */
export function parseDiff(raw) {
  /** @type {any[]} */
  const files = [];
  /** @type {any} */
  let cur = null;
  /** @type {any} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  const flush = () => {
    if (!cur) return;
    cur.file = cur.newPath || cur.renameTo || cur.oldPath || cur.renameFrom;
    files.push(cur);
    cur = null;
    hunk = null;
  };

  for (const line of String(raw ?? "").split("\n")) {
    // An empty string is always the split artifact of a trailing newline: git
    // prefixes a real empty context line with a single space, never nothing.
    if (line === "") continue;

    if (line.startsWith("diff --git ")) {
      flush();
      const { oldPath, newPath } = pathsFromGitHeader(line);
      cur = {
        header: line,
        oldPath,
        newPath,
        file: null,
        hunks: [],
        additions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isBinary: false,
        isRename: false,
        isCopy: false,
        renameFrom: null,
        renameTo: null,
      };
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("new file mode")) { cur.isNew = true; continue; }
    if (line.startsWith("deleted file mode")) { cur.isDeleted = true; continue; }
    if (line.startsWith("similarity index") || line.startsWith("dissimilarity index")) continue;
    if (line.startsWith("rename from ")) { cur.isRename = true; cur.renameFrom = line.slice("rename from ".length); continue; }
    if (line.startsWith("rename to ")) { cur.isRename = true; cur.renameTo = line.slice("rename to ".length); continue; }
    if (line.startsWith("copy from ")) { cur.isCopy = true; cur.renameFrom = line.slice("copy from ".length); continue; }
    if (line.startsWith("copy to ")) { cur.isCopy = true; cur.renameTo = line.slice("copy to ".length); continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { cur.isBinary = true; continue; }
    if (line.startsWith("index ")) continue;

    if (line.startsWith("--- ")) { cur.oldPath = stripPathPrefix(line.slice(4)); continue; }
    if (line.startsWith("+++ ")) { cur.newPath = stripPathPrefix(line.slice(4)); continue; }

    if (line.startsWith("@@")) {
      const h = parseHunkHeader(line);
      if (!h) { hunk = null; continue; }
      hunk = { ...h, header: line, lines: [] };
      cur.hunks.push(hunk);
      oldLine = h.oldStart;
      newLine = h.newStart;
      continue;
    }

    if (!hunk) continue;

    const marker = line[0];
    if (marker === "+") {
      hunk.lines.push({ type: "add", content: line.slice(1), oldLine: null, newLine: newLine++ });
      cur.additions += 1;
    } else if (marker === "-") {
      hunk.lines.push({ type: "delete", content: line.slice(1), oldLine: oldLine++, newLine: null });
      cur.deletions += 1;
    } else if (marker === " ") {
      hunk.lines.push({ type: "context", content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (marker === "\\") {
      hunk.lines.push({ type: "no-newline", content: line.slice(1).trim(), oldLine: null, newLine: null });
    } else {
      // Unrecognised marker: keep the content as context so nothing is dropped,
      // rather than desyncing the hunk.
      hunk.lines.push({ type: "context", content: line, oldLine: oldLine++, newLine: newLine++ });
    }
  }

  flush();
  return files;
}

function baseArgs(opts) {
  const args = ["diff", "--no-color"];
  if (opts.staged) args.push("--cached");
  if (typeof opts.ref === "string" && opts.ref) args.push(opts.ref);
  return args;
}

/**
 * Run `git diff` and parse the result.
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {{ staged?: boolean, ref?: string, paths?: string[], contextLines?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error: string|null, files: Array<object>, raw: string }>}
 */
export async function runDiff(ctx, opts = {}) {
  const args = baseArgs(opts);
  if (Number.isInteger(opts.contextLines)) args.push(`-U${opts.contextLines}`);
  args.push("--");

  if (opts.paths && opts.paths.length) {
    const v = validatePaths(ctx.root, opts.paths);
    if (!v.ok) return { ok: false, error: `invalid path(s): ${v.errors.join("; ")}`, files: [], raw: "" };
    args.push(...v.paths);
  }

  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, error: res.error, files: [], raw: "" };
  return { ok: true, error: null, files: parseDiff(res.stdout), raw: res.stdout };
}

/**
 * Per-file additions/deletions via `git diff --numstat` (the machine-readable
 * form of `--stat`, per git's own guidance to prefer structured output).
 *
 * @param {import("./discover.js").GitContext} ctx
 * @param {{ staged?: boolean, ref?: string, paths?: string[] }} [opts]
 * @returns {Promise<{ ok: boolean, error: string|null, files: Array<{ file: string, additions: number|null, deletions: number|null, binary: boolean }> }>}
 */
export async function diffStat(ctx, opts = {}) {
  const args = ["diff", "--numstat"];
  if (opts.staged) args.push("--cached");
  if (typeof opts.ref === "string" && opts.ref) args.push(opts.ref);
  args.push("--");
  if (opts.paths && opts.paths.length) {
    const v = validatePaths(ctx.root, opts.paths);
    if (!v.ok) return { ok: false, error: `invalid path(s): ${v.errors.join("; ")}`, files: [] };
    args.push(...v.paths);
  }
  const res = await ctx.run(args);
  if (!res.ok) return { ok: false, error: res.error, files: [] };

  const files = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    // "<add>\t<del>\t<path>"; binary files show "-" for both counts.
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === "-";
    files.push({
      file: m[3],
      additions: binary ? null : Number(m[1]),
      deletions: binary ? null : Number(m[2]),
      binary,
    });
  }
  return { ok: true, error: null, files };
}

export default { parseDiff, runDiff, diffStat };
