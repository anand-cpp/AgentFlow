// Tests for `aflow setup` (provider wizard): check, export, reset modes and the
// live key probe. All network and terminal access is injected, so these run
// without keys, a terminal, or the network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runSetup } from "../../src/commands/setup.js";
import { defaultKeysFile, writeKeysFile } from "../../src/core/keys.js";

function capturingOut() {
  let result = null;
  let rendered = null;
  const out = {
    init: async (res, render) => {
      result = res;
      rendered = render ? render(res) : res;
    },
    get last() {
      return result;
    },
    get rendered() {
      return rendered;
    },
  };
  return out;
}

// Create a temp dir, point AGENTFLOW_KEYS_FILE at it, and clean up on test end.
function keysEnv(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-setup-"));
  const file = path.join(dir, "keys.env");
  const prev = process.env.AGENTFLOW_KEYS_FILE;
  process.env.AGENTFLOW_KEYS_FILE = file;
  t.after(() => {
    process.env.AGENTFLOW_KEYS_FILE = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

test("setup --check with no providers configured reports zero tested", async (t) => {
  const file = keysEnv(t);
  const out = capturingOut();
  const code = await runSetup({
    flags: { check: true },
    out,
    deps: { keysFile: file, fetchImpl: async () => ({ ok: false, status: 502 }) },
  });
  assert.equal(code, 0);
  assert.equal(out.last.tested, 0);
  assert.equal(out.last.failed, 0);
});

test("setup --test is an alias for --check", async (t) => {
  const file = keysEnv(t);
  const out = capturingOut();
  const code = await runSetup({
    flags: { test: true },
    out,
    deps: { keysFile: file },
  });
  assert.equal(code, 0);
  assert.equal(out.last.tested, 0);
});

test("setup --check tests a configured provider through an injected fetch", async (t) => {
  const file = keysEnv(t);
  writeKeysFile(file, { GROQ_API_KEY: "sk-test-123" });
  const out = capturingOut();
  let modelCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/models")) {
      modelCalls++;
      assert.ok(true, "provider probe issued");
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "mixtral-8x7b" }] }),
    };
  };
  const code = await runSetup({
    flags: { check: true },
    out,
    deps: { keysFile: file, fetchImpl },
  });
  assert.equal(code, 0);
  assert.equal(modelCalls, 1, "exactly one provider model listing was probed");
  const groq = out.last.rows.find((r) => r.name === "Groq");
  assert.equal(groq.status, "reachable");
  assert.equal(groq.detail, "connected");
});

test("setup --check reports a rejected key as unreachable", async (t) => {
  const file = keysEnv(t);
  writeKeysFile(file, { GROQ_API_KEY: "bad" });
  const out = capturingOut();
  const fetchImpl = async () => ({ ok: false, status: 401 });
  const code = await runSetup({
    flags: { check: true },
    out,
    deps: { keysFile: file, fetchImpl },
  });
  assert.equal(code, 1, "a failing key makes setup --check exit 1");
  const groq = out.last.rows.find((r) => r.name === "Groq");
  assert.equal(groq.status, "unreachable");
});

test("setup --export renders shell export commands", async (t) => {
  const file = keysEnv(t);
  writeKeysFile(file, { GROQ_API_KEY: "sk-abc", MISTRAL_API_KEY: "sk-def" });
  const out = capturingOut();
  const code = await runSetup({ flags: { export: true }, out, deps: { keysFile: file } });
  assert.equal(code, 0);
  const text = out.last.exports.join("\n");
  assert.match(text, /GROQ_API_KEY/);
  assert.match(text, /sk-abc/);
  assert.match(text, /MISTRAL_API_KEY/);
});

test("setup --reset on a missing keys file exits 1", async (t) => {
  const file = keysEnv(t);
  const out = capturingOut();
  const code = await runSetup({ flags: { reset: true, yes: true }, out, deps: { keysFile: file } });
  assert.equal(code, 1);
});

test("setup --reset removes the keys file when confirmed", async (t) => {
  const file = keysEnv(t);
  writeKeysFile(file, { GROQ_API_KEY: "sk-abc" });
  assert.ok(fs.existsSync(file));
  const out = capturingOut();
  const code = await runSetup({ flags: { reset: true, yes: true }, out, deps: { keysFile: file } });
  assert.equal(code, 0);
  assert.equal(fs.existsSync(file), false);
});

test("setup --check and --export cannot be combined", async (t) => {
  const file = keysEnv(t);
  const out = capturingOut();
  const code = await runSetup({ flags: { check: true, export: true }, out, deps: { keysFile: file } });
  assert.equal(code, 2);
});

test("defaultKeysFile honors AGENTFLOW_KEYS_FILE", () => {
  const file = path.join(os.tmpdir(), `aflow-keys-${process.pid}.env`);
  const prev = process.env.AGENTFLOW_KEYS_FILE;
  process.env.AGENTFLOW_KEYS_FILE = file;
  try {
    assert.equal(defaultKeysFile(), file);
  } finally {
    process.env.AGENTFLOW_KEYS_FILE = prev;
  }
});
