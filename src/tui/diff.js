// Terminal diff engine and renderers.
//
// A pure data layer over two blocks of text: an LCS line diff, hunks grouped
// with context, and renderers that turn those into coloured unified or split
// output. Nothing here touches the terminal, reads global state beyond the
// colour flag owned by src/cli/ui.js, or depends on anything outside Node's
// standard library.
//
// Colour is applied *after* layout: a line is measured and truncated using its
// plain text, then wrapped in an SGR sequence. That order matters because
// ui.js's `truncate` drops escapes entirely -- truncating an already-coloured
// line would silently strip its colour, so we never do it.

import { isColorEnabled, paint, width, truncate, pad } from "../cli/ui.js";

/** Context lines shown around each change in a unified diff. */
export const DEFAULT_CONTEXT = 3;

/**
 * A single annotated diff line.
 * @typedef {object} DiffEntry
 * @property {"context"|"add"|"remove"} type
 * @property {string} content
 * @property {number|null} oldLine
 * @property {number|null} newLine
 * @property {number} line
 */

// The LCS table is O(n*m); a pathological pair of 10k-line files would allocate
// four hundred million cells. Above this the engine degrades to a coarse
// whole-middle replacement rather than hanging or exhausting memory. Real
// diffs rarely come close once common prefixes and suffixes are trimmed.
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Split text into lines. An empty string is zero lines, not one, and a single
 * trailing newline does not create a phantom blank final line.
 * @param {string} [text]
 * @returns {string[]}
 */
