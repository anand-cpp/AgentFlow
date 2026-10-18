// `aflow doctor` gateway classification.
//
// The gateway is optional: AgentFlow talks to any OpenAI-compatible gateway
// and ships an in-repo daemon, but a machine that has not started it must not
// be told it has a problem. These tests pin the distinction between an offline
// daemon (informational) and a broken one (a real error).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { doctorCommand } from "../src/commands/doctor.js";

const detectServers = async () => [
  { id: "typescript", installed: true, language: "TypeScript / JavaScript", command: "typescript-language-server", args: [], path: "/bin/tsls", install: "" },
];

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-doctor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    baseUrl: "http://127.0.0.1:5000",
    probeTimeoutMs: 50,
    logPath: path.join(dir, "events.log"),
    logLevel: "error",
    defaultModel: null,
  };
  let captured = null;
  const out = {
    status() {},
    warn() {},
    error() {},
    init: async (summary, render) => {
      captured = { summary, text: render(summary) };
    },
  };
  const run = (ping, extra = {}) =>
    doctorCommand.run({ config, out, flags: {}, deps: { ping, detectServers, ...extra } });
  return { config, run, get: () => captured };
}

function gatewayCheck(summary) {
  return summary.checks.find((c) => c.name === "gateway");
}

test("offline gateway is informational, not an error", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({
    ok: false,
    elapsedMs: 2,
    code: "unreachable",
    error: "cannot reach gateway at http://127.0.0.1:5000",
  }));

  assert.equal(code, 0, "offline gateway must not fail the command");
  assert.equal(h.get().summary.gatewayStatus, "offline");
  assert.equal(gatewayCheck(h.get().summary).status, "offline");
  assert.match(gatewayCheck(h.get().summary).detail, /offline/);
  assert.doesNotMatch(h.get().text, /problem\(s\) found/);
});

test("a gateway timeout also reads as offline", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({
    ok: false,
    elapsedMs: 50,
    code: "timeout",
    error: "gateway timed out after 50ms",
  }));
  assert.equal(code, 0);
  assert.equal(h.get().summary.gatewayStatus, "offline");
});

test("an HTTP 5xx from a reachable gateway is a hard error", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({
    ok: false,
    elapsedMs: 5,
    code: "http_error",
    status: 503,
    error: "gateway returned 503",
  }));
  assert.equal(code, 1, "a broken gateway must fail the command");
  assert.equal(h.get().summary.gatewayStatus, "error");
  assert.match(h.get().text, /problem\(s\) found/);
});

test("a reachable gateway is ok", async (t) => {
  const h = harness(t);
  const code = await doctorCommand.run({
    config: h.config,
    out: {
      status() {},
      warn() {},
      error() {},
      init: async (summary) => {
        h.last = summary;
      },
    },
    flags: {},
    deps: {
      ping: async () => ({ ok: true, elapsedMs: 4 }),
      getVersion: async () => ({ currentVersion: "1.2.3" }),
      probeModel: async (_c, model) => ({ model, status: "ok", reachable: true, elapsedMs: 3 }),
      listModels: async () => [{ id: "a" }, { id: "b" }],
      detectServers,
    },
  });
  assert.equal(code, 0);
  assert.equal(h.last.gatewayStatus, "ok");
  assert.equal(gatewayCheck(h.last).status, "ok");
  assert.equal(h.last.catalogueCount, 2);
  assert.equal(h.last.reachable, 3);
});

test("language servers are reported without failing the command", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    detectServers: async () => [
      { id: "go", installed: true, language: "Go", command: "gopls", args: [], path: "/bin/gopls", install: "" },
    ],
  });
  const lsp = h.get().summary.checks.find((c) => c.name === "lsp");
  assert.equal(code, 0);
  assert.equal(lsp.status, "ok");
  assert.match(lsp.detail, /go/);
});

test("no language servers is informational, not an error", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), { detectServers: async () => [] });
  const lsp = h.get().summary.checks.find((c) => c.name === "lsp");
  assert.equal(code, 0);
  assert.equal(lsp.status, "unconfigured");
  assert.doesNotMatch(h.get().text, /problem\(s\) found/);
});

// --- mcp check ---------------------------------------------------------------

test("an mcp run without mcp.json is unconfigured, not an error", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mcpServers: async () => [],
  });
  const mcp = h.get().summary.checks.find((c) => c.name === "mcp");
  assert.equal(code, 0);
  assert.equal(mcp.status, "unconfigured");
  assert.doesNotMatch(h.get().text, /problem\(s\) found/);
});

test("configured stdio mcp servers resolve on PATH", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mcpServers: async () => [
      { name: "rtl", type: "stdio", command: "node" },
      { name: "remote", type: "sse", url: "http://localhost:8080/sse" },
    ],
  });
  const mcp = h.get().summary.checks.find((c) => c.name === "mcp");
  assert.equal(code, 0);
  assert.equal(mcp.status, "ok");
  assert.match(mcp.detail, /rtl, remote/);
});

