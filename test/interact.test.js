// Interactive prompt primitives (src/tui/interact.js).
//
// No real terminal: each prompt is driven by a stub stream and synthetic
// keypress events, which is the whole point of the stream-injection contract.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const { selectFromList, textInput, confirm, fuzzyPick, fuzzyMatch, filterFuzzy } = await import(
  "../src/tui/interact.js"
);

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.raw = false;
    this.resumed = false;
  }
  setRawMode(v) {
    this.raw = v;
    return this;
  }
  resume() {
    this.resumed = true;
    return this;
  }
  pause() {
    return this;
  }
}

class FakeOutput {
  constructor() {
    this.isTTY = false;
    this.data = "";
  }
  write(s) {
    this.data += s;
    return true;
  }
}

function press(input, name, extra = {}) {
  input.emit("keypress", extra.str === undefined ? null : extra.str, {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    ...extra,
  });
}

function type(input, text) {
  for (const ch of text) press(input, ch, { str: ch });
}

test("selectFromList resolves the highlighted value on Enter", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const p = selectFromList(
    [
      { label: "a", value: "A" },
      { label: "b", value: "B" },
    ],
    { input, output },
  );
  press(input, "down");
  press(input, "return");
  assert.equal(await p, "B");
  assert.equal(input.raw, false, "raw mode is restored");
});

test("selectFromList skips disabled rows and cancels on Escape", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const p = selectFromList(
    [
      { label: "a", value: "A" },
      { label: "b", value: "B", disabled: true },
      { label: "c", value: "C" },
    ],
    { input, output },
  );
  press(input, "down");
  press(input, "return");
  assert.equal(await p, "C", "the disabled row is skipped");

  const input2 = new FakeInput();
  const p2 = selectFromList([{ label: "a", value: "A" }], { input: input2, output });
  press(input2, "escape");
  assert.equal(await p2, null);
});

test("selectFromList cancels immediately on an empty list", async () => {
  assert.equal(await selectFromList([], { input: new FakeInput(), output: new FakeOutput() }), null);
});

test("textInput accumulates characters and edits the cursor", async () => {
  const input = new FakeInput();
  const p = textInput("name", { input, output: new FakeOutput() });
  type(input, "abc");
  press(input, "left");
  press(input, "backspace");
  press(input, "return");
  assert.equal(await p, "ac");
});

test("textInput rejects invalid input then accepts valid", async () => {
  const input = new FakeInput();
  const p = textInput("code", {
    input,
    output: new FakeOutput(),
    validate: (v) => v.length >= 3 || "too short",
  });
  type(input, "ab");
  press(input, "return");
  type(input, "c");
  press(input, "return");
  assert.equal(await p, "abc");
});

test("textInput cancels with null on Ctrl-C", async () => {
  const input = new FakeInput();
  const p = textInput("name", { input, output: new FakeOutput() });
  press(input, "c", { ctrl: true });
  assert.equal(await p, null);
});

test("confirm resolves y/n and falls back to the default on Enter", async () => {
  const input = new FakeInput();
  const p = confirm("delete?", { input, output: new FakeOutput() });
  press(input, "y", { str: "y" });
  assert.equal(await p, true);

  const input2 = new FakeInput();
  const p2 = confirm("keep?", { input: input2, output: new FakeOutput(), defaultValue: true });
  press(input2, "return");
  assert.equal(await p2, true, "Enter takes the default");

  const input3 = new FakeInput();
  const p3 = confirm("keep?", { input: input3, output: new FakeOutput() });
  press(input3, "escape");
  assert.equal(await p3, false, "cancellation fails closed");
});

test("fuzzyPick filters as you type and selects the match", async () => {
  const input = new FakeInput();
  const p = fuzzyPick(
    [
      { label: "alpha", value: "a" },
      { label: "gamma", value: "g" },
      { label: "beta", value: "b" },
    ],
    { input, output: new FakeOutput() },
  );
  type(input, "ga");
  press(input, "return");
  assert.equal(await p, "g");
});

test("fuzzyMatch scores prefix and contiguous matches higher", () => {
  assert.equal(fuzzyMatch("z", "alpha"), null, "no subsequence means no match");
  const prefix = fuzzyMatch("al", "alpha");
  const middle = fuzzyMatch("ph", "alpha");
  assert.ok(prefix.score > middle.score, "prefix beats interior");
  assert.deepEqual(fuzzyMatch("", "anything").indices, []);
});

test("filterFuzzy ranks matches and preserves order when empty", () => {
  const items = [{ label: "gamma" }, { label: "alpha" }, { label: "beta" }];
  assert.deepEqual(
    filterFuzzy(items, "a").map((i) => i.label),
    ["alpha", "beta", "gamma"],
    "the prefix match ranks first; shorter matches beat longer ones",
  );
  assert.deepEqual(filterFuzzy(items, "").map((i) => i.label), ["gamma", "alpha", "beta"]);
});
