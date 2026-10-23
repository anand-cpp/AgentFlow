// Branch management and name validation.
//
// Name validation is the security boundary: a name reaches git's argv, so the
// tests below pin the rejections (leading dash, "..", "@{", shell metacharacters)
// and the acceptances, not just the happy path.

import test from "node:test";
import assert from "node:assert/strict";

import {
  listBranches,
  parseBranchList,
  validateBranchName,
  validateStartPoint,
  currentBranch,
  createBranch,
  switchBranch,
  deleteBranch,
  renameBranch,
} from "../../src/core/git/branches.js";
import { initRepo, git, ctxFor } from "./helpers.js";

test("validateBranchName accepts ordinary names", () => {
  for (const name of ["main", "feature/x", "release-1.2", "fix_bug.1"]) {
    assert.equal(validateBranchName(name).ok, true, name);
  }
});

test("validateBranchName rejects structural and shell hazards", () => {
  assert.equal(validateBranchName("").ok, false);
  assert.equal(validateBranchName("-flag").ok, false);
  assert.equal(validateBranchName("a..b").ok, false);
  assert.equal(validateBranchName("a@{1}").ok, false);
  assert.equal(validateBranchName("@").ok, false);
  assert.equal(validateBranchName("/lead").ok, false);
  assert.equal(validateBranchName("trail/").ok, false);
  assert.equal(validateBranchName("a//b").ok, false);
  assert.equal(validateBranchName("x.lock").ok, false);
  assert.equal(validateBranchName("x.").ok, false);
  assert.equal(validateBranchName("a b").ok, false);
  assert.equal(validateBranchName("a;rm -rf").ok, false);
  assert.equal(validateBranchName("a~b").ok, false);
  assert.equal(validateBranchName("a^b").ok, false);
  assert.equal(validateBranchName(`a${"x".repeat(300)}`).ok, false);
  assert.equal(validateBranchName(42).ok, false);
});

test("validateStartPoint allows revisions but not traversal", () => {
  assert.equal(validateStartPoint("HEAD~1").ok, true);
  assert.equal(validateStartPoint("origin/main").ok, true);
  assert.equal(validateStartPoint("v1.0.0^{}").ok, true);
  assert.equal(validateStartPoint("").ok, false);
  assert.equal(validateStartPoint("-x").ok, false);
  assert.equal(validateStartPoint("a b").ok, false);
  assert.equal(validateStartPoint("a..b").ok, false);
});

test("parseBranchList marks the current branch", () => {
  const raw = ["main abc1234 origin/main *", "feature/x def5678  "].join("\n");
  const branches = parseBranchList(raw);
  assert.equal(branches.length, 2);
  assert.equal(branches[0].name, "main");
  assert.equal(branches[0].isCurrent, true);
  assert.equal(branches[0].upstream, "origin/main");
  assert.equal(branches[1].name, "feature/x");
  assert.equal(branches[1].isCurrent, false);
  assert.equal(branches[1].upstream, null);
});

test("currentBranch names the checked-out branch", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const cur = await currentBranch(ctx);
  assert.equal(cur.ok, true);
  assert.equal(cur.name, "main");
  assert.equal(cur.detached, false);
});

test("createBranch then switchBranch moves HEAD", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  assert.equal((await createBranch(ctx, "feature/x")).ok, true);

  const created = await listBranches(ctx);
  assert.ok(created.branches.some((b) => b.name === "feature/x" && !b.isCurrent));

  const switched = await switchBranch(ctx, "feature/x");
  assert.equal(switched.ok, true);
  const cur = await currentBranch(ctx);
  assert.equal(cur.name, "feature/x");
});

test("createBranch refuses an invalid name without touching git", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await createBranch(ctx, "bad name");
  assert.equal(res.ok, false);
  assert.match(res.error, /may contain only/);
});

test("deleteBranch refuses to delete the current branch", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await deleteBranch(ctx, "main");
  assert.equal(res.ok, false);
  assert.match(res.error, /current branch/);
});

test("deleteBranch removes a merged branch", async (t) => {
  const repo = initRepo(t);
  git(repo, ["branch", "merged"]);
  const ctx = await ctxFor(repo);
  const res = await deleteBranch(ctx, "merged");
  assert.equal(res.ok, true);
  const branches = await listBranches(ctx);
  assert.equal(branches.branches.some((b) => b.name === "merged"), false);
});

test("renameBranch renames", async (t) => {
  const repo = initRepo(t);
  git(repo, ["branch", "old"]);
  const ctx = await ctxFor(repo);
  const res = await renameBranch(ctx, "old", "renamed");
  assert.equal(res.ok, true);
  const branches = await listBranches(ctx);
  assert.ok(branches.branches.some((b) => b.name === "renamed"));
  assert.equal(branches.branches.some((b) => b.name === "old"), false);
});

test("currentBranch reports a detached HEAD as name-less", async (t) => {
  const repo = initRepo(t);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "--detach", head]);
  const ctx = await ctxFor(repo);
  const cur = await currentBranch(ctx);
  assert.equal(cur.ok, true);
  assert.equal(cur.name, null);
  assert.equal(cur.detached, true);
});

test("listBranches reports commit shas", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await listBranches(ctx);
  assert.equal(res.ok, true);
  const main = res.branches.find((b) => b.name === "main");
  assert.match(main.oid, /^[0-9a-f]{4,}$/);
});
