// Inline approval tests. Zero runtime deps, deterministic streams.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setColor } from "../src/cli/ui.js";
import {
  classifyApproval,
  commandOf,
  pathOf,
  workspaceReader,
  proposedWrite,
  computeDiff,
  renderDiff,
  renderApproval,
  interpretChoice,
  decideApproval,
  createApprover,
} from "../src/tui/approval.js";

setColor(false);

function makeLineInput(lines) {
  let i = 0;
  return {
    readLine: async () => {
      if (i >= lines.length) return null;
      return lines[i++];
    },
  };
}

test("interpretChoice maps keys", () => {
  assert.equal(interpretChoice("y"), "allow-once");
  assert.equal(interpretChoice("Y"), "allow-once");
  assert.equal(interpretChoice("a"), "allow-always");
  assert.equal(interpretChoice("always"), "allow-always");
  assert.equal(interpretChoice("n"), "deny");
  assert.equal(interpretChoice("no"), "deny");
  assert.equal(interpretChoice("d"), "diff");
  assert.equal(interpretChoice("  D  "), "diff");
  assert.equal(interpretChoice(""), "ignore");
  assert.equal(interpretChoice("x"), "ignore");
});

test("classifyApproval detects scope kinds", () => {
  assert.equal(classifyApproval({ scope: "shell" }), "shell");
  assert.equal(classifyApproval({ scope: "write" }), "write");
  assert.equal(classifyApproval({ scope: "search" }), "other");
  assert.equal(classifyApproval({}), "other");
});

test("commandOf extracts shell command", () => {
  assert.equal(commandOf({ args: { command: "git status" } }), "git status");
  assert.equal(commandOf({ args: { cmd: "npm test" } }), "npm test");
  assert.equal(commandOf({ args: {} }), "");
});

test("pathOf extracts write path", () => {
  assert.equal(pathOf({ args: { path: "src/foo.js" } }), "src/foo.js");
  assert.equal(pathOf({ args: { file: "README.md" } }), "README.md");
  assert.equal(pathOf({ args: {} }), "");
});

test("computeDiff produces add/del/ctx", () => {
  const diff = computeDiff("a\nb\n", "a\nc\n");
  assert.ok(diff.some((d) => d.type === "ctx" && d.text === "a"));
  assert.ok(diff.some((d) => d.type === "del" && d.text === "b"));
  assert.ok(diff.some((d) => d.type === "add" && d.text === "c"));
});

test("renderDiff bounds output", () => {
  const diff = computeDiff("", "1\n2\n3\n4\n5");
  const s = renderDiff(diff, { max: 2 });
  assert.ok(s.includes("1"));
  assert.ok(s.includes("more"));
});

test("renderApproval shows shell command", () => {
  const s = renderApproval({ tool: "shell.run", scope: "shell", args: { command: "rm -rf /" } }, { width: 60 });
  assert.ok(s.includes("shell.run"));
  assert.ok(s.includes("shell"));
  assert.ok(s.includes("$ rm -rf /"));
  assert.ok(s.includes("allow once"));
  assert.ok(s.includes("allow always"));
  assert.ok(s.includes("deny"));
  assert.ok(s.includes("diff"));
});

test("renderApproval shows diff when provided", () => {
  const diff = computeDiff("old", "new");
  const s = renderApproval({ tool: "fs.write", scope: "write", args: { path: "f.txt", oldText: "old", newText: "new" } }, { width: 60, diff });
  assert.ok(s.includes("fs.write"));
  assert.ok(s.includes("+ new"));
  assert.ok(s.includes("- old"));
});

test("decideApproval: non-interactive denies", async () => {
  const res = await decideApproval({ tool: "t", scope: "shell", args: { command: "echo hi" } }, { interactive: false });
  assert.deepEqual(res, { approved: false, remember: false, reason: "non-interactive" });
});

test("decideApproval: line-based allow once (y)", async () => {
  const io = makeLineInput(["y"]);
  const res = await decideApproval({ tool: "t", scope: "shell", args: {} }, { interactive: true, readLine: io.readLine });
  assert.equal(res.approved, true);
  assert.equal(res.remember, false);
  assert.equal(res.reason, "allow-once");
});

test("decideApproval: line-based allow always (a)", async () => {
  const io = makeLineInput(["a"]);
  const res = await decideApproval({ tool: "t", scope: "shell", args: {} }, { interactive: true, readLine: io.readLine });
  assert.equal(res.approved, true);
  assert.equal(res.remember, true);
  assert.equal(res.reason, "allow-always");
});

test("decideApproval: line-based deny (n)", async () => {
  const io = makeLineInput(["n"]);
  const res = await decideApproval({ tool: "t", scope: "write", args: {} }, { interactive: true, readLine: io.readLine });
  assert.equal(res.approved, false);
  assert.equal(res.remember, false);
  assert.equal(res.reason, "denied");
});

test("decideApproval: timeout denies", async () => {
  const io = { readLine: async () => new Promise(() => {}) }; // never resolves
  const res = await decideApproval({ tool: "t", scope: "shell", args: {} }, { interactive: true, readLine: io.readLine, timeoutMs: 10 });
  assert.equal(res.approved, false);
  assert.equal(res.remember, false);
  assert.ok(res.reason === "timeout" || res.reason === "timeout-or-eof");
});

