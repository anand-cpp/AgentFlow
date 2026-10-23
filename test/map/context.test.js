// Context packer tests: budget enforcement is the headline invariant, then
// focus/query boosts, symbol truncation, and degradation on odd maps.
import test from "node:test";
import assert from "node:assert/strict";

import {
  formatRepoMapForPrompt,
  estimateTokens,
  queryMatches,
} from "../../src/core/map/context.js";
import { buildMap } from "../../src/core/map/build.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-ctx-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const UTIL = "export function util() { return 1; }\n";
const MID = 'import { util } from "./util.js";\nexport function mid() { return util(); }\n';

function makeMap(t) {
  const root = repo(t, {
    "src/util.js": UTIL,
    "src/mid.js": MID,
    "src/top.js": 'import { mid } from "./mid.js";\nexport function top() { return mid(); }\n',
  });
  return buildMap(root);
}

test("estimateTokens is a conservative chars/4", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("the block fits the budget for every budget size", (t) => {
  const map = makeMap(t);
  // A wide sweep: nothing may ever exceed its budget.
  for (const budget of [24, 64, 128, 500, 2000]) {
    const text = formatRepoMapForPrompt(map, { maxTokens: budget });
    assert.ok(estimateTokens(text) <= budget, `budget ${budget}: used ${estimateTokens(text)}`);
  }
});

test("formatting includes the header, symbols, and reference counts", (t) => {
  const map = makeMap(t);
  const text = formatRepoMapForPrompt(map, { maxTokens: 2000 });
  assert.ok(text.startsWith("## Repository map"), "header first");
  assert.ok(text.includes("src/util.js"), "the ranked file list names files");
  assert.ok(text.includes("util"), "symbol names are shown");
  assert.ok(text.includes("referenced by 1"), "inbound counts surface");
  assert.ok(!text.includes("return 1;"), "never dumps file contents");
});

test("small budgets truncate and say so", (t) => {
  // Ten files with long enough lines that a 120-token budget cannot hold all
  // of them; the packer must cut, and the cut must be announced.
  const files = {};
  for (let i = 0; i < 10; i += 1) {
    files[`src/components/controls/buttons/padded/f${i}.js`] = `export const symbolNumber${i} = ${i};\n`;
  }
  const map = buildMap(repo(t, files));
  const text = formatRepoMapForPrompt(map, { maxTokens: 120 });
  const lines = text.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.length > 0 && lines.length < 10, `some but not all files: ${lines.length}`);
  assert.ok(/truncated: \d+ of 10 files/.test(text), `the cut is announced: ${text}`);
  assert.ok(estimateTokens(text) <= 120, `budget respected: ${estimateTokens(text)}`);
});

test("budget smaller than the header still yields a valid block", (t) => {
  const map = makeMap(t);
  const text = formatRepoMapForPrompt(map, { maxTokens: 24 });
  assert.ok(text.includes("## Repository map"));
  assert.ok(estimateTokens(text) <= 24, `tiny budget is still a budget: ${estimateTokens(text)}`);
});

test("focusFiles are starred and boosted to the top", (t) => {
  const map = makeMap(t);
  const text = formatRepoMapForPrompt(map, { maxTokens: 2000, focusFiles: ["src/top.js"] });
  const topIdx = text.indexOf("src/top.js");
  const utilIdx = text.indexOf("src/util.js");
  assert.ok(topIdx > -1 && utilIdx > -1);
  assert.ok(topIdx < utilIdx || text.includes("src/top.js ★"), "focused file surfaces high");
  assert.ok(/\btop\.js ★/.test(text), "the focus star is rendered");
});

test("query keywords boost matching files", (t) => {
  const map = makeMap(t);
  const boosted = formatRepoMapForPrompt(map, { maxTokens: 2000, query: "mid dispatch" });
  const boostedIdx = boosted.indexOf("src/mid.js");
  const plainIdx = boosted.indexOf("src/util.js");
  assert.ok(boostedIdx > -1 && boostedIdx < plainIdx, "the memory keyword lifts mid.js above util.js");
});

test("queryMatches is word-prefixed and case-insensitive", () => {
  assert.equal(queryMatches("src/chat/ui.js", [{ name: "ChatBox" }], "chat"), 1);
  assert.equal(queryMatches("a.js", [], "at"), 0, "sub-3-letter queries never match");
  assert.equal(queryMatches("a.js", [{ name: "runAgent" }], "agent"), 1);
  assert.equal(queryMatches("a.js", [], ""), 0);
});

test("maxSymbolsPerFile caps and reports the remainder", () => {
  const map = buildSnapshotWithSymbols();
  const text = formatRepoMapForPrompt(map, { maxTokens: 2000, maxSymbolsPerFile: 2 });
  assert.ok(text.includes("+3 more"), `remaining symbols summarised: ${text}`);
});

test("maps without units or scores still format", () => {
  const bare = { files: [{ rel: "x.js", size: 10, mtimeMs: 1 }], scores: [], units: [] };
  const text = formatRepoMapForPrompt(bare, { maxTokens: 200 });
  assert.ok(text.includes("x.js"));
  const emptier = { files: [], scores: [], units: [] };
  assert.ok(formatRepoMapForPrompt(emptier).includes("## Repository map"));
});

function buildSnapshotWithSymbols() {
  const symbols = [];
  for (let i = 0; i < 5; i += 1) symbols.push({ name: `fn${i}`, kind: "function", line: i + 1, exported: true });
  return {
    files: [{ rel: "big.js", size: 100, mtimeMs: 1 }],
    scores: [{ id: "big.js", score: 0.5 }],
    units: [{ file: "big.js", symbols, imports: [] }],
  };
}
