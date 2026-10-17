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
