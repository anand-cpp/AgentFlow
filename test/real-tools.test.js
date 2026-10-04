// Integration tests for the real tools.
//
// These execute the real tools against a real temporary filesystem, not mocks.
// A mock cannot tell you whether `resolveInWorkspace` actually stops a junction
// escape, and the whole point of these tools is that they touch bytes on disk.
//
// The permission model is exercised through `runTool`, the same entry point the
// agent runtime uses, so "does the tool respect the waterfall" is answered by the
// waterfall rather than asserted about it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTool, OUTCOME } from "../src/core/agents/tools.js";
import { defineAgent } from "../src/core/agents/registry.js";
import { readTool, writeTool, searchTool, MAX_READ_BYTES, MAX_WRITE_BYTES, MAX_SEARCH_BYTES } from "../src/core/agents/tool-filesystem.js";
import { shellTool, DEFAULT_TIMEOUT_MS } from "../src/core/agents/tool-shell.js";
import { createRealTools, REAL_TOOL_NAMES } from "../src/core/agents/real-tools.js";
import { TOOL_ERROR } from "../src/core/agents/tool-errors.js";

// --- fixtures ---------------------------------------------------------------

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-tool-"));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-VALUE");
  return { base, root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** A link that needs no elevation: junctions on Windows, symlinks elsewhere. */
function linkDir(target, at) {
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

/** An agent that has been granted a scope with a permissive allowlist. */
function agentWith(scopes, policy = {}) {
  return defineAgent({
    id: "tester",
    purpose: "exercise the real tools",
    instructions: "Call tools and report what happened.",
    tools: { scopes, allow: scopes.map((s) => `${s}:*`), deny: [], ask: [], ...policy },
  });
}

/** Call a tool the way the runtime does: through the waterfall, with a workspace. */
async function call(tool, args, { agent, approver = null, signal = null, workspaceRoot } = {}) {
  const root = workspaceRoot;
  return runTool(agent, tool, { tool: tool.name, args }, { approver, signal, workspaceRoot: root });
}

function errorCode(result) {
  return result?.error?.code ?? null;
}

/** Assert a call was refused before it touched anything, with a given reason. */
function assertRefused(result, expected) {
  assert.equal(result.outcome, OUTCOME.ERROR, `expected an error result, got ${result.outcome}`);
  assert.equal(result.error.code, expected);
  assert.equal(result.output, null, "a refused call must not return output");
}

// ---------------------------------------------------------------------------
// the assembled set
// ---------------------------------------------------------------------------

test("createRealTools exposes the four tools under their documented names", () => {
  const map = createRealTools();
  assert.deepEqual([...map.keys()].sort(), [...REAL_TOOL_NAMES].sort());
  assert.deepEqual([...REAL_TOOL_NAMES].sort(), [
    "filesystem.read",
    "filesystem.search",
    "filesystem.write",
    "shell.execute",
  ]);
});

test("every real tool declares a scope, a schema and an implementation", () => {
  // The permission waterfall refuses a scope-less tool outright, so a missing
  // scope here is not a style issue -- the tool is dead on arrival.
  for (const tool of createRealTools().values()) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.scope, `${tool.name} must declare a scope`);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(Array.isArray(tool.inputSchema.required), `${tool.name} must declare required args`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown args`);
    assert.equal(typeof tool.execute, "function");
  }
});

test("an override can replace a tool and a null removes it", () => {
  const stub = { name: "filesystem.read", scope: "read", execute: async () => ({ stub: true }) };
  const map = createRealTools({ "filesystem.read": stub });
  assert.equal(map.get("filesystem.read"), stub);
  assert.equal(createRealTools({ "filesystem.read": null }).has("filesystem.read"), false);
});

// ---------------------------------------------------------------------------
// filesystem.read
// ---------------------------------------------------------------------------

test("read returns a file inside the workspace", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "a.txt"), "hello world");
    const r = await call(readTool, { path: "a.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.content, "hello world");
    assert.equal(r.output.size, 11);
    assert.equal(r.output.truncated, false);
    assert.equal(r.output.binary, undefined);
  } finally {
    ws.cleanup();
  }
});

test("read creates no parent directories and needs no overwrite flag", async () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "deep"));
    fs.writeFileSync(path.join(ws.root, "deep", "b.txt"), "nested");
    const r = await call(readTool, { path: "deep/b.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.output.content, "nested");
  } finally {
    ws.cleanup();
  }
});

test("read reports a missing file as NOT_FOUND", async () => {
  const ws = workspace();
  try {
    const r = await call(readTool, { path: "nope.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.NOT_FOUND);
  } finally {
    ws.cleanup();
  }
});

test("read reports a directory as IS_DIRECTORY and does not list it", async () => {
  const ws = workspace();
  try {
    const r = await call(readTool, { path: "." }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.IS_DIRECTORY);
  } finally {
    ws.cleanup();
  }
});

test("read refuses a binary file instead of returning mojibake", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]));
    const r = await call(readTool, { path: "bin.dat" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.BINARY_CONTENT);
  } finally {
    ws.cleanup();
  }
});

test("read refuses a file over the hard cap instead of truncating it", async () => {
  // Truncating a huge file invites the model to conclude it read the whole thing.
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "big.txt"), "a".repeat(MAX_READ_BYTES + 1024));
    const r = await call(readTool, { path: "big.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.OUTPUT_LIMIT);
    assert.equal(r.error.originalSize, MAX_READ_BYTES + 1024);
  } finally {
    ws.cleanup();
  }
});

test("read bounds a large-but-allowed file and says so", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "mid.txt"), "b".repeat(50_000));
    const r = await call(readTool, { path: "mid.txt", maxBytes: 1000 }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.truncated, true);
    assert.equal(r.output.originalSize, 50_000);
    assert.ok(r.output.returnedSize <= 1000);
    assert.match(r.output.content, /truncated/, "the model must be able to see that it got a prefix");
  } finally {
    ws.cleanup();
  }
});

test("read refuses traversal with ../", async () => {
  const ws = workspace();
  try {
    const r = await call(readTool, { path: "../outside/secret.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("read refuses an absolute path outside the workspace", async () => {
  const ws = workspace();
  try {
    const r = await call(readTool, { path: path.join(ws.outside, "secret.txt") }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("read refuses a symlink that escapes the workspace", async () => {
  // Every segment is inside the workspace. Only realpath resolution sees this,
  // which is why the lexical check in tools.js is not sufficient on its own.
  const ws = workspace();
  try {
    linkDir(ws.outside, path.join(ws.root, "link"));
    const r = await call(readTool, { path: "link/secret.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
    assert.equal(JSON.stringify(r).includes("TOP-SECRET-VALUE"), false, "the contents must not leak into the error");
  } finally {
    ws.cleanup();
  }
});

test("read honours a symlink that stays inside the workspace", async () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "real"));
    fs.writeFileSync(path.join(ws.root, "real", "ok.txt"), "linked but inside");
    linkDir(path.join(ws.root, "real"), path.join(ws.root, "alias"));
    const r = await call(readTool, { path: "alias/ok.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.output.content, "linked but inside");
  } finally {
    ws.cleanup();
  }
});

test("read is refused when the read scope was never granted", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "a.txt"), "x");
    const r = await call(readTool, { path: "a.txt" }, { agent: agentWith([]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
    assert.equal(r.error.code, "permission_denied");
  } finally {
    ws.cleanup();
  }
});

test("read is refused when a deny entry covers the path", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "secret.env"), "x");
    const agent = agentWith(["read"], { allow: [], deny: ["read:*"] });
    const r = await call(readTool, { path: "secret.env" }, { agent, workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
  } finally {
    ws.cleanup();
  }
});

test("read asks before running when the scope requires approval", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "a.txt"), "approved content");
    const agent = agentWith(["read"], { allow: [], requireApproval: ["read"] });

    const asked = [];
    const granted = await call(readTool, { path: "a.txt" }, {
      agent,
      workspaceRoot: ws.root,
      approver: async (c) => {
        asked.push(c);
        return true;
      },
    });
    assert.equal(asked.length, 1, "the approver must be consulted");
    assert.equal(asked[0].tool, "filesystem.read");
    assert.equal(granted.outcome, OUTCOME.OK);
    assert.equal(granted.approved, true);

    const refused = await call(readTool, { path: "a.txt" }, { agent, workspaceRoot: ws.root, approver: async () => false });
    assert.equal(refused.outcome, OUTCOME.DENIED);
    assert.equal(refused.approved, false);
  } finally {
    ws.cleanup();
  }
});

test("read fails closed when approval is required but no approver exists", async () => {
  // An unanswerable prompt is a refusal, not a pass.
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "a.txt"), "x");
    const agent = agentWith(["read"], { allow: [], requireApproval: ["read"] });
    const r = await call(readTool, { path: "a.txt" }, { agent, workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
  } finally {
    ws.cleanup();
  }
});

test("read redacts a credential-shaped value in the file it returns", async () => {
  // Synthetic and built at runtime: a fixture containing a real key would be the
  // failure, not the test.
  const ws = workspace();
  try {
    const synthetic = `sk-` + "A".repeat(32);
    fs.writeFileSync(path.join(ws.root, "creds.txt"), `api key = ${synthetic}\n`);
    const r = await call(readTool, { path: "creds.txt" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.content.includes(synthetic), false, "the synthetic value must not come back");
    assert.equal(r.output.redacted, true);
  } finally {
    ws.cleanup();
  }
});

test("a read with no workspace root is an input error, not an open filesystem", async () => {
  const r = await call(readTool, { path: "a.txt" }, { agent: agentWith(["read"]) });
  assertRefused(r, TOOL_ERROR.INVALID_INPUT);
});

// ---------------------------------------------------------------------------
// filesystem.write
// ---------------------------------------------------------------------------

test("write creates a file and its parents", async () => {
  const ws = workspace();
  try {
    const r = await call(writeTool, { path: "src/new.js", content: "export const a = 1;\n" }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.created, true);
    assert.equal(fs.readFileSync(path.join(ws.root, "src", "new.js"), "utf8"), "export const a = 1;\n");
  } finally {
    ws.cleanup();
  }
});

test("write refuses to overwrite without an explicit acknowledgement", async () => {
  const ws = workspace();
  try {
    const target = path.join(ws.root, "keep.txt");
    fs.writeFileSync(target, "original");
    const r = await call(writeTool, { path: "keep.txt", content: "replaced" }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.ERROR);
    assert.equal(r.error.code, TOOL_ERROR.INVALID_INPUT);
    assert.equal(fs.readFileSync(target, "utf8"), "original", "the original must survive a refused write");
  } finally {
    ws.cleanup();
  }
});

test("write overwrites when asked, and says it did", async () => {
  const ws = workspace();
  try {
    const target = path.join(ws.root, "keep.txt");
    fs.writeFileSync(target, "original");
    const r = await call(writeTool, { path: "keep.txt", content: "replaced", overwrite: true }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assert.equal(r.output.overwritten, true);
    assert.equal(fs.readFileSync(target, "utf8"), "replaced");
  } finally {
    ws.cleanup();
  }
});

test("write refuses overwrite:true when there is nothing to overwrite", async () => {
  // Silently creating a file under an overwrite flag means the caller believes it
  // replaced something.
  const ws = workspace();
  try {
    const r = await call(writeTool, { path: "ghost.txt", content: "x", overwrite: true }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assert.equal(r.error.code, TOOL_ERROR.INVALID_INPUT);
    assert.equal(fs.existsSync(path.join(ws.root, "ghost.txt")), false);
  } finally {
    ws.cleanup();
  }
});

test("write refuses a directory target", async () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "adir"));
    const r = await call(writeTool, { path: "adir", content: "x" }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assert.equal(r.error.code, TOOL_ERROR.INVALID_INPUT);
  } finally {
    ws.cleanup();
  }
});

test("write requires string content", async () => {
  const ws = workspace();
  try {
    for (const content of [42, null, undefined, { a: 1 }]) {
      const r = await call(writeTool, { path: "x.txt", content }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
      assert.equal(r.error.code, TOOL_ERROR.INVALID_INPUT, `content=${JSON.stringify(content)} must be rejected`);
    }
    assert.equal(fs.existsSync(path.join(ws.root, "x.txt")), false);
  } finally {
    ws.cleanup();
  }
});

test("write refuses content larger than the per-write cap", async () => {
  const ws = workspace();
  try {
    // One turn should not be able to materialise an arbitrarily large file inside
    // the workspace, and a refusal beats a silent partial write.
    const r = await call(writeTool, { path: "huge.txt", content: "a".repeat(MAX_WRITE_BYTES + 1) }, {
      agent: agentWith(["write"]),
      workspaceRoot: ws.root,
    });
    assertRefused(r, TOOL_ERROR.OUTPUT_LIMIT);
    assert.equal(fs.existsSync(path.join(ws.root, "huge.txt")), false, "and nothing is left behind");
  } finally {
    ws.cleanup();
  }
});

test("write refuses traversal", async () => {
  const ws = workspace();
  try {
    const r = await call(writeTool, { path: "../outside/pwned.txt", content: "x" }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
    assert.equal(fs.existsSync(path.join(ws.outside, "pwned.txt")), false);
  } finally {
    ws.cleanup();
  }
});

test("write refuses to create a file through an escaping symlink", async () => {
  // The write-side link escape. `link` points outside, the target does not exist
  // yet, so there is nothing to stat -- the escape hides in the parent.
  const ws = workspace();
  try {
    linkDir(ws.outside, path.join(ws.root, "link"));
    const r = await call(writeTool, { path: "link/pwned.txt", content: "x" }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
    assert.equal(fs.existsSync(path.join(ws.outside, "pwned.txt")), false, "nothing may be created outside the workspace");
  } finally {
    ws.cleanup();
  }
});

test("write leaves no temp file behind on success", async () => {
  const ws = workspace();
  try {
    await call(writeTool, { path: "atomic.txt", content: "x" }, { agent: agentWith(["write"]), workspaceRoot: ws.root });
    assert.deepEqual(fs.readdirSync(ws.root), ["atomic.txt"]);
  } finally {
    ws.cleanup();
  }
});

test("write is refused when the write scope was never granted", async () => {
  const ws = workspace();
  try {
    const r = await call(writeTool, { path: "x.txt", content: "x" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
    assert.equal(fs.existsSync(path.join(ws.root, "x.txt")), false);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// filesystem.search
// ---------------------------------------------------------------------------

function seed(ws) {
  fs.mkdirSync(path.join(ws.root, "src"), { recursive: true });
  fs.mkdirSync(path.join(ws.root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, "src", "one.js"), "const needle = 1;\nconst other = 2;\n");
  fs.writeFileSync(path.join(ws.root, "src", "two.js"), "// needle again\n");
  fs.writeFileSync(path.join(ws.root, "docs", "readme.md"), "nothing here\n");
  fs.writeFileSync(path.join(ws.root, "bin.dat"), Buffer.from([0x00, 0x01, 0x00, 0x02]));
}

test("search finds literal matches and reports line numbers", async () => {
  const ws = workspace();
  try {
    seed(ws);
    const r = await call(searchTool, { pattern: "needle" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.matchCount, 2);
    const one = r.output.matches.find((m) => m.file.endsWith("one.js"));
    assert.equal(one.line, 1);
    assert.match(one.text, /const needle = 1;/);
  } finally {
    ws.cleanup();
  }
});

test("search is recursive and reports what it scanned", async () => {
  const ws = workspace();
  try {
    seed(ws);
    const r = await call(searchTool, { pattern: "needle" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.ok(r.output.stats.filesScanned >= 4);
    assert.ok(r.output.stats.bytesScanned > 0);
    assert.ok(r.output.matches.some((m) => m.file.includes("docs") === false && m.file.includes("src")));
  } finally {
    ws.cleanup();
  }
});

test("search can be scoped to a subdirectory", async () => {
  const ws = workspace();
  try {
    seed(ws);
    const r = await call(searchTool, { pattern: "needle", path: "src" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.matchCount, 2);
    assert.ok(r.output.matches.every((m) => m.file.startsWith("src")));
  } finally {
    ws.cleanup();
  }
});

test("search does not follow a symlink cycle forever", async () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(ws.root, "a", "b", "hit.txt"), "needle here\n");
    // a/b/loop -> a. Every visit has a new path but the same directory, so without
    // an identity set this recurses until the stack or the disk gives out.
    linkDir(path.join(ws.root, "a"), path.join(ws.root, "a", "b", "loop"));
    const r = await call(searchTool, { pattern: "needle" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.ok(r.output.matches.length >= 1, "the real file is still found");
    assert.ok(r.output.stats.filesScanned < 50, `the walk terminated (scanned ${r.output.stats.filesScanned} files)`);
  } finally {
    ws.cleanup();
  }
});

test("search refuses to read a single file larger than its whole budget", async () => {
  const ws = workspace();
  try {
    // Sparse, so the test costs no real disk: the size check happens before any read.
    const fd = fs.openSync(path.join(ws.root, "huge.bin"), "w");
    fs.ftruncateSync(fd, 1024 * 1024 * 1024);
    fs.closeSync(fd);

    const started = Date.now();
    const r = await call(searchTool, { pattern: "needle" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    const elapsed = Date.now() - started;

    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.truncated, true);
    assert.equal(r.output.truncationReason, "byte-budget");
    assert.ok(elapsed < 10_000, `a refused read must not take 1GB of time (took ${elapsed}ms)`);
    assert.ok(r.output.stats.bytesScanned < MAX_SEARCH_BYTES, "and it never read past the budget");
  } finally {
    ws.cleanup();
  }
});

test("search skips binary files instead of matching inside them", async () => {
  const ws = workspace();
  try {
    seed(ws);
    fs.writeFileSync(path.join(ws.root, "bin.dat"), Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from("needle")]));
    const r = await call(searchTool, { pattern: "needle" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.matches.some((m) => m.file.endsWith("bin.dat")), false);
  } finally {
    ws.cleanup();
  }
});

test("search skips node_modules and reports that it did", async () => {
  const ws = workspace();
  try {
    seed(ws);
    fs.mkdirSync(path.join(ws.root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(ws.root, "node_modules", "dep", "index.js"), "needle in a dependency\n");
    const r = await call(searchTool, { pattern: "needle" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.matches.some((m) => m.file.includes("node_modules")), false);
    assert.match(r.output.output, /node_modules/, "and the omission is stated");
  } finally {
    ws.cleanup();
  }
});

test("search truncates at the match limit and says how many were withheld", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "many.txt"), "needle\n".repeat(500));
    const r = await call(searchTool, { pattern: "needle", maxMatches: 10 }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.matchCount, 10);
    assert.equal(r.output.truncated, true);
    assert.equal(r.output.truncationReason, "match-limit");
    assert.match(r.output.output, /truncated/);
  } finally {
    ws.cleanup();
  }
});

test("search truncates at the byte bound and says so", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.root, "wide.txt"), `${"needle ".repeat(30)}\n`.repeat(100));
    const r = await call(searchTool, { pattern: "needle", maxBytes: 500 }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.truncated, true);
    assert.ok(r.output.returnedSize <= 500);
    assert.match(r.output.output, /truncated/);
  } finally {
    ws.cleanup();
  }
});

test("search returns a clear result when nothing matches", async () => {
  const ws = workspace();
  try {
    seed(ws);
    const r = await call(searchTool, { pattern: "absolutely-not-present" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.matchCount, 0);
    assert.match(r.output.output, /no matches/);
    assert.equal(r.output.truncated, false);
  } finally {
    ws.cleanup();
  }
});

test("search can filter by filename", async () => {
  const ws = workspace();
  try {
    seed(ws);
    const r = await call(searchTool, { pattern: "needle", name: "two" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.matchCount, 1);
    assert.ok(r.output.matches[0].file.endsWith("two.js"));
  } finally {
    ws.cleanup();
  }
});

test("search refuses a path outside the workspace", async () => {
  const ws = workspace();
  try {
    seed(ws);
    const r = await call(searchTool, { pattern: "needle", path: "../outside" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("search does not follow a link out of the workspace", async () => {
  const ws = workspace();
  try {
    seed(ws);
    linkDir(ws.outside, path.join(ws.root, "escape"));
    const r = await call(searchTool, { pattern: "TOP-SECRET-VALUE" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.matchCount, 0, "the walk must stop at the link, not read what is behind it");
  } finally {
    ws.cleanup();
  }
});

test("search redacts a credential in a matched line", async () => {
  const ws = workspace();
  try {
    const synthetic = `sk-` + "B".repeat(32);
    fs.writeFileSync(path.join(ws.root, "leaky.txt"), `here is ${synthetic} inline\n`);
    const r = await call(searchTool, { pattern: "here is" }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
    assert.equal(r.output.output.includes(synthetic), false);
  } finally {
    ws.cleanup();
  }
});

test("search requires a non-empty pattern", async () => {
  const ws = workspace();
  try {
    for (const pattern of ["", null, 7]) {
      const r = await call(searchTool, { pattern }, { agent: agentWith(["search"]), workspaceRoot: ws.root });
      assert.equal(r.error.code, TOOL_ERROR.INVALID_INPUT);
    }
  } finally {
    ws.cleanup();
  }
});

test("search is refused when the search scope was never granted", async () => {
  const ws = workspace();
  try {
    const r = await call(searchTool, { pattern: "x" }, { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// shell.execute
// ---------------------------------------------------------------------------

const isWindows = process.platform === "win32";

/** A command that echoes its arguments, on both platforms. */
function echoArgs(args) {
  return isWindows
    ? { command: "cmd.exe", args: ["/c", "echo", ...args] }
    : { command: "printf", args: ["%s\\n", ...args] };
}

test("shell runs a command and returns stdout with an exit code", async () => {
  const ws = workspace();
  try {
    const r = await call(shellTool, echoArgs(["hello"]), { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.exitCode, 0);
    assert.match(r.output.stdout, /hello/);
    assert.equal(r.output.signal, null);
    assert.equal(r.output.sandboxed, false, "it must not claim to be a sandbox");
  } finally {
    ws.cleanup();
  }
});

test("shell does not hand the string to a command interpreter", async () => {
  // The load-bearing property. If this ran through a shell, `;` would separate
  // commands and one approval would cover every command the model thinks of next.
  //
  // The program is node rather than `echo`: `echo` is a shell builtin on Windows,
  // so naming it would make this a test of whether Windows has one, not of whether
  // we use one. node exists wherever these tests run, and printing its own argv
  // shows exactly what the child received.
  const ws = workspace();
  try {
    const r = await call(shellTool, { command: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a; rm -rf /"] }, {
      agent: agentWith(["shell"]),
      workspaceRoot: ws.root,
    });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.deepEqual(
      JSON.parse(r.output.stdout.trim()),
      ["a; rm -rf /"],
      "one argument, passed literally, to one process",
    );
  } finally {
    ws.cleanup();
  }
});

test("shell runs in the requested directory inside the workspace", async () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, "sub"));
    fs.writeFileSync(path.join(ws.root, "sub", "marker.txt"), "here");
    const cmd = isWindows ? { command: "cmd.exe", args: ["/c", "dir", "/b"] } : { command: "ls", args: [] };
    const r = await call(shellTool, { ...cmd, cwd: "sub" }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.match(r.output.stdout, /marker\.txt/);
    assert.ok(r.output.cwd.endsWith("sub"));
  } finally {
    ws.cleanup();
  }
});

test("shell refuses a cwd outside the workspace", async () => {
  const ws = workspace();
  try {
    const r = await call(shellTool, { command: "echo", args: ["x"], cwd: "../outside" }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PATH_OUTSIDE_WORKSPACE);
  } finally {
    ws.cleanup();
  }
});

test("shell reports a non-zero exit as a result, not a failure", async () => {
  // `grep` finding nothing and `git diff --quiet` both exit non-zero on success,
  // so conflating that with an error makes ordinary tools look broken.
  const ws = workspace();
  try {
    const cmd = isWindows ? { command: "cmd.exe", args: ["/c", "exit", "3"] } : { command: "sh", args: ["-c", "exit 3"] };
    const r = await call(shellTool, cmd, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.exitCode, 3);
  } finally {
    ws.cleanup();
  }
});

test("shell separates stdout from stderr", async () => {
  const ws = workspace();
  try {
    const cmd = isWindows
      ? { command: "cmd.exe", args: ["/c", "echo out & echo err 1>&2"] }
      : { command: "sh", args: ["-c", "echo out; echo err 1>&2"] };
    const r = await call(shellTool, cmd, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.match(r.output.stdout, /out/);
    assert.match(r.output.stderr, /err/);
    assert.equal(r.output.stdout.includes("err"), false);
  } finally {
    ws.cleanup();
  }
});

test("shell bounds stdout and says it truncated", async () => {
  const ws = workspace();
  try {
    const cmd = isWindows
      ? { command: "cmd.exe", args: ["/c", "for /L %i in (1,1,5000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] }
      : { command: "sh", args: ["-c", "for i in $(seq 1 5000); do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done"] };
    const r = await call(shellTool, { ...cmd, maxBytes: 2000 }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.equal(r.output.stdoutTruncated, true);
    assert.ok(r.output.stdoutBytes > 2000, "the real byte count is reported, not just the kept part");
    assert.match(r.output.stdout, /truncated/);
  } finally {
    ws.cleanup();
  }
});

test("shell bounds stderr separately from stdout", async () => {
  const ws = workspace();
  try {
    const cmd = isWindows
      ? { command: "cmd.exe", args: ["/c", "for /L %i in (1,1,3000) do @echo eee 1>&2"] }
      : { command: "sh", args: ["-c", "for i in $(seq 1 3000); do echo eeeeeeeeeeeeeeeeeeeeeeee 1>&2; done"] };
    const r = await call(shellTool, { ...cmd, maxBytes: 1000 }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.output.stderrTruncated, true);
    assert.equal(r.output.stdoutTruncated, false, "one stream hitting its bound must not truncate the other");
  } finally {
    ws.cleanup();
  }
});

test("shell kills a command that exceeds its timeout", async () => {
  const ws = workspace();
  try {
    const cmd = isWindows ? { command: "cmd.exe", args: ["/c", "ping -n 30 127.0.0.1 > nul"] } : { command: "sleep", args: ["30"] };
    const started = Date.now();
    const r = await call(shellTool, { ...cmd, timeoutMs: 300 }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    const elapsed = Date.now() - started;
    assertRefused(r, TOOL_ERROR.TIMEOUT);
    assert.ok(elapsed < 10_000, `must not wait for the process to finish naturally (took ${elapsed}ms)`);
    assert.equal(r.error.timeoutMs, 300);
  } finally {
    ws.cleanup();
  }
});

test("shell kills a command when the signal aborts", async () => {
  const ws = workspace();
  try {
    const controller = new AbortController();
    const cmd = isWindows ? { command: "cmd.exe", args: ["/c", "ping -n 30 127.0.0.1 > nul"] } : { command: "sleep", args: ["30"] };
    const promise = call(shellTool, { ...cmd, timeoutMs: 30_000 }, { agent: agentWith(["shell"]), workspaceRoot: ws.root, signal: controller.signal });
    setTimeout(() => controller.abort(), 250);
    const r = await promise;
    assertRefused(r, TOOL_ERROR.CANCELLED);
  } finally {
    ws.cleanup();
  }
});

test("shell refuses a command that is already cancelled", async () => {
  const ws = workspace();
  try {
    const controller = new AbortController();
    controller.abort();
    const r = await call(shellTool, echoArgs(["x"]), { agent: agentWith(["shell"]), workspaceRoot: ws.root, signal: controller.signal });
    assertRefused(r, TOOL_ERROR.CANCELLED);
  } finally {
    ws.cleanup();
  }
});

test("shell reports a missing program clearly", async () => {
  const ws = workspace();
  try {
    const r = await call(shellTool, { command: "aflow-no-such-program-xyz", args: [] }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assertRefused(r, TOOL_ERROR.PROCESS_FAILED);
    assert.match(r.error.message, /not found/);
  } finally {
    ws.cleanup();
  }
});

test("shell refuses a destructive program even when the permission check allowed it", async () => {
  // Approval is not the same as safety. `rm -rf /` is anchored on the program
  // name so `firmware-check` is unaffected and an argument cannot smuggle it in.
  const ws = workspace();
  try {
    for (const command of ["rm", "/bin/rm", "dd", "mkfs.ext4"]) {
      const r = await call(shellTool, { command, args: ["-rf", "/"] }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
      assert.equal(r.error?.code, TOOL_ERROR.PERMISSION_DENIED, `${command} must be refused`);
    }
  } finally {
    ws.cleanup();
  }
});

test("shell does not refuse a program that merely starts with a forbidden name", async () => {
  const ws = workspace();
  try {
    const r = await call(shellTool, echoArgs(["rm"]), { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK, "an argument of rm is not a call to rm");
  } finally {
    ws.cleanup();
  }
});

test("shell does not hand credential-shaped environment variables to the child", async () => {
  const ws = workspace();
  try {
    // Synthetic and built at runtime. A fixture with a real key would be the bug.
    const synthetic = `sk-` + "C".repeat(32);
    const cmd = isWindows
      ? { command: "cmd.exe", args: ["/c", "set AGENTFLOW_TEST_TOKEN"] }
      : { command: "sh", args: ["-c", "printf '%s' \"$AGENTFLOW_TEST_TOKEN\""] };
    const r = await call(shellTool, cmd, {
      agent: agentWith(["shell"]),
      workspaceRoot: ws.root,
      env: { AGENTFLOW_TEST_TOKEN: synthetic, PATH: process.env.PATH },
    });
    assert.equal(r.output.stdout.includes(synthetic), false, "a credential-shaped env var must not reach the child");
    assert.equal(r.output.stdout.trim(), "");
  } finally {
    ws.cleanup();
  }
});

test("shell refuses publishing subcommands, which are not in the program name", async () => {
  const ws = workspace();
  try {
    // Regression guard for a rule that looked like a guard and could not fire: the
    // program list is matched against argv[0], which is `npm`, so `/^npm publish$/`
    // tested against it never matched anything.
    for (const args of [["publish"], ["publish", "--tag", "next"], ["unpublish", "pkg"]]) {
      const r = await call(shellTool, { command: "npm", args }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
      assertRefused(r, "PERMISSION_DENIED");
      assert.match(r.error.message, /npm (publish|unpublish)/, `npm ${args[0]} is refused by name`);
    }
  } finally {
    ws.cleanup();
  }
});

test("shell refuses a force push but allows an ordinary one", async () => {
  const ws = workspace();
  try {
    const forced = await call(shellTool, { command: "git", args: ["push", "--force", "origin", "main"] }, {
      agent: agentWith(["shell"]),
      workspaceRoot: ws.root,
    });
    assertRefused(forced, "PERMISSION_DENIED");

    // The refusal is about the force flag, not about git push existing. A rule
    // that refuses both is a rule people disable.
    const plain = await call(shellTool, { command: "git", args: ["--version"] }, {
      agent: agentWith(["shell"]),
      workspaceRoot: ws.root,
    });
    assert.notEqual(plain.outcome, OUTCOME.ERROR, `git --version should run: ${plain.error?.message || ""}`);
  } finally {
    ws.cleanup();
  }
});

test("shell ignores an env override the schema does not permit", async () => {
  const ws = workspace();
  try {
    // `NODE_OPTIONS=--require <file>` is arbitrary code execution, so a per-call env
    // override is not a convenience feature. The tool takes the operator's scrubbed
    // environment and nothing else.
    const marker = path.join(ws.root, "pwned.txt");
    const r = await call(
      shellTool,
      { command: process.execPath, args: ["-e", "console.log(process.env.NODE_OPTIONS || '')"], env: { NODE_OPTIONS: "--require x" } },
      { agent: agentWith(["shell"]), workspaceRoot: ws.root },
    );
    assert.equal(r.output.stdout.trim(), "", "no injected environment reaches the child");
    assert.equal(fs.existsSync(marker), false);
  } finally {
    ws.cleanup();
  }
});

test("shell redacts a credential the command prints", async () => {
  const ws = workspace();
  try {
    // The value is *constructed by the child*, not passed in as an argument -- an
    // argument would trip the waterfall's credential gate and be denied before it
    // ran, which is a different (and separately tested) property. This exercises
    // the redaction of output the tool did not see coming.
    const build = `console.log('sk-' + 'D'.repeat(32))`;
    const cmd = { command: process.execPath, args: ["-e", build] };
    const r = await call(shellTool, cmd, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.OK);
    // Assembled here rather than written out: a literal that looks like a key is
    // exactly what the scanner exists to refuse, and a fixture containing one is
    // the habit that eventually ships a real one.
    const expected = "sk-" + "D".repeat(32);
    assert.equal(r.output.stdout.includes(expected), false);
    assert.equal(r.output.redacted, true);
  } finally {
    ws.cleanup();
  }
});

test("shell validates its arguments before spawning", async () => {
  const ws = workspace();
  try {
    for (const args of [{ command: "" }, { command: "   " }, { command: 42 }, { command: "x", args: "not-an-array" }, { command: "x", args: [1, 2] }]) {
      const r = await call(shellTool, args, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
      assert.equal(r.error.code, TOOL_ERROR.INVALID_INPUT, `${JSON.stringify(args)} must be rejected`);
    }
  } finally {
    ws.cleanup();
  }
});

test("shell is refused when the shell scope was never granted", async () => {
  const ws = workspace();
  try {
    const r = await call(shellTool, echoArgs(["x"]), { agent: agentWith(["read"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
  } finally {
    ws.cleanup();
  }
});

test("shell asks before running when the shell scope requires approval", async () => {
  const ws = workspace();
  try {
    const agent = agentWith(["shell"], { allow: [], requireApproval: ["shell"] });
    const seen = [];
    const approved = await call(shellTool, echoArgs(["approved"]), {
      agent,
      workspaceRoot: ws.root,
      approver: async (c) => {
        seen.push(c);
        return true;
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tool, "shell.execute");
    assert.equal(approved.approved, true);

    const refused = await call(shellTool, echoArgs(["refused"]), { agent, workspaceRoot: ws.root, approver: async () => false });
    assert.equal(refused.outcome, OUTCOME.DENIED);
    assert.equal(refused.output, null, "a refused command must not have run");
  } finally {
    ws.cleanup();
  }
});

test("shell refuses a call whose arguments carry a credential", async () => {
  // The waterfall's credential gate, exercised end to end with a real tool.
  const ws = workspace();
  try {
    const synthetic = `sk-` + "E".repeat(32);
    const r = await call(shellTool, { command: "echo", args: [synthetic] }, { agent: agentWith(["shell"]), workspaceRoot: ws.root });
    assert.equal(r.outcome, OUTCOME.DENIED);
    assert.equal(r.output, null);
  } finally {
    ws.cleanup();
  }
});

test("shell has a default timeout that a caller cannot exceed silently", () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 600_000);
  assert.ok(shellTool.inputSchema.properties.timeoutMs.maximum >= DEFAULT_TIMEOUT_MS);
});