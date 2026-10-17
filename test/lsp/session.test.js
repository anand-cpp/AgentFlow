// End-to-end LSP session against the mock server.
//
// Exercises the real stack -- framing, process supervision, client handshake,
// diagnostics, the capability helpers and the agent bridge -- rather than a
// stub. The mock speaks the actual protocol, so a green run here means the
// layers agree on the wire, not just on their own interfaces.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LspClient, pathToUri, uriToPath, languageIdFor, LspRequestError } from "../../src/core/lsp/client.js";
import { LspDiagnosticsManager } from "../../src/core/lsp/diagnostics.js";
import { LspAgentBridge } from "../../src/core/lsp/agent-bridge.js";
import { getHover, getDefinition, getCompletions, getDocumentSymbols } from "../../src/core/lsp/capabilities.js";
import { createLspTools, registerLspTools, LSP_TOOL_NAMES } from "../../src/core/lsp/tools.js";
import { ToolInvocationError } from "../../src/core/agents/tool-errors.js";

const MOCK = path.resolve("test/lsp/fixtures/mock-ls.js");

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-lsp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeClient(root, opts = {}) {
  return new LspClient({ server: { command: process.execPath, args: [MOCK] }, rootPath: root, ...opts });
}

async function started(t, root) {
  const client = makeClient(root);
  await client.start();
  t.after(() => client.stop());
  return client;
}

test("pathToUri and uriToPath round-trip a Windows-style and posix path", () => {
  const p = path.join(process.cwd(), "src", "a b.ts");
  const uri = pathToUri(p);
  assert.match(uri, /^file:\/\/\//);
  assert.ok(!uri.includes("\\\\"));
  assert.equal(uriToPath(uri), p);
});

test("languageIdFor maps known extensions and defaults to plaintext", () => {
  assert.equal(languageIdFor("a.tsx"), "typescriptreact");
  assert.equal(languageIdFor("a.cpp"), "cpp");
  assert.equal(languageIdFor("a.weird"), "plaintext");
});

test("starts, negotiates capabilities and reports server info", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  assert.equal(client.initialized, true);
  assert.equal(client.serverInfo.name, "mock-ls");
  assert.equal(client.capabilities.hoverProvider, true);
  assert.equal(client.process.running, true);
});

test("didOpen publishes diagnostics that the manager collects", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  const diagnostics = new LspDiagnosticsManager(client);
  const file = path.join(root, "scratch.ts");
  fs.writeFileSync(file, "const a = 1; // BAD\n");

  const before = diagnostics.revisionOf(pathToUri(file));
  client.didOpen(file, fs.readFileSync(file, "utf8"));
  const list = await diagnostics.waitFor(pathToUri(file), { sinceRevision: before, timeoutMs: 2000 });

  assert.equal(list.length, 1);
  assert.equal(list[0].message, "found forbidden token BAD");
  assert.equal(list[0].file, file);
  assert.equal(list[0].range.start.line, 0);
  diagnostics.dispose();
});

test("capability helpers translate the wire shapes", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  const file = path.join(root, "scratch.ts");
  fs.writeFileSync(file, "const a = 1;\n");
  client.didOpen(file, "const a = 1;\n");

  assert.equal(await getHover(client, file, 0, 0), "**mock hover**");
  const defs = await getDefinition(client, file, 0, 0);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].file, file);
  const completions = await getCompletions(client, file, 0, 0);
  assert.equal(completions[0].label, "mockSymbol");
  const symbols = await getDocumentSymbols(client, file);
  assert.equal(symbols[0].name, "mockSymbol");
});

test("a request the server never answers times out with lsp_timeout", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  // The mock silently ignores $/cancelRequest, so this never gets a reply.
  await assert.rejects(
    () => client.request("$/cancelRequest", { id: 999 }, { timeoutMs: 60 }),
    (err) => err instanceof LspRequestError && err.code === "lsp_timeout",
  );
});

test("a request after stop is rejected as lsp_stopped", async (t) => {
  const root = workspace(t);
  const client = makeClient(root);
  await client.start();
  await client.stop();
  await assert.rejects(() => client.request("textDocument/hover", {}, { timeoutMs: 50 }), (err) => err instanceof LspRequestError && err.code === "lsp_stopped");
});

