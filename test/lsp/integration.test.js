// LSP integration: the self-correction loop through the real runtime.
//
// This is the wiring test that matters -- a language server feeding diagnostics
// back into an agent run. It drives the actual AgentRuntime, the real bridge and
// the mock server, and asserts that a write the model makes shows up as errors
// in the model's next prompt.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAgent, AgentRegistry, TOOL_SCOPE } from "../../src/core/agents/registry.js";
import { AgentRuntime, STATE } from "../../src/core/agents/runtime.js";
import { LspClient } from "../../src/core/lsp/client.js";
import { LspDiagnosticsManager } from "../../src/core/lsp/diagnostics.js";
import { LspAgentBridge } from "../../src/core/lsp/agent-bridge.js";
import { LANGUAGE_SERVERS } from "../../src/core/lsp/registry.js";
import { lspCommand, dispatchLsp } from "../../src/commands/lsp.js";

const MOCK = path.resolve("test/lsp/fixtures/mock-ls.js");
const CATALOGUE = ["mock/model"];

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-lsp-int-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function bridgeFor(t, root) {
  const client = new LspClient({ server: { command: process.execPath, args: [MOCK] }, rootPath: root });
  await client.start();
  const diagnostics = new LspDiagnosticsManager(client);
  const bridge = new LspAgentBridge({ client, diagnostics, workspaceRoot: root, waitMs: 2000 });
  t.after(() => bridge.stop());
  return bridge;
}

function makeRuntime(bridge, complete, tools, root) {
  const spec = defineAgent({
    id: "coder",
    purpose: "write code",
    instructions: "You write files.",
    tools: { scopes: [TOOL_SCOPE.WRITE, TOOL_SCOPE.READ], allow: ["write:*"] },
  });
  return new AgentRuntime({
    registry: new AgentRegistry([spec]),
    tools,
    catalogue: CATALOGUE,
    complete,
    lspBridge: bridge,
    workspaceRoot: root,
  });
}

test("a write's diagnostics reach the model on the next turn", async (t) => {
  const root = workspace(t);
  const bridge = await bridgeFor(t, root);
  const file = path.join(root, "scratch.ts");

  const writeTool = {
    name: "filesystem.write",
    scope: TOOL_SCOPE.WRITE,
    execute: async (args) => {
      fs.writeFileSync(args.path, args.content);
      return { path: args.path };
    },
  };

  const prompts = [];
  const complete = async (_c, modelId, prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      return { model: modelId, toolCalls: [{ tool: "filesystem.write", args: { path: file, content: "const a = 1; // BAD\n" } }] };
    }
    return { model: modelId, text: "done" };
  };

  const rt = makeRuntime(bridge, complete, { "filesystem.write": writeTool }, root);
  const result = await rt.run({ agentId: "coder", task: "write scratch.ts" });

  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(bridge.getErrors().length, 1, "the server saw the error the write introduced");
  assert.match(prompts[1], /\[lsp\] recent language-server errors:/);
  assert.match(prompts[1], /scratch\.ts:1:17 found forbidden token BAD/);
});

test("a broken bridge never fails the write", async (t) => {
  const root = workspace(t);
  const file = path.join(root, "scratch.ts");
  const exploding = {
    active: true,
    root,
    afterWrite: async () => {
      throw new Error("server exploded");
    },
    renderPromptBlock: () => "",
    stop: async () => {},
  };

  const writeTool = {
    name: "filesystem.write",
    scope: TOOL_SCOPE.WRITE,
    execute: async (args) => {
      fs.writeFileSync(args.path, args.content);
      return { path: args.path };
    },
  };

  let calls = 0;
  const complete = async (_c, modelId) => {
    calls += 1;
    if (calls === 1) return { model: modelId, toolCalls: [{ tool: "filesystem.write", args: { path: file, content: "x" } }] };
    return { model: modelId, text: "done" };
  };

  const rt = makeRuntime(exploding, complete, { "filesystem.write": writeTool }, root);
  const result = await rt.run({ agentId: "coder", task: "write scratch.ts" });
  assert.equal(result.state, STATE.COMPLETED, "the write still succeeds when diagnostics explode");
});

test("the lsp command reports every registered server", async () => {
  /** @type {any} */
  let captured = null;
  const out = { init: async (data) => { captured = data; } };
  const code = await lspCommand.run({ args: ["status"], flags: {}, out });
  assert.equal(code, 0);
  assert.equal(captured.servers.length, LANGUAGE_SERVERS.length);
  assert.ok(captured.servers.every((s) => typeof s.installed === "boolean"));
});

test("an unknown lsp subcommand is a usage failure", async () => {
  const result = await dispatchLsp(process.cwd(), ["frobnicate"]);
  assert.equal(result.ok, false);
  assert.match(result.data.error, /unknown subcommand/);
});