function splitLines(text) {
  const s = String(text ?? "");
  if (s === "") return [];
  const lines = s.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Longest-path-free character width of the largest line number present. */
function gutterWidth(diff) {
  let max = 0;
  for (const e of diff) {
    if (e.oldLine && e.oldLine > max) max = e.oldLine;
    if (e.newLine && e.newLine > max) max = e.newLine;
  }
  return String(Math.max(1, max)).length;
}

/**
 * LCS over two arrays of lines, emitting context/add/remove entries.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{type:"context"|"add"|"remove", content:string}>}
 */
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  /** @type {Int32Array} */
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * w;
    const next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[row + j] =
        a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  /** @type {Array<{type:"context"|"add"|"remove", content:string}>} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", content: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ type: "remove", content: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", content: b[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ type: "remove", content: a[i++] });
  while (j < m) out.push({ type: "add", content: b[j++] });
  return out;
}

/**
 * Stamp old-file and new-file line numbers onto a diff sequence.
 * @param {Array<{type:"context"|"add"|"remove", content:string}>} seq
 * @param {number} oldStart
 * @param {number} newStart
 * @returns {DiffEntry[]}
 */
function annotate(seq, oldStart, newStart) {
  let o = oldStart;
  let n = newStart;
  return seq.map((e) => {
    /** @type {DiffEntry} */
    let entry;
    if (e.type === "context") {
      entry = { type: "context", content: e.content, oldLine: o, newLine: n, line: n };
      o += 1;
      n += 1;
    } else if (e.type === "remove") {
      entry = { type: "remove", content: e.content, oldLine: o, newLine: null, line: o };
      o += 1;
    } else {
      entry = { type: "add", content: e.content, oldLine: null, newLine: n, line: n };
      n += 1;
    }
    return entry;
  });
}

/**
 * Compute a line-level diff between two strings.
 *
 * Common leading and trailing lines are trimmed before the LCS so ordinary
 * edits stay small; if the remaining middle is too large for a table, it is
 * reported as one remove-block followed by one add-block -- a coarser diff,
 * but still a correct one, and bounded in time and memory.
 *
 * @param {string} [oldText]
 * @param {string} [newText]
 * @param {object} [options]
 * @param {number} [options.maxLines]
 * @returns {DiffEntry[]}
 */
export function computeDiff(oldText, newText, options = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const maxLines = options.maxLines ?? 2000;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  /** @type {Array<{type:"context"|"add"|"remove", content:string}>} */
  let mid;
  if (midA.length === 0) {
    mid = midB.map((t) => ({ type: /** @type {const} */ ("add"), content: t }));
  } else if (midB.length === 0) {
    mid = midA.map((t) => ({ type: /** @type {const} */ ("remove"), content: t }));
  } else if (
    midA.length > maxLines ||
    midB.length > maxLines ||
    midA.length * midB.length > MAX_DIFF_CELLS
  ) {
    mid = [
      ...midA.map((t) => ({ type: /** @type {const} */ ("remove"), content: t })),
      ...midB.map((t) => ({ type: /** @type {const} */ ("add"), content: t })),
    ];
  } else {
    mid = lcsDiff(midA, midB);
  }

  const seq = [
    ...a.slice(0, start).map((t) => ({ type: /** @type {const} */ ("context"), content: t })),
    ...mid,
    ...a.slice(endA).map((t) => ({ type: /** @type {const} */ ("context"), content: t })),
  ];
  return annotate(seq, 1, 1);
}

/**
 * Count additions and deletions in a diff.
 * @param {Array<{type:string}>} [diff]
 * @returns {{additions:number, deletions:number}}
 */
export function diffStats(diff) {
  let additions = 0;
  let deletions = 0;
  for (const e of diff || []) {
    if (e.type === "add") additions += 1;
    else if (e.type === "remove") deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Group changed lines into hunks, each padded with `contextLines` of context
 * and carrying a unified `@@` header. Changes closer together than twice the
 * context are merged into one hunk.
 *
 * @param {Array<object>} diff
 * @param {number} [contextLines]
 * @returns {Array<{oldStart:number, oldCount:number, newStart:number, newCount:number, header:string, lines:Array<object>}>}
 */
export function groupHunks(diff, contextLines = DEFAULT_CONTEXT) {
  const lines = Array.isArray(diff) ? diff : [];
  const ctx = Math.max(0, contextLines);
  /** @type {number[]} */
  const changes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].type !== "context") changes.push(i);
  }
  if (changes.length === 0) return [];

  /** @type {Array<{oldStart:number, oldCount:number, newStart:number, newCount:number, header:string, lines:Array<object>}>} */
  const hunks = [];
  let gStart = Math.max(0, changes[0] - ctx);
  let gEnd = Math.min(lines.length, changes[0] + ctx + 1);
  for (let c = 1; c < changes.length; c += 1) {
    const idx = changes[c];
    if (idx - ctx <= gEnd) {
      gEnd = Math.min(lines.length, idx + ctx + 1);
    } else {
      hunks.push(makeHunk(lines, gStart, gEnd));
      gStart = Math.max(0, idx - ctx);
      gEnd = Math.min(lines.length, idx + ctx + 1);
    }
  }
  hunks.push(makeHunk(lines, gStart, gEnd));
  return hunks;
}

/** Build a single hunk record from a line range. */
function makeHunk(lines, start, end) {
  const slice = lines.slice(start, end);
  let oldStart = null;
  let newStart = null;
  let oldCount = 0;
  let newCount = 0;
  for (const e of slice) {
    if (e.oldLine !== null && e.oldLine !== undefined) {
      if (oldStart === null) oldStart = e.oldLine;
      oldCount += 1;
    }
    if (e.newLine !== null && e.newLine !== undefined) {
      if (newStart === null) newStart = e.newLine;
      newCount += 1;
    }
  }
  // A pure addition has no old lines and a pure removal has no new lines; the
  // header still needs a position, and unified diffs use the boundary line.
  if (oldStart === null) oldStart = 0;
  if (newStart === null) newStart = 0;
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return { oldStart, oldCount, newStart, newCount, header, lines: slice };
}

/**
 * Render one unified-diff body line, truncating plain content to fit `width`
 * before any colour is applied.
 * @param {object} e
 * @param {{gutter:number, width:number, showLineNumbers:boolean}} opts
 * @returns {string}
 */
