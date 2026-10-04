// Containment, bounding and the error contract.
//
// These are the two pieces every real tool depends on, and both exist to stop a
// specific mistake, so both are tested against that mistake rather than against
// their happy path.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveInWorkspace, isWithin, requireWorkspaceRoot } from "../src/core/agents/tool-paths.js";
import { boundText, boundOutput, boundList, enforceByteLimit } from "../src/core/agents/tool-bounds.js";
import { TOOL_ERROR, ToolInvocationError, fromSystemError } from "../src/core/agents/tool-errors.js";

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-ws-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");
  fs.writeFileSync(path.join(root, "file.txt"), "inside");
  return { base, root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/**
 * A directory link that does not need elevation.
 *
 * On Windows `symlinkSync` for a plain symlink needs admin or Developer Mode, so
 * a symlink-based escape test would silently skip on the platform most likely to
 * be running it. A junction needs neither and behaves the same for this purpose:
 * `link/x` resolves outside the tree while every segment of the requested path
 * stays inside it.
 */
function linkDir(target, at, type = process.platform === "win32" ? "junction" : "dir") {
  fs.symlinkSync(target, at, type);
}

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err?.code ?? `no code (${err?.name})`;
  }
}

// ---------------------------------------------------------------------------
// isWithin
// ---------------------------------------------------------------------------

test("isWithin accepts the root itself and its descendants", () => {
  const root = path.resolve(path.sep, "work", "project");
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(root, path.join(root, "a", "b.txt")), true);
});

test("isWithin rejects a sibling whose name merely starts with the root", () => {
  // The reason this is segment-based and not `startsWith`. A prefix test here is
  // the whole bug: `project-secrets` would satisfy an allowlist for `project`.
  const root = path.resolve(path.sep, "work", "project");
  assert.equal(isWithin(root, path.resolve(path.sep, "work", "project-secrets", "id_rsa")), false);
});

test("isWithin rejects traversal out of the root", () => {
  const root = path.resolve(path.sep, "work", "project");
  assert.equal(isWithin(root, path.resolve(root, "..", "elsewhere", "x")), false);
  assert.equal(isWithin(root, path.resolve(root, "a", "..", "..", "x")), false);
});

// ---------------------------------------------------------------------------
// resolveInWorkspace: lexical escapes
// ---------------------------------------------------------------------------

test("a relative path inside the workspace resolves", () => {
  const ws = workspace();
  try {
    const r = resolveInWorkspace(ws.root, "file.txt");
    assert.equal(fs.readFileSync(r.resolved, "utf8"), "inside");
  } finally {
    ws.cleanup();
  }
});

test("a nested relative path resolves", () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(ws.root, "src", "deep", "x.ts"), "x");
    const r = resolveInWorkspace(ws.root, "src/deep/x.ts");
    assert.ok(r.resolved.endsWith(path.join("src", "deep", "x.ts")));
  } finally {
    ws.cleanup();
  }
});

test("../ is refused, not silently normalised into the workspace", () => {
  // The naive-prefix trap. `root/../outside/secret.txt` still *starts with* the
  // root as a string, so a substring check would wave it through.
  const ws = workspace();
  try {
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, "../outside/secret.txt")), TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("a deeply nested traversal is refused", () => {
  const ws = workspace();
  try {
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, "a/b/../../../../outside/secret.txt")), TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("an absolute path pointing outside is refused", () => {
  // Spelling the path out fully must not be privileged.
  const ws = workspace();
  try {
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, path.join(ws.outside, "secret.txt"))), TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("an absolute path pointing inside is allowed", () => {
  const ws = workspace();
  try {
    const r = resolveInWorkspace(ws.root, path.join(ws.root, "file.txt"));
    assert.ok(fs.existsSync(r.resolved));
  } finally {
    ws.cleanup();
  }
});

test("an empty or non-string path is an input error, not an escape", () => {
  const ws = workspace();
  try {
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, "")), TOOL_ERROR.INVALID_INPUT);
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, "   ")), TOOL_ERROR.INVALID_INPUT);
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, 42)), TOOL_ERROR.INVALID_INPUT);
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, null)), TOOL_ERROR.INVALID_INPUT);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveInWorkspace: link escapes
// ---------------------------------------------------------------------------

