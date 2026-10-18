// Unit tests for the repository-map walker: gitignore semantics (root and
// nested files), file caps with deterministic priority, binary/huge/symlink
// refusal, and path normalization. Everything runs in throwaway temp trees.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  walkWorkspace,
  compileGitignore,
  isIgnored,
  fileClass,
} from "../../src/core/map/walk.js";

function tree(t, files, dirs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-walk-"));
  fs.mkdirSync(root, { recursive: true });
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const rels = (result) => result.files.map((f) => f.rel);

test("walk collects source, doc and other files with sizes and mtimes", (t) => {
  const root = tree(t, {
    "src/index.js": "console.log(1);",
    "README.md": "# hi",
    "notes.txt": "stuff",
  });
  const result = walkWorkspace(root);
  assert.deepEqual(rels(result), ["src/index.js", "README.md", "notes.txt"]);
  const src = result.files.find((f) => f.rel === "src/index.js");
  assert.ok(src.size > 0);
  assert.ok(Number.isFinite(src.mtimeMs));
  assert.equal(result.truncated, false);
});

test("always-skip directories are never visited, even unignored", (t) => {
  const root = tree(t, {
    "node_modules/lib/index.js": "x",
    "dist/bundle.js": "x",
    "coverage/out.js": "x",
    ".git/HEAD": "x",
    ".agentflow/repo-map.json": "{}",
    "src/main.js": "x",
  });
  const result = walkWorkspace(root);
  assert.ok(rels(result).includes("src/main.js"));
  for (const f of result.files) {
    assert.ok(!f.rel.startsWith("node_modules/"), `never walk node_modules: ${f.rel}`);
    assert.ok(!f.rel.startsWith(".git/"));
    assert.ok(!f.rel.startsWith(".agentflow/"));
  }
});

test("root .gitignore: directory patterns, globs, negation", (t) => {
  const root = tree(t, {
    ".gitignore": "dist/\n*.log\n!keep.log\nbuild*\n",
    "src/main.js": "x",
    "src/debug.log": "x",
    "src/keep.log": "x",
    "dist/out.js": "x",
    "build-artifacts/junk.js": "x",
    "builder/tool.js": "x",
  });
  const result = walkWorkspace(root);
  const got = rels(result);
  assert.ok(!got.includes("src/debug.log"), "*.log applies to subdirectories");
  assert.ok(got.includes("src/keep.log"), "later negation un-ignores");
  assert.ok(!got.includes("dist/out.js"), "dist/ ignores the subtree");
  assert.ok(!got.includes("build-artifacts/junk.js"), "build* matches at any depth");
  assert.ok(!got.includes("builder/tool.js"), "build* also prefixes names");
});

test("anchored patterns only match at the root of their gitignore", (t) => {
  const root = tree(t, {
    ".gitignore": "/top.js\nchild.js\n",
    "top.js": "x",
    "a/top.js": "x",
    "libs/.gitignore": "/root-only.js\ninner.js\n",
    "libs/root-only.js": "x",
    "libs/deep/inner.js": "x",
    "inner.js": "x",
  });
  const result = walkWorkspace(root);
  const got = rels(result);
  assert.ok(!got.includes("top.js"), "/top.js is anchored to the root gitignore");
  assert.ok(got.includes("a/top.js"), "anchored patterns do not reach subdirectories");
  assert.ok(!got.includes("libs/root-only.js"), "nested gitignore governs its subtree");
  assert.ok(!got.includes("libs/deep/inner.js"), "unanchored child.lua matches in the subtree");
  assert.ok(got.includes("inner.js"), "root-level inner.js is untouched by the nested file");
});

test("directory-ignore wins over a negated file inside (git parity)", (t) => {
  // Real git cannot re-include a file whose parent directory is excluded, and
  // the walk prunes ignored directories for the same reason: the negated
  // file's rules never get the chance to fire.
  const root = tree(t, {
    ".gitignore": "logs/\n!logs/keep.txt\nlogs/drop.txt\n",
    "logs/keep.txt": "x",
    "logs/drop.txt": "x",
  });
  const got = rels(walkWorkspace(root));
  assert.ok(!got.includes("logs/keep.txt"));
  assert.ok(!got.includes("logs/drop.txt"));
});

test("negation re-includes files matched by a file rule", (t) => {
  const root = tree(t, {
    ".gitignore": "*.log\n!keep.log\n",
    "src/noise.log": "x",
    "src/keep.log": "x",
  });
  const got = rels(walkWorkspace(root));
  assert.ok(!got.includes("src/noise.log"));
  assert.ok(got.includes("src/keep.log"));
});

test("file cap truncates with source extensions first, path order next", (t) => {
  const files = {};
  for (let i = 0; i < 6; i += 1) files[`z${i}.txt`] = "x";
  for (let i = 0; i < 4; i += 1) files[`a${i}.js`] = "x";
  const root = tree(t, files);
  const result = walkWorkspace(root, { maxFiles: 5 });
  assert.equal(files.length, undefined);
  const got = rels(result);
  assert.equal(got.length, 5);
  assert.equal(result.truncated, true);
  // all four .js files survive before any .txt
  assert.deepEqual(got.filter((f) => f.endsWith(".js")), ["a0.js", "a1.js", "a2.js", "a3.js"]);
});

test("binary extensions and huge files are refused, not crash-level errors", (t) => {
  const root = tree(t, {
    "img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "small.js": "x",
    "huge.js": "x".repeat(2048),
  });
  const result = walkWorkspace(root, { maxFileBytes: 1000 });
  const got = rels(result);
  assert.deepEqual(got, ["small.js"]);
  assert.equal(result.skipped.big, 1);
});

test("symlinks are refused so the walk can never loop", (t) => {
  const root = tree(t, { "src/real.js": "x" });
  try {
    fs.symlinkSync(path.join(root, "src"), path.join(root, "loop"), "junction");
  } catch {
    t.skip("symlinks unavailable on this volume");
  }
  const result = walkWorkspace(root);
  assert.ok(!rels(result).some((f) => f.startsWith("loop")));
});

test("empty and unreadable-safe walks never throw", (t) => {
  const root = tree(t, {});
  const result = walkWorkspace(root);
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, false);
});

test("compileGitignore + isIgnored are usable standalone", () => {
  const rules = compileGitignore("*.min.js\n!vendor/*.min.js\n/rooted.js\n!docs/*.min.js\n");
  assert.equal(isIgnored("app.min.js", false, rules), true);
  assert.equal(isIgnored("src/app.min.js", false, rules), true, "star matches a basename at any depth");
  assert.equal(isIgnored("vendor/app.min.js", false, rules), false, "unanchored negation fires at depth 1");
  assert.equal(isIgnored("rooted.js", false, rules), true);
  assert.equal(isIgnored("src/rooted.js", false, rules), false, "anchored stays at base");
  assert.equal(isIgnored("src/sum.js", false, rules), false);
});

test("fileClass ranks source over docs over other", () => {
  assert.equal(fileClass("src/main.ts"), 0);
  assert.equal(fileClass("README.md"), 1);
  assert.equal(fileClass("assets/icon.junk"), 2);
});
