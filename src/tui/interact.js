// Interactive prompt primitives.
//
// One keypress loop underlies every prompt: select a value, type a line,
// answer yes/no, or fuzzy-search. They share the same stream-injection
// contract as the rest of the TUI layer — pass `{ input, output }` and the
// prompt becomes a pure EventEmitter conversation a test can drive by emitting
// `keypress` events, no real terminal required.
//
// Zero runtime dependencies: node:readline for keypress decoding, ANSI for
// redraw. Raw mode is requested only when the input actually is a TTY, and it
// is always restored on completion — a prompt that exits must never leave the
// user's shell in raw mode.
//
// Cancellation is uniform: Escape or Ctrl-C resolves with `null` (or, for
// `confirm`, the fail-closed default), so callers can treat "user backed out"
// as a single value rather than an exception.

import readline from "node:readline";
import { paint, bold, dim } from "../cli/ui.js";
import { drawSelectList, drawInput } from "./components.js";

/** Greedy subsequence match; higher score = better. Returns null if no match. */
export function fuzzyMatch(query, text) {
  const q = String(query || "").toLowerCase();
  const t = String(text || "").toLowerCase();
  if (!q) return { score: 0, indices: [] };
  let qi = 0;
  const indices = [];
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      qi += 1;
    }
  }
  if (qi < q.length) return null;
  let score = 0;
  if (indices[0] === 0) score += 8;
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] === indices[i - 1] + 1) score += 4;
  }
  score += Math.max(0, 40 - t.length);
  return { score, indices };
}

/**
 * Filter and rank items by a fuzzy query over `key` (default "label").
 *
 * @param {Array<object>} items
 * @param {string} query
 * @param {string} [key]
 * @returns {Array<object>} Items that match, best first (original order when query is empty).
 */
export function filterFuzzy(items, query, key = "label") {
  if (!query) return items.slice();
  const scored = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item[key]);
    if (match) scored.push({ item, score: match.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Attach a keypress handler; returns a cleanup that restores raw mode. */
function attachKeypress(input, onKey) {
  readline.emitKeypressEvents(input);
  const canRaw = Boolean(input.isTTY && typeof input.setRawMode === "function");
  if (canRaw) input.setRawMode(true);
  input.on("keypress", onKey);
  if (typeof input.resume === "function") input.resume();
  return () => {
    input.removeListener("keypress", onKey);
    if (canRaw && typeof input.setRawMode === "function") input.setRawMode(false);
  };
}

/** Minimal incremental redraw: clears the previous block on a TTY. */
function makeRenderer(output) {
  let lastLines = 0;
  const isTTY = Boolean(output.isTTY);
  return {
    draw(text) {
      if (lastLines > 0 && isTTY) output.write(`\u001b[${lastLines}A\u001b[0J`);
      output.write(`${text}\n`);
      lastLines = text.split("\n").length;
    },
    clear() {
      if (lastLines > 0 && isTTY) output.write(`\u001b[${lastLines}A\u001b[0J`);
      lastLines = 0;
    },
  };
}

function firstEnabled(items) {
  const idx = items.findIndex((it) => !it.disabled);
  return idx === -1 ? 0 : idx;
}

function step(items, from, dir) {
  const n = items.length;
  let i = from;
  for (let guard = 0; guard < n; guard += 1) {
    i = (i + dir + n) % n;
    if (!items[i].disabled) return i;
  }
  return from;
}

function isCancel(str, key) {
  return key.name === "escape" || (key.ctrl && key.name === "c");
}

/**
 * Prompt the user to pick one item from a list.
 *
 * @param {Array<{label:string,value:any,description?:string,disabled?:boolean}>} items
 * @param {object} [options]
 * @param {object} [options.input]   Readable (default process.stdin).
 * @param {object} [options.output]  Writable (default process.stdout).
 * @param {number} [options.max]     Rows visible before the window scrolls.
 * @param {number} [options.width]   Highlight width.
 * @param {string} [options.title]   Heading above the list.
 * @param {number} [options.initialIndex]
 * @returns {Promise<any|null>} The selected value, or null if cancelled.
 */
export function selectFromList(items, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  return new Promise((resolve) => {
    if (!items || items.length === 0) {
      resolve(null);
      return;
    }
    let index = options.initialIndex === undefined ? firstEnabled(items) : options.initialIndex;
    if (items[index] && items[index].disabled) index = firstEnabled(items);
    const renderer = makeRenderer(output);
    const render = () => {
      const head = options.title ? `${bold(options.title)}\n` : "";
      renderer.draw(
        head +
          drawSelectList(items, index, {
            max: options.max || 10,
            width: options.width,
          }),
      );
    };
    const finish = (value) => {
      cleanup();
      renderer.clear();
      resolve(value);
    };
    const onKey = (str, key) => {
      if (isCancel(str, key)) return finish(null);
      if (key.name === "up" || key.name === "k") {
        index = step(items, index, -1);
        return render();
      }
      if (key.name === "down" || key.name === "j") {
        index = step(items, index, 1);
        return render();
      }
      if (key.name === "home") {
        index = firstEnabled(items);
        return render();
      }
      if (key.name === "end") {
        index = step(items, 0, -1);
        return render();
      }
      if (key.name === "return") {
        const item = items[index];
        if (item && !item.disabled) finish(item.value);
      }
      return undefined;
    };
    const cleanup = attachKeypress(input, onKey);
    render();
  });
}

/**
 * Prompt for a single line of text.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {object} [options.input]
 * @param {object} [options.output]
 * @param {string} [options.initial]
 * @param {(value:string)=>(boolean|string)} [options.validate]  Return false/string to reject.
 * @param {number} [options.width]
 * @returns {Promise<string|null>}
 */
export function textInput(prompt, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  return new Promise((resolve) => {
    let buffer = options.initial === undefined ? "" : String(options.initial);
    let cursor = buffer.length;
    let error = "";
    const renderer = makeRenderer(output);
    const render = () => {
      let text = drawInput(prompt, buffer, cursor, { width: options.width });
      if (error) text += `\n${paint(error, "red")}`;
      renderer.draw(text);
    };
    const finish = (value) => {
      cleanup();
      renderer.clear();
      resolve(value);
    };
    const onKey = (str, key) => {
      if (isCancel(str, key)) return finish(null);
      if (key.name === "return") {
        const verdict = options.validate ? options.validate(buffer) : true;
        if (verdict === true) return finish(buffer);
        error = typeof verdict === "string" ? verdict : "invalid input";
        return render();
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;
        }
        error = "";
        return render();
      }
      if (key.name === "delete") {
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        error = "";
        return render();
      }
      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        return render();
      }
      if (key.name === "right") {
        cursor = Math.min(buffer.length, cursor + 1);
        return render();
      }
      if (key.name === "home") {
        cursor = 0;
        return render();
      }
      if (key.name === "end") {
        cursor = buffer.length;
        return render();
      }
      if (str && str.length === 1 && str >= " ") {
        buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
        cursor += str.length;
        error = "";
        return render();
      }
      return undefined;
    };
    const cleanup = attachKeypress(input, onKey);
    render();
  });
}

