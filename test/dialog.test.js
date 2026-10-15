// Dialog system (src/tui/dialog.js): pure state machines + the stack manager.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const {
  DialogManager,
  alertDialog,
  infoDialog,
  confirmDialog,
  promptDialog,
  selectDialog,
  fuzzyDialog,
} = await import("../src/tui/dialog.js");

const R = { name: "return" };
const ESC = { name: "escape" };
const UP = { name: "up" };
const DOWN = { name: "down" };
const BS = { name: "backspace" };
const LEFT = { name: "left" };

test("manager reports closed and renders nothing with an empty stack", () => {
  const m = new DialogManager();
  assert.equal(m.isOpen, false);
  assert.equal(m.render(), "");
  assert.deepEqual(m.handleKey(null, R), { handled: false, done: false });
});

test("opening pushes and renders over a sized backdrop", () => {
  const m = new DialogManager();
  m.open(alertDialog({ title: "Hi", message: "there" }));
  assert.equal(m.isOpen, true);
  const out = m.render({ cols: 40, rows: 8 });
  assert.equal(out.split("\n").length, 8, "the backdrop fills the screen");
  assert.match(out, /there/);
});

test("a finished dialog is popped and its value surfaced", () => {
  const m = new DialogManager();
  m.open(confirmDialog({ message: "go?" }));
  const res = m.handleKey("y", { name: "y" });
  assert.equal(res.done, true);
  assert.equal(res.value, true);
  assert.equal(m.isOpen, false, "the dialog is closed on completion");
});

test("dialogs stack one at a time and Esc unwinds the top only", () => {
  const m = new DialogManager();
  m.open(alertDialog({ title: "base", message: "base" }));
  m.open(alertDialog({ title: "top", message: "top" }));
  assert.match(m.render({ overlay: false }), /top/);
  assert.doesNotMatch(m.render({ overlay: false }), /base/);
  m.handleKey(null, ESC);
  assert.equal(m.isOpen, true, "the lower dialog remains");
  assert.match(m.render({ overlay: false }), /base/);
});

test("alert finishes on any key", () => {
  const d = alertDialog({ title: "Note", message: "done" });
  assert.equal(d.type, "alert");
  assert.deepEqual(d.handleKey("x", { name: "x" }), { done: true, value: true });
  assert.match(d.render(), /done/);
});

test("info is tagged distinctly but behaves like alert", () => {
  const d = infoDialog({ message: "fyi" });
  assert.equal(d.type, "info");
  assert.equal(d.handleKey(null, R).done, true);
});

test("confirm resolves y/n, Enter default, and Esc fail-closed", () => {
  assert.equal(confirmDialog({ message: "?" }).handleKey("y", { name: "y" }).value, true);
  assert.equal(confirmDialog({ message: "?" }).handleKey("n", { name: "n" }).value, false);
  assert.equal(confirmDialog({ message: "?" }).handleKey(null, R).value, false);
  assert.equal(
    confirmDialog({ message: "?", defaultValue: true }).handleKey(null, R).value,
    true,
    "Enter takes a default-yes",
  );
  assert.equal(confirmDialog({ message: "?" }).handleKey(null, ESC).value, false);
  assert.equal(confirmDialog({ message: "?" }).handleKey("x", { name: "x" }).done, false);
});

test("prompt edits text and commits the buffer", () => {
  const d = promptDialog({ title: "Name", initial: "ab" });
  d.handleKey("c", { name: "c" });
  d.handleKey(null, LEFT);
  d.handleKey("x", { name: "x" });
  assert.equal(d.value, "abxc");
  assert.equal(d.handleKey(null, R).value, "abxc");
});

test("prompt rejects invalid input and cancels to null", () => {
  const d = promptDialog({
    title: "Code",
    validate: (v) => v.length >= 2 || "too short",
  });
  d.handleKey("a", { name: "a" });
  assert.equal(d.handleKey(null, R).done, false, "invalid input does not commit");
  assert.match(d.render(), /too short/);
  d.handleKey("b", { name: "b" });
  assert.equal(d.handleKey(null, R).value, "ab");
  assert.equal(promptDialog({}).handleKey(null, ESC).value, null);
});

test("select navigates, skips disabled, and commits a value", () => {
  const items = [
    { label: "a", value: "A" },
    { label: "b", value: "B", disabled: true },
    { label: "c", value: "C" },
  ];
  const d = selectDialog({ title: "Pick", items });
  d.handleKey(null, DOWN);
  assert.equal(d.index, 2, "the disabled row is skipped");
  assert.equal(d.handleKey(null, R).value, "C");
  assert.equal(selectDialog({ items }).handleKey(null, ESC).value, null);
  assert.match(d.render(), /Pick/);
});

test("fuzzy filters as you type and commits the top match", () => {
  const items = [
    { label: "alpha", value: "A" },
    { label: "gamma", value: "G" },
    { label: "beta", value: "B" },
  ];
  const d = fuzzyDialog({ title: "Model", items });
  d.handleKey("g", { name: "g" });
  d.handleKey("a", { name: "a" });
  assert.equal(d.query, "ga");
  assert.equal(d.handleKey(null, R).value, "G");
});

test("fuzzy backspace widens the result set again", () => {
  const items = [{ label: "alpha", value: "A" }, { label: "beta", value: "B" }];
  const d = fuzzyDialog({ items });
  d.handleKey("b", { name: "b" });
  assert.equal(d.render().includes("alpha"), false, "alpha is filtered out");
  d.handleKey(null, BS);
  assert.match(d.render(), /alpha/, "clearing the query brings it back");
});