test("an mcp server whose command is missing is informational, not an error", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mcpServers: async () => [{ name: "sqlite", type: "stdio", command: "definitely-not-a-real-command-9router" }],
  });
  const mcp = h.get().summary.checks.find((c) => c.name === "mcp");
  assert.equal(code, 0, "an absent MCP binary must never fail doctor");
  assert.equal(mcp.status, "info");
  assert.match(mcp.detail, /not found on PATH/);
  assert.doesNotMatch(h.get().text, /problem\(s\) found/);
});

test("the repo-map check reports a missing cache as info, never error", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mapFresh: () => ({ present: false, stale: true, ageMs: null, reason: null }),
  });
  const row = h.get().summary.checks.find((c) => c.name === "repo-map");
  assert.equal(code, 0, "an absent map cache must never fail doctor");
  assert.equal(row.status, "info");
  assert.match(row.detail, /not built yet/);
  assert.doesNotMatch(h.get().text, /problem\(s\) found/);
});

test("the repo-map check reports a fresh cache as ok", async (t) => {
  const h = harness(t);
  await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mapFresh: () => ({ present: true, stale: false, ageMs: 1500, reason: null }),
  });
  const row = h.get().summary.checks.find((c) => c.name === "repo-map");
  assert.equal(row.status, "ok");
  assert.match(row.detail, /fresh/);
});

test("a stale repo-map cache is informational and names the changed file", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mapFresh: () => ({ present: true, stale: true, ageMs: 90000, reason: "src/a.js" }),
  });
  const row = h.get().summary.checks.find((c) => c.name === "repo-map");
  assert.equal(code, 0, "a stale cache is not an error — it refreshes itself");
  assert.equal(row.status, "info");
  assert.match(row.detail, /stale/);
  assert.match(row.detail, /src\/a\.js/);
});

test("an unreadable cache state degrades to info", async (t) => {
  const h = harness(t);
  const code = await h.run(async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" }), {
    mapFresh: () => { throw new Error("disk exploded"); },
  });
  const row = h.get().summary.checks.find((c) => c.name === "repo-map");
  assert.equal(code, 0);
  assert.equal(row.status, "info");
  assert.match(row.detail, /rebuild on demand/);
});

// --- plugins -----------------------------------------------------------------
//
// Plugins are third-party code, so the check has exactly three honest answers:
// none found (unconfigured), all active (ok), or some that would not load
// (warn). It is never an error: a broken plugin costs the session whatever that
// plugin would have added, not the session.

const OFFLINE = async () => ({ ok: false, elapsedMs: 3, code: "unreachable", error: "offline" });

function pluginCheck(summary) {
  return summary.checks.find((c) => c.name === "plugins");
}

test("no plugins discovered is unconfigured, not a problem", async (t) => {
  const h = harness(t);
  const code = await h.run(OFFLINE, { pluginReport: async () => ({ plugins: [], stats: { loaded: [], problems: [] } }) });
  assert.equal(code, 0);
  assert.equal(pluginCheck(h.get().summary).status, "unconfigured");
  assert.doesNotMatch(h.get().text, /problem\(s\) found/);
});

test("active plugins are ok and their registrations are counted", async (t) => {
  const h = harness(t);
  await h.run(OFFLINE, {
    pluginReport: async () => ({
      plugins: [{ id: "greeter", status: "enabled" }, { id: "lurker", status: "disabled" }],
      stats: {
        loaded: [{ id: "greeter", tools: ["plugin__greeter__hi"], commands: ["greeter"], providers: [], contexts: [] }],
        problems: [],
      },
    }),
  });
  const row = pluginCheck(h.get().summary);
  assert.equal(row.status, "ok");
  assert.match(row.detail, /1 active, 1 disabled/);
  assert.match(row.detail, /2 registration/);
});

test("a plugin that will not load is a warning, and doctor still exits 0", async (t) => {
  const h = harness(t);
  const code = await h.run(OFFLINE, {
    pluginReport: async () => ({
      plugins: [{ id: "bad", status: "enabled" }],
      stats: { loaded: [], problems: [{ id: "bad", lines: ["bad: activate threw"] }] },
    }),
  });
  const row = pluginCheck(h.get().summary);
  assert.equal(code, 0, "a broken third-party plugin must never fail doctor");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /1 not loaded \(bad\)/);
  assert.match(row.detail, /activate threw/);
});

test("a plugin probe that throws is caught, not propagated", async (t) => {
  const h = harness(t);
  const code = await h.run(OFFLINE, {
    pluginReport: async () => { throw new Error("discovery exploded"); },
  });
  const row = pluginCheck(h.get().summary);
  assert.equal(code, 0);
  assert.equal(row.status, "warn");
  assert.match(row.detail, /plugin discovery failed/);
});
