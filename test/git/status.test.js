// Porcelain v2 status parsing.
//
// parseStatus is pure, so the fixtures here cover entry kinds a live repository
// makes awkward to produce on demand (unmerged, copied, typechanged). runStatus
// is exercised against a real repo for the common cases.

import test from "node:test";
import assert from "node:assert/strict";

import { parseStatus, runStatus, statusLabel } from "../../src/core/git/status.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

test("parseStatus reads the branch header", () => {
  const out = parseStatus(
    [
      "# branch.oid abc123",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
    ].join("\n"),
  );
  assert.equal(out.branch.name, "main");
  assert.equal(out.branch.oid, "abc123");
  assert.equal(out.branch.upstream, "origin/main");
  assert.equal(out.branch.ahead, 2);
  assert.equal(out.branch.behind, 3);
  assert.equal(out.branch.detached, false);
});

test("parseStatus marks a detached HEAD", () => {
  const out = parseStatus("# branch.head (detached)\n# branch.oid deadbeef");
  assert.equal(out.branch.detached, true);
  assert.equal(out.branch.name, null);
});

test("parseStatus splits a modified-both entry into staged and unstaged", () => {
  // "MM" is one path that changed in the index and again in the worktree; it
  // belongs in both buckets, which is exactly the mistake a naive parser makes.
  const out = parseStatus("1 MM N... 100644 100644 100644 h1 h1 file.txt");
  assert.equal(out.staged.length, 1);
  assert.equal(out.unstaged.length, 1);
  assert.equal(out.staged[0].path, "file.txt");
  assert.equal(out.staged[0].indexStatus, "M");
  assert.equal(out.unstaged[0].workTreeStatus, "M");
});

test("parseStatus drops the rename score from a type-2 line", () => {
  const out = parseStatus("2 R. N... 100644 100644 100644 h1 h2 R63 new.txt\told.txt");
  assert.equal(out.staged.length, 1);
  assert.equal(out.staged[0].path, "new.txt");
  assert.equal(out.staged[0].origPath, "old.txt");
  assert.equal(out.staged[0].score, 63);
  assert.equal(out.staged[0].indexStatus, "R");
});

test("parseStatus buckets unmerged, untracked and ignored entries", () => {
  const out = parseStatus(
    [
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
      "? untracked.txt",
      "! ignored.log",
    ].join("\n"),
  );
  assert.equal(out.unmerged.length, 1);
  assert.equal(out.unmerged[0].path, "conflict.txt");
  assert.equal(out.unmerged[0].status, "UU");
  assert.deepEqual(out.unmerged[0].stages, { base: "h1", ours: "h2", theirs: "h3" });
  assert.equal(out.untracked.length, 1);
  assert.equal(out.untracked[0].path, "untracked.txt");
  assert.equal(out.ignored.length, 1);
  assert.equal(out.ignored[0].path, "ignored.log");
});

test("parseStatus unquotes a C-quoted path", () => {
  const out = parseStatus('? "sp ace\\tname.txt"');
  assert.equal(out.untracked[0].path, "sp ace\tname.txt");
});

test("statusLabel maps codes and falls back for the unknown", () => {
  assert.equal(statusLabel("M"), "modified");
  assert.equal(statusLabel("?"), "untracked");
  assert.equal(statusLabel("Z"), "unknown");
});

test("runStatus reports staged, unstaged and untracked in a real repo", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "hello again\n");
  git(repo, ["add", "a.txt"]);
  write(repo, "a.txt", "hello yet again\n");
  write(repo, "new.txt", "fresh\n");

  const ctx = await ctxFor(repo);
  const res = await runStatus(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.branch.name, "main");
  assert.ok(res.staged.some((e) => e.path === "a.txt"));
  assert.ok(res.unstaged.some((e) => e.path === "a.txt"));
  assert.ok(res.untracked.some((e) => e.path === "new.txt"));
});

test("runStatus on a clean tree reports nothing changed", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await runStatus(ctx);
  assert.equal(res.staged.length, 0);
  assert.equal(res.unstaged.length, 0);
  assert.equal(res.untracked.length, 0);
});
