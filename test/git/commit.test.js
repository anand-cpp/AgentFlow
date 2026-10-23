// Commit message generation, validation and creation.
//
// The generator is deterministic on purpose, so it is tested with fixtures plus
// one real staged change. createCommit is the only mutating call and is tested
// against a real repository.

import test from "node:test";
import assert from "node:assert/strict";

import {
  heuristicCommitMessage,
  generateCommitMessage,
  generateCommitMessageWithLLM,
  validateCommitMessage,
  getCommitTemplate,
  createCommit,
} from "../../src/core/git/commit.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

test("heuristicCommitMessage names a new file a feat", () => {
  const msg = heuristicCommitMessage([{ file: "src/widget.js", isNew: true, additions: 10, deletions: 0 }]);
  assert.equal(msg, "feat(src): add widget.js");
});

test("heuristicCommitMessage names a pure deletion a refactor", () => {
  const msg = heuristicCommitMessage([{ file: "src/old.js", isDeleted: true, additions: 0, deletions: 4 }]);
  assert.equal(msg, "refactor(src): remove old.js");
});

test("heuristicCommitMessage recognises docs and tests by path", () => {
  assert.equal(heuristicCommitMessage([{ file: "docs/guide.md", additions: 1, deletions: 1 }]), "docs: update guide.md");
  // A test file under test/ gets a "test" scope from its parent directory.
  assert.equal(
    heuristicCommitMessage([{ file: "test/foo.test.js", additions: 1, deletions: 1 }]),
    "test(test): update foo.test.js",
  );
});

test("heuristicCommitMessage handles the multi-file cases", () => {
  assert.equal(
    heuristicCommitMessage([{ file: "docs/a.md" }, { file: "docs/b.md" }]),
    "docs: update 2 files",
  );
  assert.equal(
    heuristicCommitMessage([{ file: "test/a.test.js" }, { file: "test/b.test.js" }]),
    "test: update 2 files",
  );
  assert.equal(heuristicCommitMessage([{ file: "package.json" }, { file: "package-lock.json" }]), "chore(deps): update dependencies");
  assert.equal(heuristicCommitMessage([{ file: "src/a.js" }, { file: "src/b.js" }]), "chore: update 2 files");
});

test("heuristicCommitMessage falls back on no files", () => {
  assert.equal(heuristicCommitMessage([]), "chore: update working tree");
});

test("validateCommitMessage flags length and non-conventional subjects", () => {
  const empty = validateCommitMessage("");
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(" "), /empty/);

  const long = validateCommitMessage(`feat: ${"x".repeat(80)}`);
  assert.equal(long.ok, false);
  assert.match(long.errors.join(" "), /max 72/);

  const freeform = validateCommitMessage("Revert previous change");
  assert.equal(freeform.ok, true);
  assert.equal(freeform.warnings.length, 1);

  const good = validateCommitMessage("feat(git): add staging");
  assert.equal(good.ok, true);
  assert.equal(good.warnings.length, 0);
  assert.equal(good.subject, "feat(git): add staging");
});

test("generateCommitMessage reads the staged diff", async (t) => {
  const repo = initRepo(t);
  write(repo, "widget.js", "export const x = 1;\n");
  git(repo, ["add", "widget.js"]);
  const ctx = await ctxFor(repo);
  const msg = await generateCommitMessage(ctx);
  assert.equal(msg, "feat: add widget.js");
});

test("generateCommitMessageWithLLM prefers the model output", async (t) => {
  const repo = initRepo(t);
  write(repo, "widget.js", "export const x = 1;\n");
  git(repo, ["add", "widget.js"]);
  const ctx = await ctxFor(repo);

  const improved = await generateCommitMessageWithLLM(ctx, undefined, async () => "feat(widget): introduce widget");
  assert.equal(improved, "feat(widget): introduce widget");
});

test("generateCommitMessageWithLLM falls back when the model throws or is empty", async (t) => {
  const repo = initRepo(t);
  write(repo, "widget.js", "export const x = 1;\n");
  git(repo, ["add", "widget.js"]);
  const ctx = await ctxFor(repo);

  const thrown = await generateCommitMessageWithLLM(ctx, undefined, async () => {
    throw new Error("model down");
  });
  assert.equal(thrown, "feat: add widget.js");

  const blank = await generateCommitMessageWithLLM(ctx, undefined, async () => "   ");
  assert.equal(blank, "feat: add widget.js");
});

test("getCommitTemplate reads a .gitmessage file", async (t) => {
  const repo = initRepo(t);
  write(repo, ".gitmessage", "type(scope): ---\n\n# body\n");
  const ctx = await ctxFor(repo);
  const res = await getCommitTemplate(ctx);
  assert.equal(res.ok, true);
  assert.match(res.template, /type\(scope\)/);
  assert.equal(res.source, ".gitmessage");
});

test("getCommitTemplate returns null when none is configured", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getCommitTemplate(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.template, null);
});

test("createCommit refuses an invalid message before running git", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  git(repo, ["add", "a.txt"]);
  const ctx = await ctxFor(repo);
  const before = git(repo, ["rev-parse", "HEAD"]).trim();
  const res = await createCommit(ctx, "");
  assert.equal(res.ok, false);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), before);
});

test("createCommit reports nothing-to-commit on a clean tree", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await createCommit(ctx, "feat: empty");
  assert.equal(res.ok, false);
  assert.equal(res.error, "nothing to commit");
});

test("createCommit commits staged changes and returns a short hash", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  git(repo, ["add", "a.txt"]);
  const ctx = await ctxFor(repo);
  const res = await createCommit(ctx, "feat(a): change value");
  assert.equal(res.ok, true, res.error || "");
  assert.match(res.hash, /^[0-9a-f]{4,}$/);
  assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "feat(a): change value");
});
