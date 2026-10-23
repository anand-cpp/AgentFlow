// The `git` command dispatcher shared by the CLI and the `/git` chat slash.
//
// Both front doors call dispatchGit, so testing it directly covers both. The
// dispatch table is the surface a user reaches, including the error paths.

import test from "node:test";
import assert from "node:assert/strict";

import { openWorkspace, dispatchGit, gitSlash } from "../../src/commands/git.js";
import { initRepo, write, git } from "./helpers.js";

test("openWorkspace resolves a repository root", async (t) => {
  const repo = initRepo(t);
  const open = await openWorkspace(repo);
  assert.equal(open.ok, true);
  assert.equal(open.root, repo);
  assert.match(open.gitVersion, /\d+\.\d+/);
});

test("openWorkspace reports a directory that is not a repository", async (t) => {
  const repo = initRepo(t);
  const notRepo = `${repo}-none`;
  const fs = await import("node:fs");
  fs.mkdirSync(notRepo, { recursive: true });
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  const open = await openWorkspace(notRepo);
  assert.equal(open.ok, false);
  assert.match(open.error, /not a git repository/);
});

test("dispatchGit status renders the branch", async (t) => {
  const repo = initRepo(t);
  const open = await openWorkspace(repo);
  const res = await dispatchGit(open.ctx, "status");
  assert.equal(res.ok, true);
  assert.match(res.text, /main/);
});

test("dispatchGit diff --stat lists changed files", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "hello\nworld\n");
  const open = await openWorkspace(repo);
  const res = await dispatchGit(open.ctx, "diff", ["--stat"]);
  assert.equal(res.ok, true);
  assert.match(res.text, /a\.txt/);
});

test("dispatchGit stage then commit", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  const open = await openWorkspace(repo);

  const staged = await dispatchGit(open.ctx, "stage", ["a.txt"]);
  assert.equal(staged.ok, true);

  const committed = await dispatchGit(open.ctx, "commit", ["fix(a):", "change"]);
  assert.equal(committed.ok, true, committed.text);
  assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "fix(a): change");
});

test("dispatchGit branch lists the current branch", async (t) => {
  const repo = initRepo(t);
  const open = await openWorkspace(repo);
  const res = await dispatchGit(open.ctx, "branch");
  assert.equal(res.ok, true);
  assert.match(res.text, /main/);
});

test("dispatchGit stage with no paths is an error", async (t) => {
  const repo = initRepo(t);
  const open = await openWorkspace(repo);
  const res = await dispatchGit(open.ctx, "stage", []);
  assert.equal(res.ok, false);
  assert.match(res.text, /requires at least one path/);
});

test("dispatchGit rejects an unknown subcommand", async (t) => {
  const repo = initRepo(t);
  const open = await openWorkspace(repo);
  const res = await dispatchGit(open.ctx, "frobnicate", []);
  assert.equal(res.ok, false);
  assert.match(res.text, /unknown git subcommand/);
});

test("gitSlash defaults to status and returns a string", async (t) => {
  const repo = initRepo(t);
  const text = await gitSlash("", { root: repo });
  assert.equal(typeof text, "string");
  assert.match(text, /main/);
});

test("gitSlash on a non-repository explains the failure", async (t) => {
  const repo = initRepo(t);
  const notRepo = `${repo}-none`;
  const fs = await import("node:fs");
  fs.mkdirSync(notRepo, { recursive: true });
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  const text = await gitSlash("status", { root: notRepo });
  assert.match(text, /not a git repository/);
});
