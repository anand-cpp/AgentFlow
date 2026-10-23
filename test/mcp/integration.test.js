// MCP integration: the mock MCP server, driven end to end through the real
// config parser, manager, client and bridges.
//
// This is the wiring test that matters: a project with an `mcpServers` block
// becomes a spawned server whose tools, resources and prompts are reachable
// through `McpServerManager` — tool listing and calling, resource reading
// (text and base64), prompt expansion, tool-level errors, and graceful
// shutdown. Nothing here mocks the transport: JSON-RPC really crosses stdio.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServerManager } from "../../src/core/mcp/manager.js";
import { dispatchMcp, mcpCommand, mcpSlash } from "../../src/commands/mcp.js";
import { getMcpServers, parseMcpConfig } from "../../src/core/mcp/config.js";

const MOCK = path.resolve("test/mcp/fixtures/mock-mcp-server.js");

function project(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-mcp-int-"));
  fs.writeFileSync(path.join(dir, "mcp.json"), JSON.stringify(config));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function config(_dir) {
  return {
    mcpServers: {
      mock: { command: process.execPath, args: [MOCK] },
      broken: { command: "definitely-not-a-real-mcp-server" },
    },
  };
}

test("a running server's tools, resources and prompts are discoverable", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();

  const entry = manager.getServer("mock");
  assert.ok(entry, "the stdio server started");

  const tools = entry.tools.getTools();
  assert.equal(tools.length, 3);
  const fullNames = tools.map((tool) => tool.fullName);
  assert.deepEqual(fullNames.sort(), ["mcp__mock__calculator", "mcp__mock__echo", "mcp__mock__explode"]);
  // namespaced for the runtime, raw for the wire
  assert.ok(fullNames.every((name) => name.startsWith("mcp__mock__")));
  assert.ok(tools.every((tool) => typeof tool.inputSchema === "object"));

  await entry.resources.listResources();
  assert.equal(entry.resources.resources.size, 2);

  await entry.prompts.listPrompts();
  assert.equal(entry.prompts.prompts.size, 1);
});

test("calling a tool executes it and returns text content", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();

  const echo = await manager.getServer("mock").tools.callTool("mcp__mock__echo", { message: "hello" });
  assert.equal(echo.isError, false);
  assert.equal(echo.content[0].text, "echo: hello");

  const calc = await manager.getServer("mock").tools.callTool("mcp__mock__calculator", { a: 6, b: 7, op: "*" });
  assert.equal(calc.content[0].text, "result: 42");

  const catastrophic = manager.getServer("mock").tools.callTool("mcp__mock__echo", { message: "again" });
  await catastrophic.then(() => { throw new Error("should not reach"); }).catch(() => {});
  void catastrophic;
});

test("a tool-level error result carries isError and is surfaced", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();

  const res = await manager.getServer("mock").tools.callTool("mcp__mock__explode", {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /exploded/);
  // the error surface for the runtime is a thrown error, not a silent pass
  await assert.rejects(
    () => manager.getServer("mock").tools.callTool("mcp__mock__missing", {}),
    /unknown tool/,
  );
});

test("resources read as text and as base64 payloads", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();

  const entry = manager.getServer("mock").resources;
  const text = await entry.readResource("file://test.txt");
  assert.equal(text.contents[0].text, "hello from the mock resource");

  const binary = await entry.readResource("file://blob.bin");
  assert.equal(binary.contents[0].blob, "AAECAwQ=");
  const decoded = Buffer.from(binary.contents[0].blob, "base64");
  assert.equal(decoded.length, 5);

  await assert.rejects(() => entry.readResource("file://unknown.txt"), /unknown resource/);
});

test("prompts expand into role/content message lists", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();

  const prompt = await manager.getServer("mock").prompts.getPrompt("review", { code: "1+1" });
  assert.equal(prompt.messages.length, 1);
  assert.equal(prompt.messages[0].role, "user");
  assert.match(prompt.messages[0].content.text, /Review this code/);
  assert.match(prompt.messages[0].content.text, /1\+1/);
});

test("a broken server does not stop the healthy ones", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();

  assert.ok(manager.getServer("mock"), "the healthy server still runs");
  assert.equal(manager.getServer("broken").status, "failed", "the broken server is isolated, not fatal");
  assert.match(manager.getServer("broken").error, /spawne|spawn/);
  // the aggregate still sees the healthy server's tools
  assert.ok(manager.getAllTools().length >= 3);
});

test("graceful shutdown runs the client's close path", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  await manager.startAll();
  const client = manager.getServer("mock").client;
  await manager.stopAll();
  assert.equal(client.connected, false, "the client dropped its transport");
});

test("ping answers across a full stdio session", async (t) => {
  const dir = project(t, config());
  const manager = new McpServerManager({ root: dir });
  t.after(() => manager.stopAll());
  await manager.startAll();
  const client = manager.getServer("mock").client;
  await client.ping(); // resolves: the round trip works
  assert.ok(true);
});

test("the mcp command reports the configured servers over the CLI", async (t) => {
  const dir = project(t, config());
  const result = await dispatchMcp(dir, ["status"]);
  assert.equal(result.ok, true);
  assert.match(result.text, /mock/);
  assert.ok(result.data.servers.some((s) => s.name === "mock"));

  const tools = await dispatchMcp(dir, ["tools"]);
  assert.equal(tools.ok, true);
  assert.match(tools.text, /mcp__mock__echo/);

  const call = await dispatchMcp(dir, ["call", "mock", "echo", '{"message":"hi there"}']);
  assert.equal(call.ok, true);
  assert.match(call.text, /echo: hi there/);

  const read = await dispatchMcp(dir, ["read", "mock", "file://test.txt"]);
  assert.equal(read.ok, true);
  assert.match(read.text, /hello from the mock resource/);

  const badTool = await dispatchMcp(dir, ["call", "mock", "explode", "{}"]);
  assert.equal(badTool.ok, false);
  assert.match(badTool.text, /exploded/);
});

test("the mcp command and slash surface usage errors the same way", async (t) => {
  const dir = project(t, config());
  const unknown = await dispatchMcp(dir, ["frobnicate"]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.data.error, /unknown subcommand/);

  const noArgs = await dispatchMcp(dir, ["call", "mock"]);
  assert.equal(noArgs.ok, false);
  assert.match(noArgs.data.error, /missing arguments/);

  const slash = await mcpSlash("tools", { root: dir });
  assert.match(slash, /mcp__mock__echo/);
});

test("mcpCommand runs subcommands with injected deps", async (t) => {
  const dir = project(t, config());
  /** @type {any} */
  let captured = null;
  const out = { init: async (data) => { captured = data; } };
  const code = await mcpCommand.run({ args: ["tools"], flags: { project: dir }, out });
  assert.equal(code, 0);
  assert.ok(captured.tools.some((tool) => tool.fullName === "mcp__mock__echo"));
});

test("parseMcpConfig reads the mcpServers block", async (t) => {
  const dir = project(t, config());
  const parsed = parseMcpConfig(dir);
  assert.equal(typeof parsed.path, "string");
  assert.ok(parsed.servers.mock);
  assert.ok(parsed.servers.broken);
  const servers = getMcpServers(dir);
  assert.equal(servers.length, 2);
  assert.equal(servers[0].type, "stdio");
  assert.equal(servers[0].command, process.execPath);
});
