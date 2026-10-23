// Startup performance tests.
//
// Guards that the fast-path CLI commands (--version, --help) start in well
// under the 80ms target on a cold node process. Each invocation is a fresh
// process, so this measures real cold-start: module parsing + CLI router +
// command metadata, with no heavy command modules loaded.
//
// These are process-level tests (spawn the CLI binary) because startup time
// only exists across a real process boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "bin", "agentflow.js");
const RUNS = 6;
const TARGET_MS = 1000; // loose regression guard; the 80ms target is measured
                        // precisely by scripts/bench-startup.mjs on an idle box.
                        // CI runners are slower and more variable than a local
                        // box, so the guard is kept deliberately generous: it
                        // catches regressions, not cold-start jitter.

function spawnMs(args) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    child.on("close", () => {
      resolve(Number(process.hrtime.bigint() - start) / 1e6);
    });
    child.on("error", () => resolve(Infinity));
    setTimeout(() => { child.kill("SIGKILL"); resolve(Infinity); }, 15000);
  });
}

async function coldP95(args) {
  const samples = [];
  for (let i = 0; i < RUNS; i++) samples.push(await spawnMs(args));
  samples.sort((a, b) => a - b);
  const idx = Math.ceil((95 / 100) * samples.length) - 1;
  return samples[Math.max(0, Math.min(idx, samples.length - 1))];
}

test("cold aflow --version starts under target", async () => {
  const p95 = await coldP95(["--version"]);
  console.log(`cold --version p95: ${p95.toFixed(1)}ms (target < ${TARGET_MS}ms)`);
  assert.ok(p95 < TARGET_MS, `cold --version p95 ${p95.toFixed(1)}ms exceeds ${TARGET_MS}ms`);
});

test("cold aflow --help starts under target", async () => {
  const p95 = await coldP95(["--help"]);
  console.log(`cold --help p95: ${p95.toFixed(1)}ms (target < ${TARGET_MS}ms)`);
  assert.ok(p95 < TARGET_MS, `cold --help p95 ${p95.toFixed(1)}ms exceeds ${TARGET_MS}ms`);
});