test("a directory link out of the workspace is refused", () => {
  // Every segment of `link/secret.txt` is innocent. Only realpath sees the
  // escape, which is exactly why tools.js calls its own check insufficient.
  const ws = workspace();
  try {
    linkDir(ws.outside, path.join(ws.root, "link"));
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, "link/secret.txt")), TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("a link out of the workspace is refused for a file that does not exist yet", () => {
  // The write case. The target cannot be realpath-ed because it is not there, so
  // a naive implementation would skip the check -- and then create the file
  // outside the workspace. Resolving the nearest existing ancestor is what closes
  // this: `link` exists, and it points out.
  const ws = workspace();
  try {
    linkDir(ws.outside, path.join(ws.root, "link"));
    assert.equal(codeOf(() => resolveInWorkspace(ws.root, "link/newfile.txt")), TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
    assert.equal(fs.existsSync(path.join(ws.outside, "newfile.txt")), false, "nothing may be created outside");
  } finally {
    ws.cleanup();
  }
});

test("a link that stays inside the workspace is allowed", () => {
  // Containment is not a ban on links; it is a ban on leaving. A link to a
  // sibling directory inside the tree is a normal thing to have.
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "real"), { recursive: true });
    fs.writeFileSync(path.join(ws.root, "real", "ok.txt"), "fine");
    linkDir(path.join(ws.root, "real"), path.join(ws.root, "alias"));
    const r = resolveInWorkspace(ws.root, "alias/ok.txt");
    assert.equal(fs.readFileSync(r.resolved, "utf8"), "fine");
  } finally {
    ws.cleanup();
  }
});

test("a traversal that lands back inside is allowed", () => {
  // `..` is not forbidden, escaping is. Refusing the character would break every
  // legitimate `src/../test` a model writes.
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "a"), { recursive: true });
    fs.mkdirSync(path.join(ws.root, "b"), { recursive: true });
    fs.writeFileSync(path.join(ws.root, "b", "x"), "ok");
    const r = resolveInWorkspace(ws.root, "a/../b/x");
    assert.equal(fs.readFileSync(r.resolved, "utf8"), "ok");
  } finally {
    ws.cleanup();
  }
});

test("a missing workspace root is refused rather than assumed", () => {
  const ws = workspace();
  try {
    assert.equal(codeOf(() => resolveInWorkspace(path.join(ws.base, "nope"), "x")), TOOL_ERROR.INVALID_INPUT);
  } finally {
    ws.cleanup();
  }
});

test("a tool cannot choose its own workspace root", () => {
  // The root comes from the invocation, never from the call. A model that could
  // name it could name `/`.
  assert.equal(codeOf(() => requireWorkspaceRoot({})), TOOL_ERROR.INVALID_INPUT);
  assert.equal(codeOf(() => requireWorkspaceRoot({ workspaceRoot: "" })), TOOL_ERROR.INVALID_INPUT);
  assert.equal(requireWorkspaceRoot({ workspaceRoot: ws_abs }), ws_abs);
});
const ws_abs = path.resolve(path.sep, "work");

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

test("short output is returned untouched and reports no truncation", () => {
  const r = boundText("hello", 100);
  assert.equal(r.text, "hello");
  assert.equal(r.truncated, false);
  assert.equal(r.originalSize, 5);
  assert.equal(r.returnedSize, 5);
});

test("long output is cut and the cut is reported, never silent", () => {
  const r = boundText("x".repeat(500), 100);
  assert.equal(r.truncated, true);
  assert.equal(r.returnedSize, 100);
  assert.equal(r.originalSize, 500);
  assert.equal(r.limit, 100);
});

test("a cut never splits a multi-byte character", () => {
  // Truncating mid-sequence produces text that will not decode. The bound is on
  // bytes, so this is reachable by ordinary input, not a contrived one.
  const emoji = "😀".repeat(100); // 4 bytes each, and 2 UTF-16 code units each
  const r = boundText(emoji, 10); // 10 is not a multiple of 4
  assert.equal(Buffer.from(r.text, "utf8").toString("utf8"), r.text, "result must round-trip as valid utf8");
  // Two whole emoji fit in 8 bytes; a third would need 12. Counting code points
  // rather than code units because an astral character is two of the latter.
  assert.equal([...r.text].length, 2, "two whole emoji fit in 8 bytes");
  assert.equal(r.returnedSize, 8, "and the third is dropped whole rather than split");
});

