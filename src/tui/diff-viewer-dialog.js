// Interactive diff viewer overlay.
//
// A stateful front end over the pure renderers in ./diff.js: it keeps a cursor
// over files and hunks, a scroll offset, and a mode toggle, then hands the
// current state to renderDiffViewer to draw. Like every dialog in this layer it
// exposes only `render()` and `handleKey(str, key)` -- no streams, no timers --
// so the whole interaction is a table of keypresses in a test.
//
// Keys:
//   Up/Down (or j/k)   scroll one line
//   PageUp/PageDown    scroll a screen
//   Home / End         top / bottom
//   n / p              next / previous file
//   ] / [              next / previous hunk
//   Tab                toggle unified <-> split
//   b                  toggle the file-tree sidebar
//   q / Esc / Ctrl-C   close
//
// Zero runtime dependencies.

import { renderDiffViewer, renderUnifiedDiff, renderSplitDiff, DEFAULT_CONTEXT } from "./diff.js";
import { paint } from "../cli/ui.js";

/** Remove SGR colour sequences so structural tests on line text work. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- matching ANSI ESC CSI sequences is the point
  return String(s).replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Build a diff-viewer dialog.
 *
 * @param {Array<object>|object} fileDiffs  `{path,diff}` or `{path,oldText,newText}`
 * @param {object} [options]
 * @param {"unified"|"split"|"auto"} [options.mode]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {boolean} [options.showTree]
 * @param {number} [options.contextLines]
 * @param {boolean} [options.showLineNumbers]
 * @param {number} [options.fileIndex]
 * @returns {{type:string, state:object, render:(o?:object)=>string, handleKey:(s?:string,k?:object)=>{done:boolean,value?:any}}}
 */
export function diffViewerDialog(fileDiffs, options = {}) {
  const files = (Array.isArray(fileDiffs) ? fileDiffs : fileDiffs ? [fileDiffs] : []).map((f) => {
    const path = f.path || f.file || "(unknown)";
    const diff = Array.isArray(f.diff) ? f.diff : [];
    return { path, diff };
  });

  const state = {
    files,
    fileIndex: Math.max(0, Math.min(options.fileIndex ?? 0, Math.max(0, files.length - 1))),
    scroll: 0,
    mode: options.mode || "unified",
    showTree: options.showTree !== false,
    width: options.width || 80,
    height: options.height || 24,
    contextLines: options.contextLines ?? DEFAULT_CONTEXT,
    showLineNumbers: options.showLineNumbers !== false,
  };

  /** The width the file body is actually rendered at (sidebar accounting). */
  function contentWidth() {
    if (state.showTree && files.length > 1) {
      const sidebarW = Math.min(40, Math.max(12, Math.floor(state.width * 0.28)));
      const mainW = state.width - sidebarW - 3;
      if (mainW >= 20) return mainW;
    }
    return state.width;
  }

  function bodyHeight() {
    return Math.max(1, state.height - 1); // minus the header line
  }

  /** Rendered body lines for a file in the current mode. */
  function bodyFor(fIndex) {
    const f = files[fIndex];
    if (!f) return [];
    const opts = {
      width: contentWidth(),
      contextLines: state.contextLines,
      showLineNumbers: state.showLineNumbers,
      showHeader: false,
    };
    const rendered =
      state.mode === "split"
        ? renderSplitDiff(f.path, f.diff, opts)
        : renderUnifiedDiff(f.path, f.diff, opts);
    return rendered.split("\n");
  }

  /** Rendered-line indexes where a `@@` hunk header appears. */
  function hunkStarts(fIndex) {
    const lines = bodyFor(fIndex);
    const starts = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (stripAnsi(lines[i]).startsWith("@@")) starts.push(i);
    }
    return starts;
  }

  function maxScroll(fIndex) {
    return Math.max(0, bodyFor(fIndex).length - bodyHeight());
  }

  function clampScroll() {
    state.scroll = Math.max(0, Math.min(state.scroll, maxScroll(state.fileIndex)));
  }

  function scrollBy(delta) {
    state.scroll += delta;
    clampScroll();
  }

  function fileStep(dir) {
    const n = files.length;
    if (n === 0) return;
    state.fileIndex = (state.fileIndex + dir + n) % n;
    const starts = hunkStarts(state.fileIndex);
    state.scroll = starts.length ? starts[0] : 0;
    clampScroll();
  }

  function hunkMove(dir) {
    const starts = hunkStarts(state.fileIndex);
    if (starts.length === 0) return;
    let cursor = 0;
    for (let i = 0; i < starts.length; i += 1) {
      if (starts[i] <= state.scroll) cursor = i;
    }
    cursor = Math.max(0, Math.min(starts.length - 1, cursor + dir));
    state.scroll = starts[cursor];
    clampScroll();
  }

  const HINT = "[\u2191\u2193]scroll [n/p]file [/]hunk [Tab]split [b]tree [q]close";

  return {
    type: "diff",
    state,
    render(opts = {}) {
      if (opts.width && opts.width > 0) state.width = opts.width;
      if (opts.height && opts.height > 0) state.height = opts.height;
      const frame = renderDiffViewer(files, {
        mode: state.mode,
        width: state.width,
        height: state.height,
        fileIndex: state.fileIndex,
        scroll: state.scroll,
        showTree: state.showTree,
        contextLines: state.contextLines,
        showLineNumbers: state.showLineNumbers,
      });
      return `${frame}\n${paint(HINT, "dim")}`;
    },
    handleKey(str, key) {
      const k = key || {};
      const ch = String(str || "");
      const lower = ch.toLowerCase();

      if (k.name === "escape" || (k.ctrl && k.name === "c") || lower === "q") {
        return { done: true, value: null };
      }
      if (k.name === "up" || (k.ctrl && k.name === "p") || lower === "k") {
        scrollBy(-1);
        return { done: false };
      }
      if (k.name === "down" || (k.ctrl && k.name === "n") || lower === "j") {
        scrollBy(1);
        return { done: false };
      }
      if (k.name === "pageup") {
        scrollBy(-bodyHeight());
        return { done: false };
      }
      if (k.name === "pagedown") {
        scrollBy(bodyHeight());
        return { done: false };
      }
      if (k.name === "home") {
        state.scroll = 0;
        return { done: false };
      }
      if (k.name === "end") {
        state.scroll = maxScroll(state.fileIndex);
        return { done: false };
      }
      if (lower === "n") {
        fileStep(1);
        return { done: false };
      }
      if (lower === "p") {
        fileStep(-1);
        return { done: false };
      }
      if (ch === "]") {
        hunkMove(1);
        return { done: false };
      }
      if (ch === "[") {
        hunkMove(-1);
        return { done: false };
      }
      if (k.name === "tab" || ch === "\t") {
        state.mode = state.mode === "split" ? "unified" : "split";
        return { done: false };
      }
      if (lower === "b") {
        state.showTree = !state.showTree;
        return { done: false };
      }
      return { done: false };
    },
  };
}

export default { diffViewerDialog };
