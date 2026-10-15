// Inline approval tests. Zero runtime deps, deterministic streams.
import test from "node:test";
import assert from "node:assert/strict";

import { setColor } from "../src/cli/ui.js";
import {
  classifyApproval,
  commandOf,
  pathOf,
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
