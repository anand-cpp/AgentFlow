// Staging: whole files and single hunks.
//
// The ignored-file case is the security-relevant one: staging must never add a
// path .gitignore excludes unless the caller explicitly forces it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  sliceHunkPatch,
  stageFiles,
  unstageFiles,
  stageAll,
  unstageAll,
  stageHunk,
} from "../../src/core/git/staging.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

test("stageFiles stages a tracked modification", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  const ctx = await ctxFor(repo);
  const res = await stageFiles(ctx, ["a.txt"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.staged, ["a.txt"]);
  const status = git(repo, ["status", "--porcelain"]);
  assert.match(status, /^M {2}a\.txt/m);
});

test("stageFiles stages a new file", async (t) => {
  const repo = initRepo(t);
  write(repo, "new.txt", "fresh\n");
  const ctx = await ctxFor(repo);
  const res = await stageFiles(ctx, ["new.txt"]);
  assert.equal(res.ok, true);
  assert.match(git(repo, ["status", "--porcelain"]), /^A {2}new\.txt/m);
});

test("unstageFiles reverses a stage", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  git(repo, ["add", "a.txt"]);
  const ctx = await ctxFor(repo);
  const res = await unstageFiles(ctx, ["a.txt"]);
  assert.equal(res.ok, true);
  assert.match(git(repo, ["status", "--porcelain"]), /^ {1}M a\.txt/m);
});

test("stageFiles refuses ignored files unless forced", async (t) => {
  const repo = initRepo(t);
  write(repo, ".gitignore", "ignored.txt\n");
  write(repo, "ignored.txt", "secret\n");
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "chore: ignore"]);
  const ctx = await ctxFor(repo);

  const refused = await stageFiles(ctx, ["ignored.txt"]);
  assert.equal(refused.ok, false);
  assert.equal(git(repo, ["status", "--porcelain", "ignored.txt"]).trim(), "");

  const forced = await stageFiles(ctx, ["ignored.txt"], { force: true });
  assert.equal(forced.ok, true);
  assert.match(git(repo, ["status", "--porcelain", "ignored.txt"]), /^A {2}ignored\.txt/m);
});

test("stageFiles validates paths and reports the bad ones", async (t) => {
  const repo = initRepo(t);
  write(repo, "ok.txt", "x\n");
  const ctx = await ctxFor(repo);
  const res = await stageFiles(ctx, ["ok.txt", "../escape"]);
  assert.equal(res.ok, false);
  assert.deepEqual(res.staged, ["ok.txt"]);
  assert.equal(res.errors.length, 1);
});

test("stageFiles with no paths is an error, not a silent stage-all", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await stageFiles(ctx, []);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /no paths/);
});

test("stageAll and unstageAll move the whole tree", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "one\n");
  write(repo, "b.txt", "two\n");
  const ctx = await ctxFor(repo);
  assert.equal((await stageAll(ctx)).ok, true);
  let status = git(repo, ["status", "--porcelain"]);
  assert.match(status, /^M {2}a\.txt/m);
  assert.match(status, /^A {2}b\.txt/m);

  assert.equal((await unstageAll(ctx)).ok, true);
  status = git(repo, ["status", "--porcelain"]);
  assert.match(status, /^ {1}M a\.txt/m);
  assert.match(status, /^\?\? b\.txt/m);
});

test("stageHunk stages only the addressed hunk", async (t) => {
  const repo = initRepo(t);
  // Two distant changes produce two hunks.
  write(repo, "a.txt", `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n`);
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "chore: lines"]);
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  lines[0] = "CHANGED TOP";
  lines[39] = "CHANGED BOTTOM";
  write(repo, "a.txt", `${lines.join("\n")}\n`);

  const ctx = await ctxFor(repo);
  const res = await stageHunk(ctx, "a.txt", 0);
  assert.equal(res.ok, true, res.errors.join("; "));
  // The staged diff must contain the top change and not the bottom one.
  const staged = git(repo, ["diff", "--cached"]);
  assert.match(staged, /CHANGED TOP/);
  assert.equal(staged.includes("CHANGED BOTTOM"), false);
});

test("sliceHunkPatch selects one hunk and keeps the file header", () => {
  const raw = [
    "diff --git a/f.txt b/f.txt",
    "index 111..222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1 +1 @@",
    "-a",
    "+A",
    "@@ -10 +10 @@",
    "-b",
    "+B",
  ].join("\n");
  const first = sliceHunkPatch(raw, 0);
  assert.equal(first.ok, true);
  assert.match(first.patch, /diff --git a\/f\.txt b\/f\.txt/);
  assert.match(first.patch, /\+A/);
  assert.equal(first.patch.includes("+B"), false);

  const second = sliceHunkPatch(raw, 1);
  assert.match(second.patch, /\+B/);
  assert.equal(second.patch.includes("+A"), false);
});

test("sliceHunkPatch reports an out-of-range hunk index", () => {
  const raw = ["diff --git a/f.txt b/f.txt", "--- a/f.txt", "+++ b/f.txt", "@@ -1 +1 @@", "-a", "+A"].join("\n");
  const res = sliceHunkPatch(raw, 5);
  assert.equal(res.ok, false);
  assert.match(res.error, /out of range/);
});

test("sliceHunkPatch reports a diff with no hunks", () => {
  const res = sliceHunkPatch("diff --git a/f.txt b/f.txt\n", 0);
  assert.equal(res.ok, false);
  assert.match(res.error, /no hunks/);
});
