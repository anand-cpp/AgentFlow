// Reusable terminal component library.
//
// Every function here is pure: it takes plain data and returns a string of
// ANSI text. Nothing touches process.stdin/stdout, nothing reads global state
// beyond the colour flag owned by src/cli/ui.js. That keeps the whole layer
// testable without a real terminal and lets the dialog/interaction modules
// compose boxes, lists, and toasts without re-deriving layout maths.
//
// Zero runtime dependencies: box-drawing glyphs and ANSI escapes only.
//
// Colour policy: all colour flows through ui.js, so `NO_COLOR` and
// `TERM=dumb` disable it centrally. When colour is off these functions return
// plain text that still lays out correctly (the select-list highlight, which
// needs reverse video, degrades to a `>` marker).

import { isColorEnabled, paint, width, truncate, pad } from "../cli/ui.js";

const BOX = {
  tl: "\u250c", // ┌
  tr: "\u2510", // ┐
  bl: "\u2514", // └
  br: "\u2518", // ┘
  h: "\u2500", // ─
  v: "\u2502", // │
};

/** Apply a colour style name only when a style was supplied. */
function tint(text, style) {
  return style ? paint(text, style) : text;
}

/** Reverse-video a whole row. Only meaningful when colour is enabled. */
function inverse(text) {
  return isColorEnabled() ? `\u001b[7m${text}\u001b[0m` : text;
}

/** Normalise content into an array of lines. */
function toLines(content) {
  if (Array.isArray(content)) return content.map((l) => String(l));
  return String(content).split("\n");
}

/** Longest visible width across a set of lines. */
function maxWidth(lines) {
  return lines.reduce((max, line) => Math.max(max, width(line)), 0);
}

/**
 * Draw a bordered box around `content`.
 *
 * @param {string} title    Optional title, drawn into the top border.
 * @param {string|string[]} content  Body text; strings may contain newlines.
 * @param {object} [options]
 * @param {number} [options.width]       Total outer width (default: fit content).
 * @param {string} [options.borderColor] ui.js style name for the border.
 * @param {string} [options.titleColor]  ui.js style name for the title.
 * @param {number} [options.padding]     Horizontal padding inside the border.
 * @returns {string}
 */
export function drawBox(title, content, options = {}) {
  const gap = options.padding === undefined ? 1 : Math.max(0, options.padding);
  const lines = toLines(content);
  const natural = maxWidth(lines) + gap * 2 + 2;
  // An explicit width is authoritative: content is clipped to fit it rather
  // than growing the box, so callers can guarantee a dialog fits the screen.
  const outer = options.width ? Math.max(options.width, 4) : Math.max(natural, 4);
  const inner = outer - 2;
  const safeInner = Math.max(0, inner);

  const bc = (s) => tint(s, options.borderColor);
  const tc = (s) => tint(s, options.titleColor);

  const body = [];
  for (const line of lines) {
    const cell = " ".repeat(gap) + line + " ".repeat(gap);
    const fitted = pad(truncate(cell, safeInner), safeInner);
    body.push(bc(BOX.v) + fitted + bc(BOX.v));
  }

  let top;
  if (title && String(title).trim()) {
    const label = ` ${truncate(String(title), Math.max(0, safeInner - 1))} `;
    const filler = Math.max(0, safeInner - 1 - width(label));
    top = bc(BOX.tl) + bc(BOX.h) + tc(label) + bc(BOX.h.repeat(filler)) + bc(BOX.tr);
  } else {
    top = bc(BOX.tl) + bc(BOX.h.repeat(safeInner)) + bc(BOX.tr);
  }
  const bottom = bc(BOX.bl) + bc(BOX.h.repeat(safeInner)) + bc(BOX.br);

  return [top, ...body, bottom].join("\n");
}

