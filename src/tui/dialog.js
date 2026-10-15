// Modal dialog system.
//
// A dialog is a small state machine, not a live terminal session: it exposes
// `render()` (produce the box) and `handleKey(str, key)` (advance the state),
// and returns `{ done, value }` when the user commits or backs out. The
// DialogManager owns a stack of them and knows how to draw the top one over a
// dimmed background. Keeping dialogs pure means every interaction is a table
// of keypresses in a test — no streams, no timers.
//
// Stacking: opening pushes, closing pops, and only the top dialog renders.
// That gives the chat shell a natural "Esc unwinds one layer" behaviour without
// each dialog knowing about the others.
//
// Zero runtime dependencies: composes the ANSI primitives in components.js.

import { drawBox, drawOverlay, drawSelectList, drawInput } from "./components.js";
import { filterFuzzy } from "./interact.js";

const DEFAULT_WIDTH = 60;

/** Move the selection, skipping disabled rows and wrapping. */
function step(items, from, dir) {
  const n = items.length;
  if (n === 0) return 0;
  let i = from;
  for (let guard = 0; guard < n; guard += 1) {
    i = (i + dir + n) % n;
    if (!items[i].disabled) return i;
  }
  return from;
}

function firstEnabled(items) {
  const idx = items.findIndex((it) => !it.disabled);
  return idx === -1 ? 0 : idx;
}

function isCommit(key) {
  return key.name === "return" || key.name === "enter";
}

function isCancel(str, key) {
  return key.name === "escape" || (key.ctrl && key.name === "c");
}

/**
 * Informational dialog dismissed with any key.
 * @param {{title?:string, message?:string, variant?:string, width?:number, borderColor?:string}} [spec]
 */
export function alertDialog(spec = {}) {
  const title = spec.title || "Alert";
  const message = spec.message || "";
  const width = spec.width || DEFAULT_WIDTH;
  return {
    type: spec.variant === "info" ? "info" : "alert",
    title,
    render() {
      return drawBox(title, message, { width, borderColor: spec.borderColor || "cyan" });
    },
    handleKey() {
      return { done: true, value: true };
    },
  };
}

/** Informational dialog — same shape as alert, distinct type for callers. */
export function infoDialog(spec = {}) {
  return { ...alertDialog({ ...spec, variant: "info" }), type: "info" };
}

/**
 * Yes/no dialog.
 * @param {{title?:string, message?:string, defaultValue?:boolean, width?:number}} [spec]
 */
export function confirmDialog(spec = {}) {
  const title = spec.title || "Confirm";
  const message = spec.message || "";
  const width = spec.width || DEFAULT_WIDTH;
  const fallback = spec.defaultValue === true;
  return {
    type: "confirm",
    title,
    defaultValue: fallback,
    render() {
      const hint = fallback ? "Y/n" : "y/N";
      return drawBox(title, `${message}  (${hint})`, { width, borderColor: "yellow" });
    },
    handleKey(str, key) {
      if (isCancel(str, key)) return { done: true, value: fallback };
      if (isCommit(key)) return { done: true, value: fallback };
      const ch = String(str || "").toLowerCase();
      if (ch === "y") return { done: true, value: true };
      if (ch === "n") return { done: true, value: false };
      return { done: false };
    },
  };
}

/**
 * Single-line text prompt.
 * @param {{title?:string, label?:string, initial?:string, validate?:(v:string)=>(boolean|string), width?:number}} [spec]
 */
export function promptDialog(spec = {}) {
  const title = spec.title || "Input";
  const label = spec.label || ">";
  const width = spec.width || DEFAULT_WIDTH;
  let buffer = spec.initial === undefined ? "" : String(spec.initial);
  let cursor = buffer.length;
  let error = "";
  return {
    type: "prompt",
    title,
    get value() {
      return buffer;
    },
    render() {
      const field = drawInput(label, buffer, cursor);
      const body = error ? `${field}\n${error}` : field;
      return drawBox(title, body, { width, borderColor: error ? "red" : "cyan" });
    },
    handleKey(str, key) {
      if (isCancel(str, key)) return { done: true, value: null };
      if (isCommit(key)) {
        const verdict = spec.validate ? spec.validate(buffer) : true;
        if (verdict === true) return { done: true, value: buffer };
        error = typeof verdict === "string" ? verdict : "invalid input";
        return { done: false };
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;
        }
        error = "";
        return { done: false };
      }
      if (key.name === "delete") {
        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        error = "";
        return { done: false };
      }
      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        return { done: false };
      }
      if (key.name === "right") {
        cursor = Math.min(buffer.length, cursor + 1);
        return { done: false };
      }
      if (key.name === "home") {
        cursor = 0;
        return { done: false };
      }
      if (key.name === "end") {
        cursor = buffer.length;
        return { done: false };
      }
      if (str && str.length === 1 && str >= " ") {
        buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
        cursor += str.length;
        error = "";
        return { done: false };
      }
      return { done: false };
    },
  };
}