function renderUnifiedLine(e, opts) {
  const { gutter, showLineNumbers } = opts;
  const sign = e.type === "add" ? "+" : e.type === "remove" ? "-" : " ";
  let prefix = `${sign} `;
  if (showLineNumbers) {
    const o = e.oldLine !== null && e.oldLine !== undefined ? String(e.oldLine) : "";
    const n = e.newLine !== null && e.newLine !== undefined ? String(e.newLine) : "";
    prefix = `${pad(o, gutter, "right")} ${pad(n, gutter, "right")} ${sign} `;
  }
  const avail = opts.width ? Math.max(0, opts.width - width(prefix)) : 0;
  const content = opts.width ? truncate(e.content, avail) : e.content;
  const line = prefix + content;
  // Colour after layout: truncate() strips escapes, so a coloured line must be
  // built plain first and wrapped last.
  if (e.type === "add") return paint(line, "green");
  if (e.type === "remove") return paint(line, "red");
  return paint(line, "dim");
}

/**
 * Render a unified diff for one file.
 *
 * @param {string} filePath
 * @param {Array<object>} diff
 * @param {object} [options]
 * @param {number} [options.contextLines]
 * @param {number} [options.width]           When set, lines are clipped to it.
 * @param {boolean} [options.showLineNumbers]
 * @param {boolean} [options.showHeader]
 * @returns {string}
 */
export function renderUnifiedDiff(filePath, diff, options = {}) {
  const widthOpt = options.width && options.width > 0 ? options.width : 0;
  const showLineNumbers = options.showLineNumbers !== false;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT;
  const entries = Array.isArray(diff) ? diff : [];
  const hunks = groupHunks(entries, contextLines);
  const gutter = gutterWidth(entries);

  /** @type {string[]} */
  const out = [];
  if (options.showHeader !== false && filePath) out.push(paint(filePath, "bold"));
  if (hunks.length === 0) {
    out.push(paint("(no changes)", "dim"));
    return out.join("\n");
  }
  for (const h of hunks) {
    out.push(paint(h.header, "cyan"));
    for (const e of h.lines) {
      out.push(renderUnifiedLine(e, { gutter, width: widthOpt, showLineNumbers }));
    }
  }
  return out.join("\n");
}

/**
 * Parse the output of `git diff` (or `git show`) into per-file diffs.
 *
 * The parser is stateful about "are we inside a hunk yet": before the first
 * `@@` a line beginning with `---` or `+++` is a file header, but once inside a
 * hunk those same prefixes are ordinary content. Conflating the two would turn
 * an added line `+++ important` into a bogus filename.
 *
 * @param {string} [gitOutput]
 * @returns {Array<{path:string, diff:Array<object>, additions:number, deletions:number}>}
 */