/**
 * Centre `content` inside a `cols` x `rows` virtual screen. The areas around
 * the content are filled so the caller can drop this straight into a redraw,
 * and (when colour is on) dimmed to read as an inactive background.
 *
 * @param {string|string[]} content
 * @param {object} [options]
 * @param {number} [options.cols]  Screen width (default 80).
 * @param {number} [options.rows]  Screen height (default 24).
 * @param {boolean} [options.dim]  Dim the background fill (default true).
 * @returns {string}
 */
export function drawOverlay(content, options = {}) {
  const cols = Math.max(1, options.cols || 80);
  const rows = Math.max(1, options.rows || 24);
  const lines = toLines(content);
  const blockWidth = Math.max(...lines.map((l) => width(l)), 0);
  const leftPad = Math.max(0, Math.floor((cols - blockWidth) / 2));
  const topPad = Math.max(0, Math.floor((rows - lines.length) / 2));

  const fill = options.dim === false ? " " : paint(" ", "dim");
  const blank = fill.repeat(cols);
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const contentIndex = r - topPad;
    if (contentIndex >= 0 && contentIndex < lines.length) {
      const right = Math.max(0, cols - leftPad - width(lines[contentIndex]));
      out.push(" ".repeat(leftPad) + lines[contentIndex] + " ".repeat(right));
    } else {
      out.push(blank);
    }
  }
  return out.join("\n");
}

/**
 * Render a selectable list.
 *
 * @param {Array<{label:string,value:any,description?:string,disabled?:boolean}>} items
 * @param {number} selectedIndex
 * @param {object} [options]
 * @param {number} [options.width]      Content width for the highlighted row.
 * @param {number} [options.max]        Max rows to show; the window scrolls.
 * @param {boolean} [options.describe]  Show descriptions (default true).
 * @returns {string}
 */
export function drawSelectList(items, selectedIndex, options = {}) {
  if (!items || items.length === 0) {
    return paint("(no matches)", "dim");
  }
  const describe = options.describe !== false;
  const pointer = isColorEnabled() ? "\u276f" : ">";
  const max = options.max && options.max > 0 ? options.max : items.length;
  const count = Math.min(max, items.length);

  let start = 0;
  if (items.length > count) {
    start = Math.min(
      Math.max(0, selectedIndex - Math.floor(count / 2)),
      items.length - count,
    );
  }

  const rows = [];
  for (let i = start; i < start + count; i += 1) {
    const item = items[i];
    const marker = i === selectedIndex ? `${pointer} ` : "  ";
    let text = item.label;
    if (describe && item.description) text += `  ${item.description}`;
    if (item.disabled) text += "  (unavailable)";

    const target = options.width ? options.width : width(marker) + width(text);
    if (i === selectedIndex) {
      // Highlight the whole row in reverse video. Inner colour is dropped so
      // the reverse SGR is not cancelled by an inner reset.
      const plain = truncate(`${marker}${item.label}${describe && item.description ? `  ${item.description}` : ""}`, target);
      rows.push(inverse(pad(plain, target)));
    } else if (item.disabled) {
      rows.push(pad(paint(marker + text, "dim"), target));
    } else {
      const desc = describe && item.description ? `  ${paint(item.description, "dim")}` : "";
      rows.push(pad(`${marker}${paint(item.label, "cyan")}${desc}`, target));
    }
  }
  return rows.join("\n");
}

/**
 * Render a labelled text input with a cursor.
 *
 * @param {string} label
 * @param {string} value
 * @param {number} cursor   Caret position within `value`.
 * @param {object} [options]
 * @param {number} [options.width] Content width for the field.
 * @returns {string}
 */
export function drawInput(label, value, cursor, options = {}) {
  const text = String(value || "");
  const pos = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, pos);
  const at = text[pos] || " ";
  const after = text.slice(pos + 1);
  const caret = isColorEnabled() ? `\u001b[7m${at}\u001b[0m` : `${at}_`;
  const field = `${before}${caret}${after}`;
  const line = `${paint(label, "bold")} ${field}`;
  return options.width ? paint(pad(line, options.width), "cyan") : line;
}

