// File picker (src/tui/file-picker.js): gitignore parsing, workspace walking,
// filtering, and rendering. Uses a throwaway fixture tree so the walk is real.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const {
  compileGitignore,
  isIgnored,
  listWorkspaceFiles,
  renderFilePicker,
  buildFileItems,
  pickFile,
} = await import("../src/tui/file-picker.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afpick-"));
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n*.log\n/dist\nsecret.txt\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.js"), "a\nb\nc\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "x.js"), "x\n");
  fs.writeFileSync(path.join(root, "build.log"), "log\n");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "out.js"), "o\n");
  return root;
}

test("compileGitignore parses comments, negation, and dir-only rules", () => {
  const rules = compileGitignore("# comment\nnode_modules/\n*.log\n!keep.log\n");
  assert.equal(rules.length, 3, "comments are dropped");
  assert.equal(rules[0].dirOnly, true);
  assert.equal(rules[1].dirOnly, false);
  assert.equal(rules[2].neg, true);
});

test("isIgnored honours negation and dir-only matching", () => {
  const rules = compileGitignore("build/\n*.tmp\n!keep.tmp\n");
  assert.equal(isIgnored("build", true, rules), true);
  assert.equal(isIgnored("build", false, rules), false, "dir-only rule skips a same-named file");
  assert.equal(isIgnored("a.tmp", false, rules), true);
  assert.equal(isIgnored("keep.tmp", false, rules), false, "negation re-includes");
});

test("the walk skips ignored dirs and node_modules", () => {
  const root = fixture();
  try {
    const entries = listWorkspaceFiles(root);
    const rels = entries.map((e) => e.rel);
    assert.ok(rels.includes("src"), "source is listed");
    assert.ok(!rels.some((r) => r.includes("node_modules")), "node_modules is skipped");
    assert.ok(!rels.some((r) => r.includes("build.log")), "*.log is ignored");
    assert.ok(!rels.some((r) => r.startsWith("dist/")), "the /dist dir is ignored");
    const srcIndex = entries.find((e) => e.rel === "src/index.js");
    assert.equal(srcIndex.kind, "file");
    assert.equal(srcIndex.lines, 3, "line counts are read");
    const srcDir = entries.find((e) => e.rel === "src");
    assert.equal(srcDir.kind, "dir");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the walk can ignore .gitignore entirely when asked", () => {
  const root = fixture();
  try {
    const rels = listWorkspaceFiles(root, { gitignore: false }).map((e) => e.rel);
    assert.ok(rels.some((r) => r.startsWith("dist/")), "dist is visible without gitignore");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildFileItems filters by path and marks added files", () => {
  const entries = [
    { rel: "src/index.js", kind: "file", lines: 3 },
    { rel: "README.md", kind: "file", lines: 1 },
  ];
  const all = buildFileItems(entries, { added: new Set(["README.md"]) });
  assert.match(all.find((i) => i.value === "README.md").label, /^✓ /, "added files carry a checkmark");
  const filtered = buildFileItems(entries, { query: "index" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].value, "src/index.js");
});

test("rendering shows a titled box and respects the width", () => {
  const items = buildFileItems([{ rel: "a.js", kind: "file", lines: 2 }], {});
  const out = renderFilePicker({ items, selected: 0, query: "" }, 60);
  assert.match(out, /@file/);
  for (const line of out.split("\n")) assert.ok(line.length <= 62);
});

class FakeInput extends (await import("node:events")).EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.raw = false;
  }
  setRawMode(v) {
    this.raw = v;
    return this;
  }
  resume() {
    return this;
  }
}

test("pickFile drills into a directory and selects a file", async () => {
  const root = fixture();
  const input = new FakeInput();
  const output = { isTTY: false, write: () => true };
  try {
    const p = pickFile({ root, input, output });
    // type "src" to filter, then Enter drills into the dir, then Enter picks.
    input.emit("keypress", "s", { name: "s" });
    input.emit("keypress", "r", { name: "r" });
    input.emit("keypress", "c", { name: "c" });
    input.emit("keypress", null, { name: "return" });
    input.emit("keypress", null, { name: "return" });
    assert.equal(await p, "src/index.js");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pickFile cancels with null on Escape", async () => {
  const root = fixture();
  const input = new FakeInput();
  try {
    const p = pickFile({ root, input, output: { isTTY: false, write: () => true } });
    input.emit("keypress", null, { name: "escape" });
    assert.equal(await p, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
