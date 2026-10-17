// History browsing: log, show, file history, blame.
//
// parseLog and parseBlame are pure and pinned with fixtures built the way git
// emits them (RS/NUL delimited), so a change to the format string that breaks
// round-tripping fails here rather than in a query.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRefs,
  parseLog,
  getLog,
  getCommit,
  getFileHistory,
  parseBlame,
  getBlame,
  searchLog,
} from "../../src/core/git/log.js";
import { initRepo, write, git, ctxFor } from "./helpers.js";

const RS = "\x1e";

function record({ hash, short, author = "Alice", email = "a@x.com", date = "2024-01-01T00:00:00Z", parents = "", refs = "", subject, body = "" }) {
  return [hash, short, author, email, date, parents, refs, subject, body].join("\x00");
}

test("parseRefs splits a decoration string", () => {
  assert.deepEqual(parseRefs("HEAD -> main, origin/main, tag: v1"), ["HEAD -> main", "origin/main", "tag: v1"]);
  assert.deepEqual(parseRefs(""), []);
});

test("parseLog reads RS/NUL records, including bodies with newlines", () => {
  const raw =
    record({ hash: "a".repeat(40), short: "aaaaaaa", parents: "b".repeat(40), refs: "HEAD -> main", subject: "feat: one", body: "line1\nline2" }) +
    RS +
    "\n" +
    record({ hash: "b".repeat(40), short: "bbbbbbb", subject: "feat: two" }) +
    RS;
  const commits = parseLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, "feat: one");
  assert.equal(commits[0].body, "line1\nline2");
  assert.deepEqual(commits[0].parents, ["b".repeat(40)]);
  assert.deepEqual(commits[0].refs, ["HEAD -> main"]);
  assert.equal(commits[1].subject, "feat: two");
  assert.deepEqual(commits[1].parents, []);
});

test("parseLog ignores blank records", () => {
  assert.deepEqual(parseLog(`${RS}\n${RS}`), []);
  assert.deepEqual(parseLog(""), []);
});

test("getLog returns structured commits for HEAD", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getLog(ctx, { limit: 10 });
  assert.equal(res.ok, true);
  assert.equal(res.text, null);
  assert.equal(res.commits.length, 1);
  assert.equal(res.commits[0].subject, "feat: initial commit");
  assert.match(res.commits[0].hash, /^[0-9a-f]{40}$/);
});

test("getLog raw mode returns text, not commits", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "feat: change"]);
  const ctx = await ctxFor(repo);
  const res = await getLog(ctx, { oneline: true });
  assert.equal(res.ok, true);
  assert.equal(res.commits.length, 0);
  assert.match(res.text, /feat: change/);
});

test("getLog validates a path filter", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getLog(ctx, { path: "../escape" });
  assert.equal(res.ok, false);
});

test("getCommit returns meta and a diff", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getCommit(ctx, "HEAD");
  assert.equal(res.ok, true);
  assert.equal(res.meta.subject, "feat: initial commit");
  assert.match(res.diff, /a\.txt/);
});

test("getFileHistory follows a file", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "second\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "feat: second"]);
  const ctx = await ctxFor(repo);
  const res = await getFileHistory(ctx, "a.txt");
  assert.equal(res.ok, true);
  assert.equal(res.commits.length, 2);
});

test("getFileHistory rejects a traversing path", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getFileHistory(ctx, "../../etc/passwd");
  assert.equal(res.ok, false);
});

test("searchLog greps commit messages", async (t) => {
  const repo = initRepo(t);
  write(repo, "a.txt", "changed\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "fix: squashed bug"]);
  const ctx = await ctxFor(repo);
  const res = await searchLog(ctx, "squashed");
  assert.equal(res.ok, true);
  assert.equal(res.commits.length, 1);
  assert.equal(res.commits[0].subject, "fix: squashed bug");
});

test("parseBlame reads porcelain entries and carries metadata forward", () => {
  const hash = "c".repeat(40);
  const raw = [
    `${hash} 1 1 1`,
    "author Alice",
    "author-mail <a@x.com>",
    "author-time 1700000000",
    "summary feat: initial",
    "\tline one",
    `${hash} 2 2`,
    "\tline two",
  ].join("\n");
  const entries = parseBlame(raw);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].content, "line one");
  assert.equal(entries[0].author, "Alice");
  assert.equal(entries[0].email, "a@x.com");
  assert.equal(entries[0].summary, "feat: initial");
  assert.equal(entries[1].content, "line two");
  // The second line reuses the cached author from the first.
  assert.equal(entries[1].author, "Alice");
  assert.equal(entries[1].line, 2);
});

test("getBlame annotates a real file", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getBlame(ctx, "a.txt");
  assert.equal(res.ok, true);
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].content, "hello");
  assert.equal(res.lines[0].author, "Test User");
});

test("getBlame rejects a traversing path", async (t) => {
  const repo = initRepo(t);
  const ctx = await ctxFor(repo);
  const res = await getBlame(ctx, "../a.txt");
  assert.equal(res.ok, false);
});
