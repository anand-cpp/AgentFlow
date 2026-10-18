// Runtime bridge: MCP tools reach and execute inside the real agent runtime.
//
// The namespacing contract is the whole story here: a tool discovered at
// `mcp__mock__echo` is registered on the runtime's tool map under that exact
// name, the model asks for it by that name, and the runtime's normal
// permission pipeline (scopes, allow entries, redaction) applies unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAgent, AgentRegistry, TOOL_SCOPE } from "../../src/core/agents/registry.js";
import { AgentRuntime, STATE } from "../../src/core/agents/runtime.js";
import { McpServerManager } from "../../src/core/mcp/manager.js";
import { McpAgentBridge, parseMcpToolName, isMcpToolName, contentToText } from "../../src/core/mcp/agent-bridge.js";

const MOCK = path.resolve("test/mcp/fixtures/mock-mcp-server.js");

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-mcp-rt-"));
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({ mcpServers: { mock: { command: process.execPath, args: [MOCK] } } }),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseMcpToolName splits server and tool parts", () => {
  assert.deepEqual(parseMcpToolName("mcp__mock__echo"), { server: "mock", tool: "echo" });
  assert.deepEqual(parseMcpToolName("mcp__my__long__name"), { server: "my", tool: "long__name" });
  assert.equal(parseMcpToolName("filesystem.read"), null);
  assert.equal(isMcpToolName("mcp__x__y"), true);
  assert.equal(isMcpToolName("fs.read"), false);
});

test("contentToText renders text, image and resource content blocks", () => {
  assert.equal(contentToText([{ type: "text", text: "a" }]), "a");
  assert.equal(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(contentToText([{ type: "image", mimeType: "image/png" }]), "[image: image/png]");
  assert.equal(contentToText([{ type: "resource", uri: "file://x" }]), "[resource: file://x]");
  assert.equal(contentToText("plain"), "plain");
  assert.equal(contentToText(null), "");
});

test("discovered MCP tools execute inside a real agent run", async (t) => {
  const root = project(t);
  const manager = new McpServerManager({ root });
  const bridge = new McpAgentBridge({ manager });
  t.after(() => bridge.stop());

  const tools = await bridge.discoverTools();
  assert.ok(tools.has("mcp__mock__echo"));
  assert.equal(tools.get("mcp__mock__echo").scope, TOOL_SCOPE.READ);

  const prompts = [];
  const complete = async (_c, modelId, prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      return {
        model: modelId,
        toolCalls: [{ tool: "mcp__mock__echo", args: { message: "through the runtime" } }],
      };
    }
    return { model: modelId, text: "done" };
  };

  const agent = defineAgent({
    id: "assistant",
    purpose: "use MCP tools",
    instructions: "You can call namespaced MCP tools.",
    tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] },
  });
  const runtime = new AgentRuntime({
    registry: new AgentRegistry([agent]),
    tools: new Map(),
    catalogue: ["mock/model"],
    complete,
    workspaceRoot: root,
  });
  bridge.registerTools(runtime);
  assert.ok(runtime.tools.has("mcp__mock__echo"), "the tool landed on the runtime's map");
  assert.ok(runtime.tools.has("mcp__mock__calculator"));

  const result = await runtime.run({ agentId: "assistant", task: "echo something" });
  assert.equal(result.state, STATE.COMPLETED);
  assert.equal(result.toolCalls, 1);
  // the tool result transcript entry carries the MCP output
  const echoEntry = result.toolResults.find((r) => r.tool === "mcp__mock__echo");
  assert.ok(echoEntry);
  assert.equal(echoEntry.outcome, "ok");
  assert.match(echoEntry.output?.text, /echo: through the runtime/);
  void tools;
});

test("a server failure is contained: the run reports it, not a crash", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-mcp-rt2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "mcp.json"),
    JSON.stringify({ mcpServers: { dead: { command: "definitely-not-a-real-mcp-server" } } }),
  );

  const manager = new McpServerManager({ root, requestTimeoutMs: 2000 });
  const bridge = new McpAgentBridge({ manager });
  t.after(() => bridge.stop());
  await bridge.refresh();

  const discovered = bridge._discovered ?? new Map();
  assert.equal(discovered.size, 0, "no tools from a dead server");

  const agent = defineAgent({
    id: "assistant",
    purpose: "attempt tools",
    instructions: "Try MCP tools.",
    tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] },
  });
  let calls = 0;
  const complete = async (_c, modelId) => {
    calls += 1;
    if (calls === 1) {
      return { model: modelId, toolCalls: [{ tool: "mcp__mock__echo", args: {} }] };
    }
    return { model: modelId, text: "gave up" };
  };
  const runtime = new AgentRuntime({
    registry: new AgentRegistry([agent]),
    tools: new Map(),
    catalogue: ["mock/model"],
    complete,
    workspaceRoot: root,
  });
  bridge.registerTools(runtime);

  const result = await runtime.run({ agentId: "assistant", task: "echo" });
  // "no such tool" stops the loop with an honest reason — the tool was never
  // registered because its server never came up.
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error?.code, "tool_denied");
  assert.match(result.error?.message, /no such tool: mcp__mock__echo/);
});