/**
 * Pick one item from a list.
 * @param {{title?:string, items:Array<object>, initialIndex?:number, max?:number, width?:number, describe?:boolean}} spec
 */
export function selectDialog(spec) {
  const title = spec.title || "Select";
  const items = spec.items || [];
  const width = spec.width || DEFAULT_WIDTH;
  const describe = spec.describe !== false;
  let index = spec.initialIndex === undefined ? firstEnabled(items) : spec.initialIndex;
  if (items[index] && items[index].disabled) index = firstEnabled(items);
  return {
    type: "select",
    title,
    get index() {
      return index;
    },
    render() {
      const body = drawSelectList(items, index, {
        max: spec.max || 10,
        width: width - 4,
        describe,
      });
      return drawBox(title, body, { width, borderColor: "gray" });
    },
    handleKey(str, key) {
      if (isCancel(str, key)) return { done: true, value: null };
      if (key.name === "up" || key.name === "k") {
        index = step(items, index, -1);
        return { done: false };
      }
      if (key.name === "down" || key.name === "j") {
        index = step(items, index, 1);
        return { done: false };
      }
      if (isCommit(key)) {
        const item = items[index];
        if (item && !item.disabled) return { done: true, value: item.value };
      }
      return { done: false };
    },
  };
}

/**
 * Fuzzy picker: type to filter, arrows to move, Enter to choose.
 * @param {{title?:string, prompt?:string, items:Array<object>, max?:number, width?:number}} spec
 */
export function fuzzyDialog(spec) {
  const title = spec.title || "Pick";
  const prompt = spec.prompt || "search";
  const items = spec.items || [];
  const width = spec.width || DEFAULT_WIDTH;
  let query = "";
  let index = 0;
  const reduced = () => filterFuzzy(items, query);
  return {
    type: "fuzzy",
    title,
    get query() {
      return query;
    },
    render() {
      const list = reduced();
      if (index >= list.length) index = Math.max(0, list.length - 1);
      const field = drawInput(prompt, query, query.length);
      const body = drawSelectList(list, index, { max: spec.max || 10, width: width - 4 });
      return drawBox(title, `${field}\n${body}`, { width, borderColor: "gray" });
    },
    handleKey(str, key) {
      if (isCancel(str, key)) return { done: true, value: null };
      if (key.name === "up") {
        index = step(reduced(), index, -1);
        return { done: false };
      }
      if (key.name === "down") {
        index = step(reduced(), index, 1);
        return { done: false };
      }
      if (key.name === "backspace") {
        query = query.slice(0, -1);
        index = 0;
        return { done: false };
      }
      if (isCommit(key)) {
        const item = reduced()[index];
        if (item && !item.disabled) return { done: true, value: item.value };
        return { done: false };
      }
      if (str && str.length === 1 && str >= " ") {
        query += str;
        index = 0;
        return { done: false };
      }
      return { done: false };
    },
  };
}

/**
 * Owns the dialog stack and renders the active dialog over a dimmed backdrop.
 */
export class DialogManager {
  /** @param {{width?:number}} [options] */
  constructor(options = {}) {
    this.stack = [];
    this.width = options.width || DEFAULT_WIDTH;
  }

  get isOpen() {
    return this.stack.length > 0;
  }

  get current() {
    return this.stack.length ? this.stack[this.stack.length - 1] : null;
  }

  /** Push a dialog onto the stack and return it. */
  open(dialog) {
    this.stack.push(dialog);
    return dialog;
  }

  /** Pop the top dialog and return it. */
  close() {
    return this.stack.pop() || null;
  }

  /** Drop every dialog. */
  closeAll() {
    this.stack = [];
  }

  /**
   * Render the top dialog. By default it is centred over a dimmed backdrop;
   * pass `{ overlay: false }` for the raw box (useful inline).
   * @param {{cols?:number, rows?:number, overlay?:boolean, width?:number}} [options]
   */
  render(options = {}) {
    if (!this.isOpen) return "";
    const content = this.current.render({ width: options.width || this.width });
    if (options.overlay === false) return content;
    return drawOverlay(content, { cols: options.cols, rows: options.rows, dim: true });
  }

  /**
   * Route a keypress to the top dialog. When the dialog finishes, it is popped
   * and its value surfaced.
   * @returns {{handled:boolean, done:boolean, value?:any}}
   */
  handleKey(str, key) {
    if (!this.isOpen) return { handled: false, done: false };
    const result = this.current.handleKey(str, key) || { done: false };
    if (result.done) {
      this.close();
      return { handled: true, done: true, value: result.value };
    }
    return { handled: true, done: false };
  }
}

export default {
  DialogManager,
  alertDialog,
  infoDialog,
  confirmDialog,
  promptDialog,
  selectDialog,
  fuzzyDialog,
  DEFAULT_WIDTH,
};
