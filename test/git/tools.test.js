// The git agent tools, driven through the same permission waterfall the runtime
// uses. The point is twofold: each tool reaches git and shapes a result, and a
// model granted only READ cannot write through any of them.

import test from "node:test";
import assert from "node:assert/strict";

import { runTool, OUTCOME } from "../../src/core/agents/tools.js";
import { defineAgent } from "../../src/core/agents/registry.js";
import { gitTools, GIT_TOOL_NAMES } from "../../src/core/git/tools.js";
import { initRepo, write, git } from "./helpers.js";

function agentWith(scopes, policy = {}) {
  return defineAgent({
    id: "tester",
    purpose: "exercise the git tools",
    instructions: "Call tools and report what happened.",
    tools: { scopes, allow: scopes.map((s) => `${s}:*`), deny: [], ask: [], ...policy },
  });
}

const byName = Object.fromEntries(gitTools.map((t) => [t.name, t]));

function call(name, args, { agent, workspaceRoot }) {
  const tool = byName[name];
  return runTool(agent, tool, { tool: name, args }, { workspaceRoot });
}

test("git tools are exactly the documented set", () => {
  assert.deepEqual([...GIT_TOOL_NAMES].sort(), [
    "git.blame",
    "git.branch",
    "git.commit",
    "git.conflicts",
    "git.diff",
    "git.log",
    "git.show",
    "git.stage",
    "git.stash",
    "git.status",
  ]);
});

test("git.status renders a clean repository", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.status", {}, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.match(r.output.output, /On branch main/);
  assert.equal(r.output.clean, true);
});

test("git.status prints untracked paths, not objects", async (t) => {
  const repo = initRepo(t);
  write(repo, "new.txt", "fresh\n");
  const r = await call("git.status", {}, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.match(r.output.output, /untracked: new\.txt/);
  assert.equal(r.output.clean, false);
});

test("git.stage stages a file the model names", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  const r = await call("git.stage", { files: ["a.txt"] }, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.deepEqual(r.output.staged, ["a.txt"]);
  assert.match(git(repo, ["status", "--porcelain"]), /^M {2}a\.txt/m);
});

test("git.stage without files or all is a usage error", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.stage", {}, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.ERROR);
});

test("git.commit generates a message from the staged diff", async (t) => {
  const repo = initRepo(t);
  write(repo, "widget.js", "export const x = 1;\n");
  git(repo, ["add", "widget.js"]);
  const r = await call("git.commit", {}, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK, r.error?.message || "");
  assert.equal(r.output.message, "feat: add widget.js");
  assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "feat: add widget.js");
});

test("git.commit with an explicit message uses it", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  git(repo, ["add", "a.txt"]);
  const r = await call("git.commit", { message: "fix(a): tweak" }, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "fix(a): tweak");
});

test("git.show needs a ref", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.show", {}, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.ERROR);
});

test("git.show returns metadata for HEAD", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.show", { ref: "HEAD" }, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.equal(r.output.meta.subject, "feat: initial commit");
});

test("git.diff --stat summarises files", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "hello\nworld\n");
  const r = await call("git.diff", { stat: true }, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.equal(r.output.files.length, 1);
  assert.equal(r.output.files[0].file, "a.txt");
});

test("git.log lists commits", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.log", {}, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.equal(r.output.commits.length, 1);
  assert.equal(r.output.commits[0].subject, "feat: initial commit");
});

test("git.branch list includes the current branch", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.branch", { action: "list" }, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.OK);
  assert.equal(r.output.current, "main");
  assert.ok(r.output.branches.some((b) => b.name === "main"));
});

test("git.branch create validates the name", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.branch", { action: "create", name: "bad name" }, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.ERROR);
});

test("git.stash save then list round-trips", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "dirty\n");
  const saved = await call("git.stash", { action: "save", message: "wip" }, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(saved.outcome, OUTCOME.OK);
  const list = await call("git.stash", { action: "list" }, { agent: agentWith(["write"]), workspaceRoot: repo });
  assert.equal(list.output.stashes.length, 1);
  assert.equal(list.output.stashes[0].message, "wip");
});

test("git.blame refuses a traversing path", async (t) => {
  const repo = initRepo(t);
  const r = await call("git.blame", { path: "../../etc/passwd" }, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.ERROR);
});

test("a READ-only grant cannot run a WRITE git tool", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  const r = await call("git.stage", { files: ["a.txt"] }, { agent: agentWith(["read"]), workspaceRoot: repo });
  assert.equal(r.outcome, OUTCOME.DENIED);
  // And nothing was staged: the change is still only in the worktree.
  assert.match(git(repo, ["status", "--porcelain"]), /^ M a\.txt/m);
});

test("git tools fail cleanly outside a repository", async (t) => {
  // A temp directory that is not a repo (initRepo's parent, but a sibling).
  const repo = initRepo(t);
  const notRepo = `${repo}-not-repo`;
  const fs = await import("node:fs");
  fs.mkdirSync(notRepo, { recursive: true });
  t.after(() => fs.rmSync(notRepo, { recursive: true, force: true }));
  const r = await call("git.status", {}, { agent: agentWith(["read"]), workspaceRoot: notRepo });
  assert.equal(r.outcome, OUTCOME.ERROR);
});