export function parseGitDiff(gitOutput) {
  const lines = String(gitOutput ?? "").split(/\r?\n/);
  /** @type {Array<{path:string, diff:Array<any>}>} */
  const files = [];
  /** @type {{path:string, diff:Array<any>}|null} */
  let current = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  const flush = () => {
    if (current) files.push(current);
    current = null;
    inHunk = false;
  };

  for (const line of lines) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      flush();
      const path = fileMatch[2] === "/dev/null" ? fileMatch[1] : fileMatch[2];
      current = { path, diff: [] };
      continue;
    }
    if (!current) continue;

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (!inHunk) {
      // Pre-hunk headers. `+++ b/path` names the file in the new tree; `---`
      // names the old path (a new file shows `/dev/null`).
      if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        if (p !== "/dev/null") current.path = p.replace(/^b\//, "");
      } else if (line.startsWith("--- ")) {
        const p = line.slice(4);
        if (p !== "/dev/null" && current.path === "") current.path = p.replace(/^a\//, "");
      }
      // Everything else before a hunk (index, modes) is metadata we skip.
      continue;
    }

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      current.diff.push({ type: "add", content: line.slice(1), oldLine: null, newLine, line: newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.diff.push({ type: "remove", content: line.slice(1), oldLine, newLine: null, line: oldLine });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.diff.push({ type: "context", content: line.slice(1), oldLine, newLine, line: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  flush();

  return files.map((f) => ({ path: f.path, diff: f.diff, ...diffStats(f.diff) }));
}

/** Clamp `n` into [lo, hi]. */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Reverse-video a segment, or leave it plain when colour is off. */
function highlight(text) {
  return isColorEnabled() ? `\u001b[7m${text}\u001b[0m` : text;
}

/**
 * Pair a hunk's lines into left/right rows for split rendering: a run of
 * removals lines up against the run of additions that replaced it, and context
 * lines occupy both sides.
 * @param {Array<object>} lines
 * @returns {Array<{left:object|null, right:object|null}>}
 */
function splitHunkRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const e = lines[i];
    if (e.type === "context") {
      rows.push({ left: e, right: e });
      i += 1;
      continue;
    }
    /** @type {Array<object>} */
    const removes = [];
    while (i < lines.length && lines[i].type === "remove") {
      removes.push(lines[i]);
      i += 1;
    }
    /** @type {Array<object>} */
    const adds = [];
    while (i < lines.length && lines[i].type === "add") {
      adds.push(lines[i]);
      i += 1;
    }
    const n = Math.max(removes.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      rows.push({ left: removes[k] || null, right: adds[k] || null });
    }
  }
  return rows;
}

/**
 * Render one side of a split-diff row, padded to exactly `colW` visible cells.
 * @param {object|null} e
 * @param {{gutter:number, colW:number, showLineNumbers:boolean, side:"old"|"new"}} opts
 * @returns {string}
 */
function renderSplitCell(e, opts) {
  const { gutter, colW, showLineNumbers, side } = opts;
  if (!e) return " ".repeat(colW);
  const lineNo = side === "old" ? e.oldLine : e.newLine;
  const sign = e.type === "add" ? "+" : e.type === "remove" ? "-" : " ";
  const prefix = showLineNumbers
    ? `${pad(lineNo !== null && lineNo !== undefined ? String(lineNo) : "", gutter, "right")} ${sign} `
    : `${sign} `;
  const avail = Math.max(0, colW - width(prefix));
  const content = truncate(e.content, avail);
  const plain = pad(prefix + content, colW);
  if (e.type === "add") return paint(plain, "green");
  if (e.type === "remove") return paint(plain, "red");
  return paint(plain, "dim");
}

/**
 * Render a two-column split diff for one file.
 *
 * @param {string} filePath
 * @param {Array<object>} diff
 * @param {object} [options]
 * @param {number} [options.width]           Total width; columns split the rest.
 * @param {number} [options.contextLines]
 * @param {boolean} [options.showLineNumbers]
 * @param {boolean} [options.showHeader]
 * @returns {string}
 */
export function renderSplitDiff(filePath, diff, options = {}) {
  const total = options.width && options.width > 0 ? options.width : 100;
  const showLineNumbers = options.showLineNumbers !== false;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT;
  const entries = Array.isArray(diff) ? diff : [];
  const hunks = groupHunks(entries, contextLines);
  const gutter = gutterWidth(entries);

  const sep = paint(" \u2502 ", "gray");
  const sepW = width(sep);
  const colW = Math.max(8, Math.floor((total - sepW) / 2));

  /** @type {string[]} */
  const out = [];
  if (options.showHeader !== false && filePath) out.push(paint(filePath, "bold"));
  if (hunks.length === 0) out.push(paint("(no changes)", "dim"));
  for (const h of hunks) {
    out.push(paint(h.header, "cyan"));
    for (const row of splitHunkRows(h.lines)) {
      const left = renderSplitCell(row.left, { gutter, colW, showLineNumbers, side: "old" });
      const right = renderSplitCell(row.right, { gutter, colW, showLineNumbers, side: "new" });
      out.push(`${left}${sep}${right}`);
    }
  }
  return out.join("\n");
}

/** Normalise viewer input into `{ path, diff }` records. */
function normaliseFileDiffs(input) {
  const arr = Array.isArray(input) ? input : input ? [input] : [];
  return arr.map((f) => {
    const path = f.path || f.file || "(unknown)";
    const diff = Array.isArray(f.diff) ? f.diff : computeDiff(f.oldText, f.newText);
    return { path, diff };
  });
}

/** Take `size` lines starting at `start`, padding past the end with blanks. */
function windowOf(lines, start, size) {
  const out = [];
  for (let i = 0; i < size; i += 1) {
    const idx = start + i;
    out.push(idx >= 0 && idx < lines.length ? lines[idx] : "");
  }
  return out;
}

/** Scroll offset that keeps `index` centred in a window of `size`. */
function windowStart(index, total, size) {
  if (total <= size) return 0;
  return Math.min(Math.max(0, index - Math.floor(size / 2)), total - size);
}

/** File list for the viewer's sidebar, selection highlighted. */
function buildSidebar(files, stats, selectedIndex, w) {
  return files.map((f, i) => {
    const marker = i === selectedIndex ? (isColorEnabled() ? "\u276f " : "> ") : "  ";
    const plain = truncate(`${f.path}  +${stats[i].additions} -${stats[i].deletions}`, Math.max(0, w - 2));
    const padded = pad(marker + plain, w);
    if (i === selectedIndex) return highlight(padded);
    return paint(padded, "gray");
  });
}

/**
 * Compose a full diff viewer frame: a header line, an optional file-tree
 * sidebar, and the windowed body of the selected file. Pure and terminal-free,
 * so the interactive dialog can drive it with nothing but a state object.
 *
 * @param {Array<object>|object} fileDiffs
 * @param {object} [options]
 * @param {"unified"|"split"|"auto"} [options.mode]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.fileIndex]
 * @param {number} [options.scroll]
 * @param {boolean} [options.showTree]
 * @param {number} [options.contextLines]
 * @param {boolean} [options.showLineNumbers]
 * @returns {string}
 */
export function renderDiffViewer(fileDiffs, options = {}) {
  const widthOpt = options.width && options.width > 0 ? options.width : 80;
  const height = options.height && options.height > 0 ? options.height : 24;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT;
  const showLineNumbers = options.showLineNumbers !== false;
  const files = normaliseFileDiffs(fileDiffs);

  if (files.length === 0) return paint("(no file changes)", "dim");

  const idx = clamp(options.fileIndex ?? 0, 0, files.length - 1);
  let mode = options.mode || "unified";
  if (mode === "auto") mode = widthOpt >= 100 ? "split" : "unified";
  const scroll = Math.max(0, options.scroll ?? 0);
  const showTree = options.showTree !== false && files.length > 1;

  const stats = files.map((f) => diffStats(f.diff));
  const file = files[idx];
  const headerText = `${mode}  ${file.path}  (${idx + 1}/${files.length})  +${stats[idx].additions} -${stats[idx].deletions}`;
  const header = paint(pad(truncate(headerText, widthOpt), widthOpt), "bold");
  const bodyHeight = Math.max(1, height - 1);

  const renderOpts = { contextLines, showLineNumbers, showHeader: false };
  const renderBody = (w) =>
    (mode === "split"
      ? renderSplitDiff(file.path, file.diff, { ...renderOpts, width: w })
      : renderUnifiedDiff(file.path, file.diff, { ...renderOpts, width: w })
    ).split("\n");

  if (showTree) {
    const sidebarW = Math.min(40, Math.max(12, Math.floor(widthOpt * 0.28)));
    const mainW = widthOpt - sidebarW - 3;
    if (mainW >= 20) {
      const mainView = windowOf(renderBody(mainW), scroll, bodyHeight);
      const sidebarLines = buildSidebar(files, stats, idx, sidebarW);
      const sidebarView = windowOf(
        sidebarLines,
        windowStart(idx, sidebarLines.length, bodyHeight),
        bodyHeight,
      );
      const sep = paint("\u2502", "gray");
      const rows = [];
      for (let r = 0; r < bodyHeight; r += 1) {
        rows.push(`${pad(sidebarView[r] || "", sidebarW)} ${sep} ${mainView[r] || ""}`);
      }
      return [header, ...rows].join("\n");
    }
  }

  return [header, ...windowOf(renderBody(widthOpt), scroll, bodyHeight)].join("\n");
}

export default {
  DEFAULT_CONTEXT,
  computeDiff,
  diffStats,
  groupHunks,
  renderUnifiedDiff,
  parseGitDiff,
  renderSplitDiff,
  renderDiffViewer,
};