test("bridge refresh waits for a fresh analysis and renders a prompt block", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  const diagnostics = new LspDiagnosticsManager(client);
  const bridge = new LspAgentBridge({ client, diagnostics, workspaceRoot: root, waitMs: 2000 });

  const file = path.join(root, "scratch.ts");
  fs.writeFileSync(file, "const a = 1; // BAD\n");
  await bridge.afterWrite(file);

  assert.equal(bridge.getErrors().length, 1);
  const block = bridge.renderPromptBlock();
  assert.match(block, /\[lsp\] recent language-server errors:/);
  assert.match(block, /scratch\.ts:1:17 found forbidden token BAD/);
  assert.match(block, /Address these errors before continuing\./);

  // Fix the file: the block must clear once the server reports the clean state.
  fs.writeFileSync(file, "const a = 1;\n");
  await bridge.afterWrite(file);
  assert.equal(bridge.renderPromptBlock(), "");
  await bridge.stop();
});

test("renderPromptBlock is empty when there is nothing to report", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  const diagnostics = new LspDiagnosticsManager(client);
  const bridge = new LspAgentBridge({ client, diagnostics, workspaceRoot: root });
  assert.equal(bridge.renderPromptBlock(), "");
  await bridge.stop();
});

test("LSP tools answer questions and are confined to the workspace", async (t) => {
  const root = workspace(t);
  const client = await started(t, root);
  const diagnostics = new LspDiagnosticsManager(client);
  const bridge = new LspAgentBridge({ client, diagnostics, workspaceRoot: root, waitMs: 2000 });
  t.after(() => bridge.stop());

  const runtime = { tools: new Map(), lspBridge: bridge };
  const tools = registerLspTools(runtime);
  assert.deepEqual(tools.map((tool) => tool.name), LSP_TOOL_NAMES);

  const file = path.join(root, "scratch.ts");
  fs.writeFileSync(file, "const a = 1; // BAD\n");
  const ctx = { workspaceRoot: root };

  const status = await runtime.tools.get("lsp.status").execute({}, ctx);
  assert.equal(status.active, true);
  assert.equal(status.server, "mock-ls");

  const diag = await runtime.tools.get("lsp.diagnostics").execute({ path: "scratch.ts" }, ctx);
  assert.equal(diag.file, "scratch.ts");
  assert.equal(diag.count, 1);
  assert.equal(diag.diagnostics[0].line, 1);

  const hover = await runtime.tools.get("lsp.hover").execute({ path: "scratch.ts", line: 1, character: 1 }, ctx);
  assert.equal(hover.contents, "**mock hover**");

  const def = await runtime.tools.get("lsp.definition").execute({ path: "scratch.ts", line: 1, character: 1 }, ctx);
  assert.equal(def.count, 1);
  assert.equal(def.locations[0].file, "scratch.ts");

  await assert.rejects(
    () => runtime.tools.get("lsp.hover").execute({ path: "../escape.ts", line: 1, character: 1 }, ctx),
    (err) => err instanceof ToolInvocationError && err.code === "PATH_OUTSIDE_WORKSPACE",
  );
});

test("registerLspTools is a no-op set when no server is running", async (t) => {
  const root = workspace(t);
  const client = makeClient(root);
  const diagnostics = new LspDiagnosticsManager(client);
  const bridge = new LspAgentBridge({ client, diagnostics, workspaceRoot: root });
  const runtime = { tools: new Map(), lspBridge: bridge };
  const tools = registerLspTools(runtime);
  assert.deepEqual(tools.map((x) => x.name), LSP_TOOL_NAMES);
  assert.equal(bridge.active, false);
  const status = await runtime.tools.get("lsp.status").execute({}, { workspaceRoot: root });
  assert.equal(status.active, false);
  await assert.rejects(
    () => runtime.tools.get("lsp.diagnostics").execute({ path: "x.ts" }, { workspaceRoot: root }),
    (err) => err instanceof Error && /no language server/.test(err.message),
  );
  diagnostics.dispose();
});

test("stop shuts the server down so the process is no longer running", async (t) => {
  const root = workspace(t);
  const client = makeClient(root);
  await client.start();
  const proc = client.process;
  await client.stop();
  assert.equal(proc.running, false);
});

test("createLspTools and registerLspTools expose the same names", () => {
  const tools = createLspTools({ bridge: null });
  assert.deepEqual(tools.map((tool) => tool.name), LSP_TOOL_NAMES);
  const runtime = { tools: new Map() };
  registerLspTools(runtime);
  assert.deepEqual([...runtime.tools.keys()], LSP_TOOL_NAMES);
});

