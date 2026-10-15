// Terminal output helpers (src/cli/ui.js): colour, symbols, and layout.
//
// These run under both modes. The no-colour instance is imported once with
// NO_COLOR forced, so its assertions are deterministic whether the test runner
// has a TTY or not; the coloured instance is a second, query-busted import with
// FORCE_COLOR set. Getting this wrong is how a UI test passes on a laptop and
// fails in CI, so the mode is pinned rather than inherited.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const ui = await import("../src/cli/ui.js");

test("width counts visible characters, ignoring ANSI escapes", () => {
  assert.equal(ui.width("plain"), 5);
  assert.equal(ui.width(""), 0);
  assert.equal(ui.width("\u001b[31mred\u001b[0m"), 3, "escape sequences are not visible");
});

test("pad aligns within a target width that accounts for escapes", () => {
  assert.equal(ui.pad("a", 3), "a  ");
  assert.equal(ui.pad("a", 3, "right"), "  a");
  assert.equal(ui.pad("abcd", 2), "abcd", "never shrinks");
  assert.equal(ui.pad("\u001b[31ma\u001b[0m", 2), "\u001b[31ma\u001b[0m ", "one visible char, one pad");
});

test("truncate caps visible length and marks the cut", () => {
  assert.equal(ui.truncate("abcdef", 10), "abcdef", "short strings are untouched");
  assert.equal(ui.truncate("abcdef", 4), "abc\u2026");
  assert.equal(ui.truncate("abcdef", 1), "a", "a single char has no room for an ellipsis");
  assert.equal(ui.truncate("abcdef", 0), "");
  assert.equal(ui.truncate("\u001b[31mabcdef\u001b[0m", 4), "abc\u2026", "escapes are stripped before counting");
});

test("symbols fall back to ASCII when colour is off", () => {
  assert.equal(ui.symbol("ok"), "+");
  assert.equal(ui.symbol("fail"), "x");
  assert.equal(ui.symbol("warn"), "!");
  assert.equal(ui.symbol("pending"), ".");
  assert.equal(ui.symbol("arrow"), "->");
  assert.equal(ui.symbol("nonsense"), "?");
});

test("statusColor renders each status word consistently", () => {
  assert.equal(ui.statusColor("ok"), "ok");
  assert.equal(ui.statusColor("reachable"), "reachable");
  assert.equal(ui.statusColor("error"), "error");
  assert.equal(ui.statusColor("unreachable"), "unreachable");
  assert.equal(ui.statusColor("warn"), "warn");
  assert.equal(ui.statusColor("degraded"), "degraded");
  assert.equal(ui.statusColor("unconfigured"), "unconfigured");
  assert.equal(ui.statusColor("mystery"), "mystery", "unknown statuses still render");
});

test("paint is a no-op when colour is disabled", () => {
  assert.equal(ui.paint("hi", "red"), "hi");
  assert.equal(ui.bold("hi"), "hi");
  assert.equal(ui.paint("hi"), "hi");
  assert.equal(ui.isColorEnabled(), false);
});

test("setColor cannot enable colour when the terminal does not support it", () => {
  ui.setColor(true);
  assert.equal(ui.isColorEnabled(), false, "forced on in a no-colour terminal is still off");
  ui.setColor(false);
});

test("heading wraps the title with surrounding blank lines", () => {
  assert.equal(ui.heading("Title"), "\nTitle\n");
});

test("table draws a header and rule when columns are labelled", () => {
  const rows = [{ name: "a", size: 3 }, { name: "bb", size: 12 }];
  const out = ui.table(rows, [
    { key: "name", label: "Name" },
    { key: "size", label: "Size", align: "right" },
  ]);
  const lines = out.split("\n");
  assert.equal(lines.length, 4, "header, rule, two body rows");
  assert.match(lines[0], /Name/);
  assert.match(lines[0], /Size/);
  assert.match(lines[1], /\u2500/, "the rule is drawn from box-drawing chars");
  assert.match(out, /bb/);
});

test("table omits the header when no column is labelled", () => {
  const out = ui.table([{ k: "Goal", v: "ship it" }], [{ key: "k" }, { key: "v" }]);
  assert.equal(out.split("\n").length, 1, "key/value rows get no header noise");
  assert.doesNotMatch(out, /\u2500/);
});

test("table truncates cells to their column max and treats missing keys as blank", () => {
  const out = ui.table(
    [{ a: "abcdefghij" }, {}],
    [{ key: "a", label: "A", max: 4 }],
  );
  assert.match(out, /abc\u2026/, "the cell is clipped to the column max");
  // The second row's missing key renders as empty but keeps the column width.
  assert.equal(out.split("\n").length, 4, "header, rule, two rows");
});

test("table of no rows is empty", () => {
  assert.equal(ui.table([], [{ key: "a", label: "A" }]), "");
});

test("colour mode wraps text and width still measures the visible part", async () => {
  const savedNoColor = process.env.NO_COLOR;
  const savedForce = process.env.FORCE_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  try {
    // A query-string specifier makes Node re-evaluate the module, so this
    // instance sees FORCE_COLOR. Held in a variable so tsc does not try to
    // resolve the non-literal specifier statically.
    const coloredSpecifier = "../src/cli/ui.js?colored=1";
    const colored = await import(coloredSpecifier);
    assert.equal(colored.isColorEnabled(), true);

    const out = colored.paint("hi", "red");
    assert.equal(out, "\u001b[31mhi\u001b[0m");
    assert.equal(colored.width(out), 2, "escapes do not count toward width");
    assert.equal(colored.paint("hi", "red", "bold"), "\u001b[31;1mhi\u001b[0m", "styles compose in order");
    assert.equal(colored.paint("hi", "notastyle"), "hi", "an unknown style is ignored");
    assert.equal(colored.symbol("ok"), "\u2713", "colour mode uses the real glyphs");
    assert.equal(colored.bold("x"), "\u001b[1mx\u001b[0m");
  } finally {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedForce;
  }
});
