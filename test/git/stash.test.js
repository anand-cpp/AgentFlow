// Stash operations.
//
// The no-op case is the reason this module has tests: `git stash push` on a
// clean tree prints "No local changes to save" and exits 0, so a success-only
// check reports a stash that was never created.

import test from "node:test";
import assert from "node:assert/strict";

import {
  stashRef,
  parseStashList,
  stashList,
  stashSave,
  stashPop,
  stashApply,
  stashDrop,
  stashClear,
  stashShow,
} from "../../src/core/git/stash.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

test("stashRef normalises numbers, strings and defaults", () => {
  assert.equal(stashRef(undefined), "stash@{0}");
  assert.equal(stashRef(null), "stash@{0}");
  assert.equal(stashRef(2), "stash@{2}");
  assert.equal(stashRef("3"), "stash@{3}");
  assert.equal(stashRef("stash@{1}"), "stash@{1}");
});

test("parseStashList reads ref, branch and message", () => {
  const raw = [
    "stash@{0}\x00WIP on main: abc123 feat: work",
    "stash@{1}\x00On feature/x: named stash",
  ].join("\n");
  const stashes = parseStashList(raw);
  assert.equal(stashes.length, 2);
  assert.equal(stashes[0].index, 0);
  assert.equal(stashes[0].branch, "main");
  assert.equal(stashes[0].auto, true);
  assert.equal(stashes[0].message, "abc123 feat: work");
  assert.equal(stashes[1].branch, "feature/x");
  assert.equal(stashes[1].auto, false);
  assert.equal(stashes[1].message, "named stash");
});

test("stashSave on a clean tree reports no change, not a fake stash", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await stashSave(ctx, "should not appear");
  assert.equal(res.ok, false);
  assert.equal(res.ref, null);
  assert.match(res.error, /no local changes/);
  // And there is genuinely no stash.
  const list = await stashList(ctx);
  assert.equal(list.stashes.length, 0);
});

test("stashSave stamps a real stash and stashList sees it", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "dirty\n");
  const ctx = await ctxFor(repo);
  const saved = await stashSave(ctx, "wip: my work");
  assert.equal(saved.ok, true, saved.error || "");
  assert.equal(saved.ref, "stash@{0}");
  assert.match(saved.hash, /^[0-9a-f]{40}$/);

  const list = await stashList(ctx);
  assert.equal(list.stashes.length, 1);
  assert.equal(list.stashes[0].branch, "main");
  assert.equal(list.stashes[0].message, "wip: my work");

  // The worktree is clean after stashing.
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
});

test("stashPop restores content and drops the entry", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "dirty\n");
  const ctx = await ctxFor(repo);
  await stashSave(ctx, "wip");
  const popped = await stashPop(ctx);
  assert.equal(popped.ok, true);
  const fs = await import("node:fs");
  const path = await import("node:path");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "dirty\n");
  const list = await stashList(ctx);
  assert.equal(list.stashes.length, 0);
});

test("stashApply restores content but keeps the entry", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "dirty\n");
  const ctx = await ctxFor(repo);
  await stashSave(ctx, "wip");
  const applied = await stashApply(ctx);
  assert.equal(applied.ok, true);
  const list = await stashList(ctx);
  assert.equal(list.stashes.length, 1);
});

test("stashDrop removes an entry without restoring", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "dirty\n");
  const ctx = await ctxFor(repo);
  await stashSave(ctx, "wip");
  const dropped = await stashDrop(ctx, 0);
  assert.equal(dropped.ok, true);
  assert.equal((await stashList(ctx)).stashes.length, 0);
});

test("stashClear empties the stash", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  write(repo, "a.txt", "one\n");
  await stashSave(ctx, "first");
  write(repo, "a.txt", "two\n");
  await stashSave(ctx, "second");
  assert.equal((await stashList(ctx)).stashes.length, 2);
  const cleared = await stashClear(ctx);
  assert.equal(cleared.ok, true);
  assert.equal((await stashList(ctx)).stashes.length, 0);
});

test("stashShow returns a patch", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "dirty\n");
  const ctx = await ctxFor(repo);
  await stashSave(ctx, "wip");
  const res = await stashShow(ctx, 0);
  assert.equal(res.ok, true);
  assert.match(res.diff, /dirty/);
});

test("stash reference verbs reject a malformed ref", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const bad = await stashPop(ctx, "not-a-ref");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid stash reference/);
});