/**
 * Render a horizontal progress bar.
 *
 * @param {number} percent  0..100.
 * @param {object} [options]
 * @param {number} [options.width]  Bar width in cells (default 30).
 * @param {boolean} [options.showPercent]
 * @param {string} [options.style]  ui.js style for the filled portion.
 * @returns {string}
 */
export function drawProgressBar(percent, options = {}) {
  const w = options.width || 30;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((pct / 100) * w);
  const bar =
    tint("\u2588".repeat(filled), options.style || "green") +
    paint("\u2591".repeat(w - filled), "dim");
  const suffix = options.showPercent === false ? "" : `  ${Math.round(pct)}%`;
  return `[${bar}]${suffix}`;
}

/**
 * Render a status line from coloured segments.
 *
 * @param {Array<{text:string,color?:string,bold?:boolean}>} segments
 * @returns {string}
 */
export function drawStatusLine(segments) {
  return (segments || [])
    .map((seg) => {
      const styles = [];
      if (seg.color) styles.push(seg.color);
      if (seg.bold) styles.push("bold");
      return paint(seg.text, ...styles);
    })
    .join(paint("  \u00b7  ", "dim"));
}

/**
 * Render a toast/notification, right-aligned to the screen.
 *
 * @param {string} message
 * @param {"info"|"success"|"warning"|"error"} [variant]
 * @param {object} [options]
 * @param {number} [options.width]  Screen width to align within (default 80).
 * @returns {string}
 */
export function drawToast(message, variant = "info", options = {}) {
  const styles = { info: "cyan", success: "green", warning: "yellow", error: "red" };
  const title = { info: "i", success: "+", warning: "!", error: "x" }[variant] || "i";
  const box = drawBox(title, message, {
    borderColor: styles[variant] || "cyan",
    titleColor: styles[variant] || "cyan",
    padding: 1,
  });
  const cols = options.width || 80;
  return box
    .split("\n")
    .map((line) => " ".repeat(Math.max(0, cols - width(line))) + line)
    .join("\n");
}

/**
 * Render a table with per-column alignment.
 *
 * @param {string[]} headers
 * @param {Array<Array<string>>} rows
 * @param {object} [options]
 * @param {Array<"left"|"right">} [options.aligns]
 * @param {Array<number>} [options.widths]  Per-column max widths.
 * @returns {string}
 */
export function drawTable(headers, rows, options = {}) {
  const cols = headers.length;
  const aligns = options.aligns || [];
  const limited = options.widths || [];
  const normalise = (row) =>
    Array.from({ length: cols }, (_, i) =>
      row[i] === undefined || row[i] === null ? "" : String(row[i]),
    );

  const body = rows.map(normalise);
  const widths = [];
  for (let c = 0; c < cols; c += 1) {
    let w = width(headers[c]);
    for (const row of body) w = Math.max(w, width(truncate(row[c], limited[c] || Infinity)));
    if (limited[c]) w = Math.min(w, limited[c]);
    widths.push(w);
  }

  const renderRow = (cells, isHeader) =>
    cells
      .map((cell, c) => {
        const clipped = truncate(cell, widths[c]);
        const aligned = pad(clipped, widths[c], aligns[c] === "right" ? "right" : "left");
        return isHeader ? paint(aligned, "bold") : aligned;
      })
      .join("  ");

  const header = renderRow(headers.map((h) => String(h)), true);
  const rule = paint(widths.map((w) => "\u2500".repeat(w)).join("  "), "gray");
  const lines = body.map((row) => renderRow(row, false));
  return [header, rule, ...lines].join("\n");
}

export default {
  drawBox,
  drawOverlay,
  drawSelectList,
  drawInput,
  drawProgressBar,
  drawStatusLine,
  drawToast,
  drawTable,
};