/**
 * Ask a yes/no question.
 *
 * Fail-closed: a cancellation or a bare Enter resolves to `defaultValue`
 * (itself false unless the caller opts into a default-yes).
 *
 * @param {string} message
 * @param {object} [options]
 * @param {object} [options.input]
 * @param {object} [options.output]
 * @param {boolean} [options.defaultValue]
 * @returns {Promise<boolean>}
 */
export function confirm(message, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const fallback = options.defaultValue === true;
  return new Promise((resolve) => {
    const renderer = makeRenderer(output);
    const hint = fallback ? "Y/n" : "y/N";
    const render = () => renderer.draw(`${message} ${dim(`(${hint})`)}`);
    const finish = (value) => {
      cleanup();
      renderer.clear();
      resolve(value);
    };
    const onKey = (str, key) => {
      if (isCancel(str, key)) return finish(fallback);
      if (key.name === "return") return finish(fallback);
      const ch = (str || "").toLowerCase();
      if (ch === "y") return finish(true);
      if (ch === "n") return finish(false);
      return undefined;
    };
    const cleanup = attachKeypress(input, onKey);
    render();
  });
}

/**
 * Fuzzy picker: type to filter, arrows to move, Enter to choose.
 *
 * @param {Array<{label:string,value:any,description?:string,disabled?:boolean}>} items
 * @param {object} [options]
 * @param {object} [options.input]
 * @param {object} [options.output]
 * @param {number} [options.max]
 * @param {number} [options.width]
 * @param {string} [options.title]
 * @param {string} [options.prompt]
 * @returns {Promise<any|null>}
 */
export function fuzzyPick(items, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  return new Promise((resolve) => {
    let query = "";
    let index = 0;
    const renderer = makeRenderer(output);
    const reduced = () => filterFuzzy(items, query);
    const render = () => {
      const list = reduced();
      if (index >= list.length) index = Math.max(0, list.length - 1);
      const head = options.title ? `${bold(options.title)}\n` : "";
      const field = drawInput(options.prompt || "search", query, query.length);
      renderer.draw(`${head}${field}\n${drawSelectList(list, index, { max: options.max || 10, width: options.width })}`);
    };
    const finish = (value) => {
      cleanup();
      renderer.clear();
      resolve(value);
    };
    const onKey = (str, key) => {
      if (isCancel(str, key)) return finish(null);
      if (key.name === "up") {
        const list = reduced();
        index = step(list, index, -1);
        return render();
      }
      if (key.name === "down") {
        const list = reduced();
        index = step(list, index, 1);
        return render();
      }
      if (key.name === "backspace") {
        query = query.slice(0, -1);
        index = 0;
        return render();
      }
      if (key.name === "return") {
        const list = reduced();
        const item = list[index];
        if (item && !item.disabled) finish(item.value);
        return undefined;
      }
      if (str && str.length === 1 && str >= " ") {
        query += str;
        index = 0;
        return render();
      }
      return undefined;
    };
    const cleanup = attachKeypress(input, onKey);
    render();
  });
}

/**
 * Drive a `{ render, handleKey }` dialog to completion.
 *
 * This is the runtime half of the dialog contract in dialog.js: the dialog owns
 * the state machine, this owns the keypress stream, the redraw, and restoring
 * raw mode. Any dialog built for dialog.js (diff viewer, timeline, swarm graph)
 * can be opened with it, and a test can still bypass it entirely by calling the
 * dialog's `handleKey` directly.
 *
 * @param {{render:(o?:object)=>string, handleKey:(s?:string,k?:object)=>{done:boolean,value?:any}}} dialog
 * @param {object} [options]
 * @param {object} [options.input]
 * @param {object} [options.output]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {Promise<any|null>} The dialog's value when it finishes.
 */
export function driveDialog(dialog, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  return new Promise((resolve) => {
    const renderer = makeRenderer(output);
    const render = () => renderer.draw(dialog.render({ width: options.width, height: options.height }));
    const finish = (value) => {
      cleanup();
      renderer.clear();
      resolve(value);
    };
    const onKey = (str, key) => {
      const result = dialog.handleKey(str, key) || { done: false };
      if (result.done) return finish(result.value);
      return render();
    };
    const cleanup = attachKeypress(input, onKey);
    render();
  });
}

export default { selectFromList, textInput, confirm, fuzzyPick, fuzzyMatch, filterFuzzy, driveDialog };
