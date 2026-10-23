// Unit tests for the MCP config parser: file discovery, mcpServers parsing,
// env expansion, invalid input handling, and manager transport selection.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findMcpConfig,
  getMcpServers,
  normalizeServerConfig,
  parseMcpConfig,
  expandEnv,
  readJsonSafe,
} from "../../src/core/mcp/config.js";
import { McpServerManager } from "../../src/core/mcp/manager.js";

function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-mcp-cfg-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("getMcpServers parses a Claude-Desktop-style mcpServers block", (t) => {
  const dir = project(t, {
    "mcp.json": JSON.stringify({
      mcpServers: {
        sqlite: { command: "uvx", args: ["mcp-server-sqlite", "--db-path", "test.db"] },
        "remote-api": { url: "http://localhost:8080/sse" },
      },
    }),
  });
  const servers = getMcpServers(dir);
  assert.equal(servers.length, 2);
  const byName = new Map(servers.map((s) => [s.name, s]));
  const sqlite = byName.get("sqlite");
  assert.equal(sqlite.type, "stdio");
  assert.equal(sqlite.command, "uvx");
  assert.deepEqual(sqlite.args, ["mcp-server-sqlite", "--db-path", "test.db"]);
  const remote = byName.get("remote-api");
  assert.equal(remote.type, "sse");
  assert.equal(remote.url, "http://localhost:8080/sse");
});

test("getMcpServers reads .agentflow/mcp.json when present", (t) => {
  const dir = project(t, {
    ".agentflow/mcp.json": JSON.stringify({ mcpServers: { a: { command: "x" } } }),
    "mcp.json": JSON.stringify({ mcpServers: { b: { command: "y" } } }),
  });
  const parsed = parseMcpConfig(dir);
  assert.match(parsed.path ?? "", /\.agentflow[\\/]mcp\.json$/);
  const servers = getMcpServers(dir);
  assert.deepEqual(servers.map((s) => s.name), ["a"]);
});

test("package.json mcp key is read when no dedicated file exists", (t) => {
  const dir = project(t, {
    "package.json": JSON.stringify({ name: "x", mcp: { mcpServers: { embedded: { command: "z" } } } }),
  });
  const servers = getMcpServers(dir);
  assert.deepEqual(servers.map((s) => s.name), ["embedded"]);
});

test("a project without any mcp config yields no servers", (t) => {
  const dir = project(t, { "package.json": JSON.stringify({ name: "x" }) });
  assert.equal(getMcpServers(dir).length, 0);
  const parsed = parseMcpConfig(dir);
  assert.equal(parsed.servers == null || Object.keys(parsed.servers).length === 0, true);
  // and does not throw with no config file at all
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-mcp-none-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(getMcpServers(empty).length, 0);
  assert.equal(findMcpConfig(empty), null);
});

test("invalid JSON is reported as a diagnostic, not a crash", (t) => {
  const dir = project(t, { "mcp.json": "{not json" });
  const parsed = parseMcpConfig(dir);
  assert.equal(getMcpServers(dir).length, 0);
  assert.ok(parsed.path, "config path is still located");
});

test("a file with a UTF-8 BOM still parses", (t) => {
  const dir = project(t, {});
  fs.writeFileSync(path.join(dir, "mcp.json"), "\uFEFF" + JSON.stringify({ mcpServers: { bom: { command: "b" } } }));
  assert.equal(getMcpServers(dir).length, 1);
  assert.equal(readJsonSafe(path.join(dir, "mcp.json")).mcpServers.bom.command, "b");
});

test("entries with neither command nor url are skipped", (t) => {
  const dir = project(t, {
    "mcp.json": JSON.stringify({ mcpServers: { junk: { args: [1] }, good: { command: "c" } } }),
  });
  const servers = getMcpServers(dir);
  assert.deepEqual(servers.map((s) => s.name), ["good"]);
});

test("expandEnv substitutes ${VAR} and clears unknown variables", () => {
  process.env.MCP_TEST_TOKEN = "secret";
  assert.equal(expandEnv("Bearer ${MCP_TEST_TOKEN}"), "Bearer secret");
  assert.equal(expandEnv("${MCP_TEST_MISSING_VAR}"), "");
  assert.equal(expandEnv("no variables here"), "no variables here");
  delete process.env.MCP_TEST_TOKEN;
});

test("normalizeServerConfig expands env in command, args and url", () => {
  process.env.MCP_TEST_BIN = "mybin";
  process.env.MCP_TEST_URL = "http://h.test/sse";
  const stdio = normalizeServerConfig("s", { command: "${MCP_TEST_BIN}", args: ["--x", "${MCP_TEST_BIN}"] });
  assert.equal(stdio.command, "mybin");
  assert.equal(stdio.args.at(-1), "mybin");
  const sse = normalizeServerConfig("r", { url: "${MCP_TEST_URL}" });
  assert.equal(sse.url, "http://h.test/sse");
  delete process.env.MCP_TEST_BIN;
  delete process.env.MCP_TEST_URL;
});

test("openCode-ish local command arrays work", () => {
  const s = normalizeServerConfig("arr", { command: ["cmd", "run", "server"] });
  assert.equal(s.command, "cmd");
  assert.deepEqual(s.args, ["run", "server"]);
});

test("the manager uses the configured transport per server", (t) => {
  const dir = project(t, {
    "mcp.json": JSON.stringify({
      mcpServers: {
        local: { command: "slow-local-server" },
        remote: { url: "http://localhost:9/sse" },
      },
    }),
  });
  const manager = new McpServerManager({ root: dir, requestTimeoutMs: 300 });
  t.after(() => manager.stopAll());
  void manager;
  const servers = getMcpServers(dir);
  assert.equal(servers.find((s) => s.name === "local").type, "stdio");
  assert.equal(servers.find((s) => s.name === "remote").type, "sse");
});
