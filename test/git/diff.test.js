// Diff generation and unified-diff parsing.
//
// parseDiff is pure, so the fixtures pin the shapes a live repo produces:
// new, deleted, modified, renamed and binary entries. runDiff/diffStat are
// exercised against a real repository.

import test from "node:test";
import assert from "node:assert/strict";

import { parseDiff, runDiff, diffStat } from "../../src/core/git/diff.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

test("parseDiff reads a new-file hunk", () => {
  const raw = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..abc1234",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+line one",
    "+line two",
  ].join("\n");
  const files = parseDiff(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].isNew, true);
  assert.equal(files[0].file, "new.txt");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 0);
});

test("parseDiff reads a modified hunk with a deletion", () => {
  const raw = [
    "diff --git a/a.txt b/a.txt",
    "index 111..222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    " context",
    "-old",
    "+new",
  ].join("\n");
  const [file] = parseDiff(raw);
  assert.equal(file.file, "a.txt");
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks[0].lines.find((l) => l.type === "delete").content, "old");
});

test("parseDiff reads a rename with no content change", () => {
  const raw = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
  ].join("\n");
  const [file] = parseDiff(raw);
  assert.equal(file.isRename, true);
  assert.equal(file.renameFrom, "old.txt");
  assert.equal(file.renameTo, "new.txt");
  assert.equal(file.file, "new.txt");
});

test("parseDiff marks a binary entry and keeps no hunks", () => {
  const raw = [
    "diff --git a/img.png b/img.png",
    "index 111..222 100644",
    "Binary files a/img.png and b/img.png differ",
  ].join("\n");
  const [file] = parseDiff(raw);
  assert.equal(file.isBinary, true);
  assert.equal(file.hunks.length, 0);
  assert.equal(file.file, "img.png");
});

test("parseDiff of empty input is an empty list", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff(null), []);
});

test("runDiff returns parsed files and raw text for a real change", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "hello\nworld\n");
  const ctx = await ctxFor(repo);
  const res = await runDiff(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].file, "a.txt");
  assert.match(res.raw, /diff --git/);
});

test("runDiff with staged reads the index, not the worktree", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "staged\n");
  git(repo, ["add", "a.txt"]);
  write(repo, "a.txt", "unstaged\n");
  const ctx = await ctxFor(repo);

  const staged = await runDiff(ctx, { staged: true });
  assert.equal(staged.files.length, 1);
  assert.match(staged.raw, /\+staged/);

  const unstaged = await runDiff(ctx, {});
  assert.match(unstaged.raw, /\+unstaged/);
});

test("runDiff validates its paths and refuses traversal", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await runDiff(ctx, { paths: ["../escape"] });
  assert.equal(res.ok, false);
  assert.match(res.error, /invalid path/);
});

test("diffStat reports per-file counts", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "hello\nworld\n");
  const ctx = await ctxFor(repo);
  const res = await diffStat(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].file, "a.txt");
  assert.equal(res.files[0].additions, 1);
  assert.equal(res.files[0].binary, false);
});
