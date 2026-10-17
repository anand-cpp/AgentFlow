// Shared fixtures for the git integration tests.
//
// These build real repositories on disk and drive real git. A mock cannot tell
// you whether `git stash push` reported a stash it never created, and the whole
// point of this layer is that it shells out to git -- so the tests do too.
//
// Not named *.test.js, so the runner does not collect it as a suite.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { GitContext, validateWorkspace } from "../../src/core/git/discover.js";

/** A temp directory removed when the test finishes. */
export function tmpdir(t, prefix = "aflow-git-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run git synchronously in `cwd`, returning stdout. Throws on a non-zero exit. */
export function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, windowsHide: true });
}

/** Write a file, creating parents, with LF endings regardless of platform. */
export function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/**
 * A repository with one commit on `main` containing a.txt.
 *
 * The local config pins the settings a test must not inherit from the host:
 * a signing key would make commit fail, autocrlf would rewrite every diff, and
 * a global user would make the "needs an identity" paths untestable.
 */
export function initRepo(t, { name = "repo" } = {}) {
  const base = tmpdir(t, "aflow-git-repo-");
  const repo = path.join(base, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "core.quotepath", "true"]);
  write(repo, "a.txt", "hello\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "feat: initial commit"]);
  return repo;
}

/** A validated GitContext for a repository root. */
export async function ctxFor(root) {
  const ws = await validateWorkspace(root);
  if (!ws.ok) throw new Error(`fixture is not a repository: ${ws.error}`);
  return new GitContext({ root: ws.root, gitVersion: ws.gitVersion, bare: ws.bare, worktree: ws.worktree });
}

/** True when git is on PATH and usable; tests skip themselves otherwise. */
export function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
