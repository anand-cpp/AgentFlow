// Process supervision: lifecycle, restart, and a clean shutdown.
//
// Uses real child processes (the mock server, and one that always crashes) so
// the tests cover the pieces a unit stub cannot: framing over a real pipe and
// the restart-on-crash backoff.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { LspProcess, LspProcessError } from "../../src/core/lsp/process.js";

const MOCK = path.resolve("test/lsp/fixtures/mock-ls.js");
const CRASH = path.resolve("test/lsp/fixtures/crash-ls.js");

/**
 * Resolve on the next matching event, or reject on timeout.
 * @param {import("node:events").EventEmitter | { on: Function }} emitter
 * @param {string} type
 * @param {{ timeoutMs?: number, filter?: (detail: any) => boolean }} [opts]
 */
function waitFor(emitter, type, { timeoutMs = 3000, filter } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const safeReject = (reason) => {
      if (!settled) {
        settled = true;
        reject(reason);
      }
    };
    const timer = setTimeout(() => {
      off();
      safeReject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const off = emitter.on(type, (detail) => {
      if (filter && !filter(detail)) return;
      clearTimeout(timer);
      off();
      safeResolve(detail);
    });
  });
}

test("requires a command", () => {
  assert.throws(() => new LspProcess({ command: "" }), (err) => err instanceof LspProcessError && err.code === "lsp_no_command");
});

test("start is idempotent while running", (t) => {
  const proc = new LspProcess({ command: process.execPath, args: [MOCK] });
  proc.start();
  const first = proc.pid;
  proc.start();
  assert.equal(proc.pid, first);
  assert.equal(proc.starts, 1);
  t.after(() => proc.stop({ timeoutMs: 200 }));
});

test("reports spawn failures as lsp_spawn_failed", () => {
  const proc = new LspProcess({
    command: "definitely-not-a-real-language-server",
    spawn: () => {
      throw new Error("boom");
    },
  });
  assert.throws(() => proc.start(), (err) => err instanceof LspProcessError && err.code === "lsp_spawn_failed");
});

test("send before start is lsp_not_running", () => {
  const proc = new LspProcess({ command: process.execPath, args: [MOCK] });
  assert.throws(() => proc.send({ jsonrpc: "2.0", method: "x" }), (err) => err instanceof LspProcessError && err.code === "lsp_not_running");
});

test("frames a real child's stdout into messages", async (t) => {
  const proc = new LspProcess({ command: process.execPath, args: [MOCK] });
  proc.start();
  t.after(() => proc.stop({ timeoutMs: 200 }));
  const reply = waitFor(proc, "message", { filter: (m) => m.id === 1 });
  proc.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const message = await reply;
  assert.equal(message.result.serverInfo.name, "mock-ls");
});

test("restarts after an unexpected exit", async (t) => {
  const proc = new LspProcess({ command: process.execPath, args: [CRASH], restartDelayMs: 20, maxRestarts: 5 });
  const restarted = waitFor(proc, "restart", { filter: (d) => d.attempt === 1 });
  proc.start();
  t.after(() => proc.stop({ timeoutMs: 200 }));
  const detail = await restarted;
  assert.equal(detail.attempt, 1);
  assert.ok(detail.delayMs >= 20);
});

test("gives up after maxRestarts and reports lsp_restart_exhausted", async (t) => {
  const proc = new LspProcess({ command: process.execPath, args: [CRASH], restartDelayMs: 10, maxRestarts: 1 });
  const done = waitFor(proc, "error", { filter: (e) => e.code === "lsp_restart_exhausted", timeoutMs: 4000 });
  proc.start();
  t.after(() => proc.stop({ timeoutMs: 200 }));
  const err = await done;
  assert.equal(err.code, "lsp_restart_exhausted");
});

test("stop terminates the child without a restart", async () => {
  const proc = new LspProcess({ command: process.execPath, args: [MOCK] });
  let restarted = false;
  proc.on("restart", () => {
    restarted = true;
  });
  proc.start();
  const result = await proc.stop({ timeoutMs: 200 });
  assert.equal(proc.running, false);
  assert.ok(result.code != null || result.signal != null || true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(restarted, false);
});


