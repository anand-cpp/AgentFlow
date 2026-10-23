// git detection and workspace path guards.
//
// The load-bearing property here is the path guard: everything else in the git
// layer trusts that a path handed to argv has already been through
// validateRelPath / resolveInRoot. If those leak, every later module does too.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

import {
  findGitRoot,
  validateGitAvailable,
  validateWorkspace,
  validateRelPath,
  resolveInRoot,
  validatePaths,
} from "../../src/core/git/discover.js";
import { tmpdir, initRepo, ctxFor } from "./helpers.js";

test("findGitRoot walks up to the repository root", async (t) => {
  const repo = initRepo(t);
  const deep = path.join(repo, "src", "nested", "deeper");
  fs.mkdirSync(deep, { recursive: true });

  const found = findGitRoot(deep);
  assert.equal(found.ok, true);
  assert.equal(path.resolve(found.root), path.resolve(repo));
  assert.equal(found.worktree, false);
});

test("findGitRoot reports a directory that is not a repository", async (t) => {
  const dir = tmpdir(t, "aflow-norepo-");
  const found = findGitRoot(dir);
  assert.equal(found.ok, false);
  assert.match(found.error, /not a git repository/);
});

test("validateGitAvailable reports a version triple", async () => {
  const v = await validateGitAvailable();
  assert.equal(v.ok, true, v.error || "");
  assert.match(v.version, /^\d+\.\d+/);
  assert.ok(v.major >= 2);
});

test("validateWorkspace returns a handle rooted at the repository", async (t) => {
  const repo = initRepo(t);
  const ws = await validateWorkspace(path.join(repo, "a.txt"));
  assert.equal(ws.ok, true);
  assert.equal(path.resolve(ws.root), path.resolve(repo));
  assert.equal(ws.bare, false);
});

test("validateWorkspace refuses a directory outside any repository", async (t) => {
  const dir = tmpdir(t, "aflow-norepo-");
  const ws = await validateWorkspace(dir);
  assert.equal(ws.ok, false);
  assert.match(ws.error, /not a git repository/);
});

test("validateRelPath rejects absolute, traversal and metacharacter paths", () => {
  assert.equal(validateRelPath("").ok, false);
  assert.equal(validateRelPath("   ").ok, false);
  const traversal = validateRelPath("../etc/passwd");
  assert.equal(traversal.ok, false);
  assert.match(traversal.error, /\.\./);
  const absolute = validateRelPath("/etc/passwd");
  assert.equal(absolute.ok, false);
  assert.match(absolute.error, /absolute/);
  const drive = validateRelPath("C:/Windows/system32");
  assert.equal(drive.ok, false);
  const injection = validateRelPath("foo; rm -rf /");
  assert.equal(injection.ok, false);
  assert.match(injection.error, /forbidden characters/);
  assert.equal(validateRelPath("a\nb").ok, false);
  assert.equal(validateRelPath("a\0b").ok, false);
});

test("validateRelPath accepts ordinary workspace-relative paths", () => {
  assert.equal(validateRelPath("src/index.js").ok, true);
  assert.equal(validateRelPath("a/b/c.txt").ok, true);
  // A dot segment is not a traversal; only a literal ".." is.
  assert.equal(validateRelPath("./a.txt").ok, true);
});

test("resolveInRoot proves the result stays inside the root", () => {
  const root = path.resolve("/tmp/ws");
  const ok = resolveInRoot(root, "src/a.js");
  assert.equal(ok.ok, true);
  assert.equal(ok.relPath, "src/a.js");
  const escaped = resolveInRoot(root, "../outside");
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /\.\./);
});

test("resolveInRoot normalises Windows separators to posix relPath", async (t) => {
  const repo = initRepo(t);
  const r = resolveInRoot(repo, path.join("src", "a.js"));
  assert.equal(r.ok, true);
  assert.equal(r.relPath, "src/a.js");
});

test("validatePaths keeps the good paths and reports the bad", async (t) => {
  const repo = initRepo(t);
  const r = validatePaths(repo, ["a.txt", "../escape", "b.txt"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.paths, ["a.txt", "b.txt"]);
  assert.equal(r.errors.length, 1);
});

test("GitContext.run reports a failure without throwing", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const ok = await ctx.run(["rev-parse", "--is-inside-work-tree"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.stdout.trim(), "true");

  const bad = await ctx.run(["rev-parse", "no-such-ref-xyz"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code !== null, true);
  assert.equal(typeof bad.error, "string");
});

test("GitContext.run runs in the workspace root, not the process cwd", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await ctx.run(["rev-parse", "--show-toplevel"]);
  assert.equal(res.ok, true);
  assert.equal(path.resolve(res.stdout.trim()), path.resolve(repo));
});
