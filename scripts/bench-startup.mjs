// Benchmark AgentFlow CLI startup time.
//
// Reports cold-start (fresh node process per invocation) and warm-start
// (repeated run() calls inside one process, module cache already warm) times
// for the fast-path commands: --version, --help, status.
//
// Target: cold --version / --help / status under 80ms on the development
// machine. Numbers are informational; this script never fails the build.
//
// Usage: node scripts/bench-startup.mjs [--runs N]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "agentflow.js");

const RUNS = Number(process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1]) || 7;

// Commands that should not pull in any heavy command module.
const FAST_COMMANDS = [
  ["--version"],
  ["--help"],
  ["status"],
];

function spawnMs(args) {
  const start = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, code: res.status ?? -1, ok: res.error === undefined };
}

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function benchCold() {
  const results = {};
  for (const args of FAST_COMMANDS) {
    const samples = [];
    let failures = 0;
    for (let i = 0; i < RUNS; i++) {
      const m = spawnMs(args);
      if (!m.ok) { failures += 1; continue; }
      samples.push(m.ms);
    }
    samples.sort((a, b) => a - b);
    results[args.join(" ")] = {
      samples,
      min: samples[0] ?? null,
      avg: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: samples[samples.length - 1] ?? null,
      failures,
    };
  }
  return results;
}

async function benchWarm() {
  // Import the router once (module cache warm), then call run() repeatedly.
  const { run } = await import("../src/cli/index.js");
  // Side-effect import registers all command metadata.
  await import("../src/commands/index.js");

  const results = {};
  for (const args of FAST_COMMANDS) {
    const samples = [];
    // First call pays module resolution; discard it as a warm-up.
    await run([...args, "--json"]);
    for (let i = 0; i < RUNS; i++) {
      const start = process.hrtime.bigint();
      await run([...args, "--json"]);
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    results[args.join(" ")] = {
      samples,
      min: samples[0],
      avg: samples.reduce((a, b) => a + b, 0) / samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      max: samples[samples.length - 1],
    };
  }
  return results;
}

const cold = benchCold();
const warm = await benchWarm();

console.log("AgentFlow CLI startup benchmark");
console.log(`runs per command: ${RUNS}`);
console.log("");

console.log("cold (fresh node process per invocation):");
for (const [cmd, r] of Object.entries(cold)) {
  const flag = r.p95 < 80 ? "ok" : "slow";
  console.log(
    `  ${cmd.padEnd(12)} min=${(r.min ?? 0).toFixed(1)} avg=${(r.avg ?? 0).toFixed(1)} ` +
      `p50=${r.p50.toFixed(1)} p95=${r.p95.toFixed(1)} max=${r.max.toFixed(1)}ms ${flag}` +
      (r.failures ? ` (${r.failures} failed spawns)` : "")
  );
}

console.log("");
console.log("warm (repeated run() in one process, module cache warm):");
for (const [cmd, r] of Object.entries(warm)) {
  console.log(
    `  ${cmd.padEnd(12)} min=${r.min.toFixed(1)} avg=${r.avg.toFixed(1)} ` +
      `p50=${r.p50.toFixed(1)} p95=${r.p95.toFixed(1)} max=${r.max.toFixed(1)}ms`
  );
}

const coldOk = Object.values(cold).every((r) => (r.p95 ?? Infinity) < 80);
console.log("");
console.log(coldOk ? "cold fast-path commands all under 80ms p95" : "some cold fast-path commands exceed 80ms p95");
