// TUI component library (src/tui/components.js): pure ANSI string rendering.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const c = await import("../src/tui/components.js");
const ui = await import("../src/cli/ui.js");
ui.setColor(false);

test("drawBox frames content with matching-width borders", () => {
  const box = c.drawBox("Title", "hello", { width: 20 });
  const lines = box.split("\n");
  assert.equal(lines.length, 3, "top, one body line, bottom");
  assert.equal(ui.width(lines[0]), 20);
  assert.equal(ui.width(lines[1]), 20);
  assert.equal(ui.width(lines[2]), 20);
  assert.match(lines[0], /Title/);
  assert.match(lines[1], /hello/);
});

test("drawBox fits multi-line content and truncates overflow", () => {
  const box = c.drawBox("", ["ok", "way too long for this narrow box"], { width: 14 });
  const lines = box.split("\n");
  for (const line of lines) assert.equal(ui.width(line), 14, "every line honours the width");
  assert.match(lines[2], /\u2026/, "overflow is clipped, not wrapped");
});

test("drawBox renders a titleless top border", () => {
  const box = c.drawBox("", "x", { width: 8 });
  assert.equal(box.split("\n")[0], "\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
});

test("drawSelectList marks the selection and dims disabled rows", () => {
  const items = [
    { label: "first", value: 1, description: "one" },
    { label: "second", value: 2, disabled: true },
  ];
  const out = c.drawSelectList(items, 0);
  const lines = out.split("\n");
  assert.match(lines[0], /^> /, "the selected row carries a pointer");
  assert.match(lines[0], /first/);
  assert.match(lines[1], /second/);
  assert.match(lines[1], /\(unavailable\)/);
});

test("drawSelectList windows a long list around the selection", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ label: `item-${i}`, value: i }));
  const out = c.drawSelectList(items, 10, { max: 5 });
  const lines = out.split("\n");
  assert.equal(lines.length, 5, "only the window is shown");
  assert.match(out, /item-10/);
  assert.doesNotMatch(out, /item-0\b/);
});

test("drawSelectList says so when there are no matches", () => {
  assert.equal(c.drawSelectList([], 0), "(no matches)");
});

test("drawInput shows the label, value, and a caret", () => {
  const out = c.drawInput("name", "abc", 1);
  assert.match(out, /name/);
  assert.match(out, /ab_c/, "the caret sits on the character under the cursor");
});

test("drawProgressBar fills proportionally and clamps its input", () => {
  assert.match(c.drawProgressBar(0, { width: 10 }), /^\[░{10}\]\s+0%/);
  assert.match(c.drawProgressBar(50, { width: 10 }), /^\[█{5}░{5}\]\s+50%/);
  assert.match(c.drawProgressBar(100, { width: 10 }), /^\[█{10}\]\s+100%/);
  assert.match(c.drawProgressBar(999, { width: 10 }), /100%/, "out-of-range input clamps");
  assert.doesNotMatch(c.drawProgressBar(50, { width: 10, showPercent: false }), /%/);
});

test("drawStatusLine colours each segment and joins with a separator", () => {
  const out = c.drawStatusLine([
    { text: "model", bold: true },
    { text: "ready", color: "green" },
  ]);
  assert.match(out, /model/);
  assert.match(out, /ready/);
  assert.match(out, /\u00b7/);
});

test("drawToast right-aligns within the screen width", () => {
  const toast = c.drawToast("saved", "success", { width: 30 });
  for (const line of toast.split("\n")) {
    assert.ok(ui.width(line) <= 30, "never exceeds the screen");
  }
  assert.match(toast, /saved/);
});

test("drawTable aligns columns and rules under the header", () => {
  const out = c.drawTable(["Name", "N"], [["a", "3"], ["bb", "12"]], { aligns: ["left", "right"] });
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[1], /\u2500/);
  assert.match(lines[2], /a\s+3$/);
  assert.match(lines[3], /bb\s+12$/);
});

test("drawOverlay centres content in the virtual screen", () => {
  const out = c.drawOverlay("X", { cols: 5, rows: 3, dim: false });
  const lines = out.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "  X  ");
  assert.equal(ui.width(lines[0]), 5);
});
