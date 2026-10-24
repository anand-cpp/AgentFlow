// v1.0.0 smoke tests.
//
// End-to-end sanity on the CLI surface: every registered command answers
// --help with exit code 0, and the global flags work. These are process-level
// tests because argv parsing and exit codes only exist across a real process
// boundary. Nothing here reaches the network or writes to the developer's
// real state directory.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = path.join(ROOT, "bin", "agentflow.js");

// Every command registered in src/commands/index.js, plus the alias.
const COMMANDS = [
  "agent", "blackboard", "chat", "config", "dashboard", "doctor", "fight",
  "git", "init", "lsp", "logs", "map", "mcp", "models", "plugin", "publish",
  "route", "server", "sessions", "setup", "status", "tribunal",
];

function runCli(args, { timeoutMs = 15000 } = {}) {
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
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      safeReject(new Error(`timed out: aflow ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      safeReject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      safeResolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}

test("aflow --help exits 0 and lists commands", async () => {
  const { code, output } = await runCli(["--help"]);
  assert.equal(code, 0, `aflow --help exited ${code}: ${output}`);
  assert.ok(output.includes("COMMANDS"), "help must list commands");
  for (const name of ["doctor", "plugin", "setup", "status"]) {
    assert.ok(output.includes(name), `help must mention ${name}`);
  }
});

test("aflow --version exits 0", async () => {
  const { code, output } = await runCli(["--version"]);
  assert.equal(code, 0, `aflow --version exited ${code}: ${output}`);
  assert.match(output, /\d+\.\d+\.\d+/, "version must be printed");
});

test("every command's --help exits 0", async () => {
  for (const name of COMMANDS) {
    const { code, output } = await runCli([name, "--help"]);
    assert.equal(
      code,
      0,
      `aflow ${name} --help exited ${code}: ${output.slice(0, 200)}`
    );
    assert.ok(output.trim().length > 0, `${name} help must print something`);
    assert.ok(output.includes(name), `${name} help must name ${name}`);
  }
});

test("doctor exits 0 even when everything is unconfigured", async () => {
  const { code } = await runCli(["doctor"]);
  assert.equal(code, 0, `aflow doctor exited ${code} (doctor must never fail the CLI on problems)`);
});