test("a multi-byte string is measured in bytes, not characters", () => {
  const r = boundText("é".repeat(10), 5); // 2 bytes each, so 5 bytes holds 2 whole chars
  assert.equal(r.originalSize, 20);
  assert.equal(r.returnedSize, 4, "cut back to a whole character, keeping the fourth byte it can");
  assert.equal(r.truncated, true);
});

test("boundOutput appends a notice a model cannot miss", () => {
  const r = boundOutput("y".repeat(300), 50, { label: "stdout" });
  assert.match(r.text, /truncated/);
  assert.match(r.text, /stdout was 300 bytes/);
  assert.ok(r.notice, "a structured notice is returned too");
});

test("boundOutput applies redaction after bounding", () => {
  const r = boundOutput("token=abc123", 1000, { label: "x", redaction: (s) => s.replace(/abc\d+/, "[REDACTED]") });
  assert.match(r.text, /\[REDACTED\]/);
});

test("boundList stops at the item limit and says how many were withheld", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ n: i }));
  const r = boundList(items, { maxItems: 10, maxBytes: 1_000_000, render: (x) => `line ${x.n}` });
  assert.equal(r.returnedCount, 10);
  assert.equal(r.totalCount, 50);
  assert.equal(r.truncated, true);
});

test("boundList stops at the byte limit even when under the item limit", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ n: i }));
  const r = boundList(items, { maxItems: 1000, maxBytes: 100, render: (x) => `line ${x.n} padding padding` });
  assert.ok(r.returnedCount < 100);
  assert.ok(r.returnedSize <= 100);
  assert.equal(r.truncated, true);
});

test("enforceByteLimit refuses rather than truncating", () => {
  // Used where truncation is not an acceptable answer: returning the first 256KB
  // of a 400MB file invites the model to conclude it read the whole thing.
  assert.equal(codeOf(() => enforceByteLimit(10, 100)), null);
  assert.equal(codeOf(() => enforceByteLimit(200, 100)), TOOL_ERROR.OUTPUT_LIMIT);
  try {
    enforceByteLimit(200, 100, { label: "file" });
  } catch (err) {
    assert.equal(err.originalSize, 200);
    assert.equal(err.limit, 100);
  }
});

// ---------------------------------------------------------------------------
// error contract
// ---------------------------------------------------------------------------

test("a system ENOENT becomes NOT_FOUND", () => {
  const err = Object.assign(new Error("x"), { code: "ENOENT", path: "/tmp/a" });
  assert.equal(fromSystemError(err, "file").code, TOOL_ERROR.NOT_FOUND);
});

test("a system EISDIR becomes IS_DIRECTORY", () => {
  const err = Object.assign(new Error("x"), { code: "EISDIR", path: "/tmp/a" });
  assert.equal(fromSystemError(err, "path").code, TOOL_ERROR.IS_DIRECTORY);
});

test("an unknown system error stays generic rather than inventing a code", () => {
  // A specific wrong code stops the caller from looking, which is worse than an
  // honest INTERNAL_ERROR.
  const err = Object.assign(new Error("x"), { code: "ENOTTY" });
  assert.equal(fromSystemError(err, "file").code, TOOL_ERROR.INTERNAL_ERROR);
});

test("fromSystemError passes a tool error through unchanged", () => {
  const original = new ToolInvocationError(TOOL_ERROR.BINARY_CONTENT, "nope");
  assert.equal(fromSystemError(original), original);
});

test("an error message carries no file contents", () => {
  const ws = workspace();
  try {
    const err = fromSystemError(Object.assign(new Error("x"), { code: "ENOENT", path: path.join(ws.outside, "secret.txt") }));
    assert.equal(err.message.includes("not yours"), false);
  } finally {
    ws.cleanup();
  }
});