test("decideApproval: EOF denies", async () => {
  const io = makeLineInput([]);
  const res = await decideApproval({ tool: "t", scope: "shell", args: {} }, { interactive: true, readLine: io.readLine, timeoutMs: 20 });
  assert.equal(res.approved, false);
  assert.equal(res.remember, false);
  assert.equal(res.reason, "timeout-or-eof");
});

test("decideApproval: 'd' toggles diff (loop continues)", async () => {
  const io = makeLineInput(["d", "y"]);
  const res = await decideApproval(
    { tool: "fs.write", scope: "write", args: { oldText: "x", newText: "y" } },
    { interactive: true, readLine: io.readLine, timeoutMs: 100 }
  );
  assert.equal(res.approved, true);
  assert.equal(res.remember, false);
});

test("createApprover remembers always", async () => {
  const always = new Set();
  const approver = createApprover({ interactive: false, always, keyOf: (r) => r.tool || "?" });
  const first = await approver({ tool: "shell.run", scope: "shell", args: { command: "echo" } });
  assert.equal(first, false); // non-interactive denies; does not remember
  // now feed a line-based allow-always
  const approver2 = createApprover({ interactive: true, readLine: makeLineInput(["a"]).readLine, keyOf: (r) => r.tool });
  const ok = await approver2({ tool: "shell.run", scope: "shell", args: {} });
  assert.equal(ok, true);
  // second call with same key returns true immediately (remembered)
  const ok2 = await approver2({ tool: "shell.run", scope: "shell", args: {} });
  assert.equal(ok2, true);
  // different tool still needs answer
  const approver3 = createApprover({ interactive: true, readLine: makeLineInput(["n"]).readLine, keyOf: (r) => r.tool });
  const no = await approver3({ tool: "fs.rm", scope: "write", args: {} });
  assert.equal(no, false);
});

test("proposedWrite derives oldText from an explicit oldText", () => {
  const rec = proposedWrite({ scope: "write", args: { path: "a.txt", oldText: "a", newText: "b" } });
  assert.equal(rec.path, "a.txt");
  assert.equal(rec.oldText, "a");
  assert.equal(rec.newText, "b");
  assert.equal(rec.isNew, false);
  assert.equal(rec.tracked, null);
});

test("proposedWrite reads the working-tree file through readFile", () => {
  const rec = proposedWrite(
    { scope: "write", args: { path: "a.txt", content: "new\n" } },
    { readFile: (p) => (p === "a.txt" ? "old\n" : undefined) }
  );
  assert.equal(rec.oldText, "old\n");
  assert.equal(rec.newText, "new\n");
  assert.equal(rec.isNew, false);
});

test("proposedWrite marks a missing file new and labels tracked/untracked", () => {
  const rec = proposedWrite(
    { scope: "write", args: { path: "fresh.txt", content: "hi\n" } },
    { readFile: () => null, isTracked: () => false }
  );
  assert.equal(rec.oldText, "");
  assert.equal(rec.isNew, true);
  assert.equal(rec.tracked, false);
});

test("proposedWrite returns null when the write cannot be diffed", () => {
  assert.equal(proposedWrite({ scope: "shell", args: { command: "ls" } }), null);
  assert.equal(proposedWrite({ scope: "write", args: { path: "a.txt" } }), null);
  assert.equal(
    proposedWrite({ scope: "write", args: { path: "a.txt", content: "x" } }, { readFile: () => undefined }),
    null
  );
});

test("workspaceReader reads inside the root, nulls a missing file, rejects escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-approval-"));
  try {
    fs.writeFileSync(path.join(root, "keep.txt"), "content\n");
    const read = workspaceReader(root);
    assert.equal(read("keep.txt"), "content\n");
    assert.equal(read("missing.txt"), null);
    assert.equal(read("../escape.txt"), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderApproval shows a write preview header and body", () => {
  const s = renderApproval(
    { tool: "fs.write", scope: "write", args: { path: "a.txt" } },
    { preview: { header: "a.txt  tracked file  +1 -1", body: "-old\n+new" } }
  );
  assert.ok(s.includes("tracked file"));
  assert.ok(s.includes("+new"));
});

test("decideApproval 'd' renders the write preview from disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-approval-"));
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "old\n");
    const out = { chunks: [], write(x) { this.chunks.push(String(x)); } };
    const io = makeLineInput(["d", "y"]);
    const res = await decideApproval(
      { tool: "fs.write", scope: "write", args: { path: "a.txt", content: "new\n" } },
      { interactive: true, readLine: io.readLine, output: /** @type {any} */ (out), workspaceRoot: root, timeoutMs: 200 }
    );
    assert.equal(res.approved, true);
    const text = out.chunks.join("");
    assert.ok(text.includes("working tree"));
    assert.ok(text.includes("+1 -1"));
    assert.ok(text.includes("new"));
    assert.ok(text.includes("old"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});