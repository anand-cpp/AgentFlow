// Terminal UI helpers: width, terminalWidth, and table width capping.
import test from "node:test";
import assert from "node:assert/strict";

import { width, terminalWidth, table } from "../../src/cli/ui.js";

test("width ignores ANSI escapes", () => {
  assert.equal(width("\u001b[31mhello\u001b[0m"), 5);
  assert.equal(width("plain"), 5);
});

test("terminalWidth returns a sane floor", () => {
  const w = terminalWidth();
  assert.ok(Number.isInteger(w));
  assert.ok(w >= 40);
});

test("table caps width to the terminal and trims the detail column", () => {
  const rows = [
    { name: "Groq", status: "ok", detail: "this is a very long piece of detail text that should be trimmed to fit the terminal width" },
    { name: "Gemini", status: "unreachable", detail: "short" },
  ];
  const columns = [
    { key: "name", label: "Provider" },
    { key: "status", label: "Status" },
    { key: "detail", label: "Detail" },
  ];
  const out = table(rows, columns);
  assert.ok(out.includes("Groq"));
  assert.ok(out.includes("Gemini"));
  // Every rendered line must fit within the terminal width.
  const limit = terminalWidth();
  for (const line of out.split("\n")) {
    assert.ok(
      width(line) <= limit,
      `line too long for terminal (${width(line)} > ${limit}): ${line.slice(0, 60)}`
    );
  }
});

test("table handles empty rows gracefully", () => {
  assert.equal(table([], [{ key: "a", label: "A" }]), "");
});
