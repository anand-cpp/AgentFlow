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

import { drawOverlay } from "./components.js";

const DEFAULT_WIDTH = 60;

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

export default { DialogManager, DEFAULT_WIDTH };
