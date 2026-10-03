// Terminal output helpers.
//
// Single place for colour, symbols, and layout so `--no-color`, `--json`, and
// non-TTY environments behave consistently everywhere.

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === "1");

let colorEnabled = useColor;

export function setColor(on) {
  colorEnabled = Boolean(on) && useColor;
}

export function isColorEnabled() {
  return colorEnabled;
}

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
};

export function paint(text, ...styles) {
  if (!colorEnabled) return String(text);
  const codes = styles
    .map((s) => CODES[s])
    .filter((c) => c !== undefined)
    .join(";");
  if (!codes) return String(text);
  return `\u001b[${codes}m${text}\u001b[0m`;
}

export const bold = (t) => paint(t, "bold");
export const dim = (t) => paint(t, "dim");
export const red = (t) => paint(t, "red");
export const green = (t) => paint(t, "green");
export const yellow = (t) => paint(t, "yellow");
export const cyan = (t) => paint(t, "cyan");
export const gray = (t) => paint(t, "gray");

/** Visible width of a string, ignoring ANSI escapes. */
export function width(str) {
  return String(str).replace(/\u001b\[[0-9;]*m/g, "").length;
}

export function pad(str, target, align = "left") {
  const w = width(str);
  if (w >= target) return str;
  const fill = " ".repeat(target - w);
  return align === "right" ? fill + str : str + fill;
}

/** Truncate to `max` visible chars, preserving colour escapes roughly. */
export function truncate(str, max) {
  const plain = String(str).replace(/\u001b\[[0-9;]*m/g, "");
  if (plain.length <= max) return str;
  if (max <= 1) return plain.slice(0, Math.max(0, max));
  return `${plain.slice(0, max - 1)}\u2026`;
}

const SYMBOLS = {
  ok: "\u2713",
  fail: "\u2717",
  warn: "!",
  pending: "\u00b7",
  arrow: "\u2192",
};

export function symbol(kind) {
  if (!colorEnabled) return { ok: "+", fail: "x", warn: "!", pending: ".", arrow: "->" }[kind] || "?";
  return SYMBOLS[kind] || "?";
}

/** Colour a status word consistently across every command. */
export function statusColor(status) {
  switch (status) {
    case "ok":
    case "reachable":
      return green(status);
    case "error":
    case "unreachable":
      return red(status);
    case "warn":
    case "degraded":
      return yellow(status);
    case "unconfigured":
      return gray(status);
    default:
      return dim(status);
  }
}

/**
 * Render a table. Columns: [{ key, label, align, max }].
 * Rows are plain objects; unknown keys render as empty.
 */
export function table(rows, columns) {
  if (!rows.length) return "";
  const cells = rows.map((r) =>
    columns.map((c) => {
      const v = r[c.key] === undefined || r[c.key] === null ? "" : String(r[c.key]);
      return c.max ? truncate(v, c.max) : v;
    })
  );
  const widths = columns.map((c, i) =>
    Math.max(width(c.label), ...cells.map((row) => width(row[i])))
  );
  const header = columns
    .map((c, i) => bold(pad(c.label, widths[i], c.align)))
    .join("  ");
  const sep = gray(widths.map((w) => "\u2500".repeat(w)).join("  "));
  const body = cells.map((row) =>
    row.map((cell, i) => pad(cell, widths[i], columns[i].align)).join("  ")
  );

  // Rows whose columns are all blank labels are really key/value pairs; a
  // header and rule over them is noise. Only draw the header when at least one
  // column has a label.
  const labelled = columns.some((c) => c.label && String(c.label).trim());
  return labelled ? [header, sep, ...body].join("\n") : body.join("\n");
}

export function heading(text) {
  return `\n${bold(text)}\n`;
}

export default { paint, bold, dim, red, green, yellow, cyan, gray, table, heading, symbol, statusColor, pad, truncate, setColor, isColorEnabled };