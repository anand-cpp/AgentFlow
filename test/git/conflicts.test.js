// Merge-conflict detection and resolution.
//
// A real conflicted merge is the fixture where possible: marker parsing and
// `checkout --ours/--theirs` behave differently from the synthetic cases, and
// the point of reusing the porcelain-v2 unmerged entries is that they line up.

import test from "node:test";
import assert from "node:assert/strict";

import {
  detectConflicts,
  parseConflictMarkers,
  resolveMarkers,
  resolveConflict,
  isMergeInProgress,
  abortMerge,
} from "../../src/core/git/conflicts.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

function conflictingRepo(t) {
  const repo = initRepo(t);
  git(repo, ["switch", "-c", "other"]);
  write(repo, "a.txt", "theirs\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "feat: theirs"]);
  git(repo, ["switch", "main"]);
  write(repo, "a.txt", "ours\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "feat: ours"]);
  try {
    git(repo, ["merge", "other"]);
  } catch {
    /* the merge is expected to conflict */
  }
  return repo;
}

test("parseConflictMarkers finds ours/theirs blocks", () => {
  const content = ["keep", "<<<<<<< HEAD", "ours line", "=======", "theirs line", ">>>>>>> other", "tail"].join("\n");
  const conflicts = parseConflictMarkers(content);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].ours, "ours line");
  assert.equal(conflicts[0].theirs, "theirs line");
});

test("resolveMarkers rebuilds content per strategy", () => {
  const content = ["top", "<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> other", "bottom"].join("\n");
  assert.equal(resolveMarkers(content, "ours").content, "top\nours\nbottom");
  assert.equal(resolveMarkers(content, "theirs").content, "top\ntheirs\nbottom");
  assert.equal(resolveMarkers(content, "both").content, "top\nours\ntheirs\nbottom");
});

test("resolveMarkers captures a diff3 base section", () => {
  const content = ["<<<<<<< HEAD", "ours", "||||||| base", "orig", "=======", "theirs", ">>>>>>> other"].join("\n");
  const { conflicts } = resolveMarkers(content, "ours");
  assert.equal(conflicts[0].base, "orig");
});

test("detectConflicts reads a real conflicted merge", async (t) => {
  const repo = conflictingRepo(t);
  const ctx = await ctxFor(repo);
  const res = await detectConflicts(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].path, "a.txt");
  assert.equal(res.conflicts[0].status, "UU");
  assert.equal(typeof res.conflicts[0].stages.ours, "string");
});

test("isMergeInProgress and abortMerge work on a conflicted tree", async (t) => {
  const repo = conflictingRepo(t);
  const ctx = await ctxFor(repo);
  assert.equal(await isMergeInProgress(ctx), true);
  const aborted = await abortMerge(ctx);
  assert.equal(aborted.ok, true);
  assert.equal(await isMergeInProgress(ctx), false);
  const after = await detectConflicts(ctx);
  assert.equal(after.conflicts.length, 0);
});

test("resolveConflict with ours takes the local side and clears the conflict", async (t) => {
  const repo = conflictingRepo(t);
  const ctx = await ctxFor(repo);
  const res = await resolveConflict(ctx, "a.txt", "ours");
  assert.equal(res.ok, true, res.error || "");
  const after = await detectConflicts(ctx);
  assert.equal(after.conflicts.length, 0);
  const staged = git(repo, ["show", ":a.txt"]);
  assert.equal(staged, "ours\n");
});

test("resolveConflict validates the path before touching anything", async (t) => {
  const repo = conflictingRepo(t);
  const ctx = await ctxFor(repo);
  const res = await resolveConflict(ctx, "../escape", "ours");
  assert.equal(res.ok, false);
});
