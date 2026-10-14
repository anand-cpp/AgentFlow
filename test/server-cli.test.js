// `aflow server` command: lifecycle, status, and conflict handling.
//
// These are process-level tests on purpose. The gateway server unit tests cover
// the socket and the translation; what is *not* covered there is the wiring --
// argv parsing, the state file, the PID handshake between `start` and `stop`,
// and the exit codes a shell actually sees. Those only exist across a real
// process boundary, so this file spawns the CLI as a child process.
//
// Each test gets its own temp state dir and its own free port, and strips any
// AGENTFLOW_* server settings inherited from the environment, so the tests are
// independent and do not touch the developer's real gateway.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "aflow.js");

/** Children spawned by a test, killed in afterEach so a failure cannot leak. */
const children = new Set();
/** Manually-bound servers held open by a test. */
const heldServers = new Set();

afterEach(async () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.clear();
  for (const server of heldServers) {
    server.close();
    server.closeAllConnections?.();
  }
  heldServers.clear();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpStateDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aflow-srv-${label}-`));
}

/** Child env with server-affecting AGENTFLOW_* variables stripped. */
function cliEnv(extra = {}) {
  const env = { ...process.env };
  delete env.AGENTFLOW_SERVER_API_KEY;
  delete env.AGENTFLOW_STATE_DIR;
  delete env.AGENTFLOW_CONFIG_DIR;
  delete env.AGENTFLOW_SERVER_HOST;
  delete env.AGENTFLOW_SERVER_PORT;
  delete env.AGENTFLOW_OLLAMA_URL;
  return { ...env, ...extra };
}

/** Run the CLI to completion and capture its streams. */
function runCli(args, { env = {}, timeoutMs = 9000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: cliEnv(env),
      cwd: ROOT,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out: aflow ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}

/** Spawn a long-running CLI process (used for `server start`). */
function spawnCli(args, { env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: cliEnv(env),
    cwd: ROOT,
    windowsHide: true,
  });
  children.add(child);
  child.on("close", () => children.delete(child));
  return child;
}

/** Ask the OS for a port that is currently free. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {{ port: number }} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy or the deadline passes. */
async function waitFor(fn, { timeoutMs = 6000, intervalMs = 80 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/** Resolve true if `port` can be bound right now. */
async function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

const stateFile = (dir) => path.join(dir, "server.json");

// ---------------------------------------------------------------------------
// 3.1 help
// ---------------------------------------------------------------------------

test("aflow server --help lists the start/stop/status subcommands", { timeout: 10000 }, async () => {
  const { code, output } = await runCli(["server", "--help"]);
  assert.equal(code, 0);
  for (const sub of ["start", "stop", "status"]) {
    assert.ok(output.includes(sub), `help must mention the '${sub}' subcommand`);
  }
  assert.match(output, /aflow server/);
});

// ---------------------------------------------------------------------------
// 3.2 status when nothing is running
// ---------------------------------------------------------------------------

test("aflow server status reports 'down' and exits 1 when nothing is running", { timeout: 10000 }, async () => {
  const dir = tmpStateDir("down");
  const { code, output } = await runCli(["server", "status", "--state-dir", dir]);
  assert.equal(code, 1);
  assert.match(output, /down/i);
});

// ---------------------------------------------------------------------------
// 3.3 lifecycle
// ---------------------------------------------------------------------------

test("start -> status -> stop lifecycle", { timeout: 15000 }, async () => {
  const dir = tmpStateDir("life");
  const port = await freePort();

  const child = spawnCli([
    "server",
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--ollama-url",
    "http://127.0.0.1:1",
    "--state-dir",
    dir,
  ]);

  // Wait for the server to record itself.
  const state = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));
    } catch {
      return null;
    }
  });
  assert.ok(state, "the state file must appear");
  assert.equal(state.pid, child.pid, "the recorded pid must be the start process");
  assert.equal(state.port, port);
  assert.equal(state.url, `http://127.0.0.1:${port}`);

  // Human status says up; machine status carries the pid.
  const human = await runCli(["server", "status", "--state-dir", dir]);
  assert.equal(human.code, 0);
  assert.match(human.output, /up/i);
  assert.ok(human.output.includes(String(child.pid)), "status must print the pid");

  const json = await runCli(["server", "status", "--state-dir", dir, "--json"]);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.running, true);
  assert.equal(payload.pid, child.pid);

  // Stop it.
  const stopped = await runCli(["server", "stop", "--state-dir", dir]);
  assert.equal(stopped.code, 0);
  assert.match(stopped.output, /stopped/i);

  // The process must be gone, the state file removed, and the port free.
  const exited = await waitFor(() => child.exitCode !== null || child.killed, { timeoutMs: 5000 });
  assert.ok(exited, "the start process must terminate");
  assert.equal(fs.existsSync(stateFile(dir)), false, "stop must remove the state file");
  assert.equal(await waitFor(() => canBind(port), { timeoutMs: 4000 }), true, "the port must be freed");
});

// ---------------------------------------------------------------------------
// 3.4 port conflict
// ---------------------------------------------------------------------------

test("start fails clearly when the port is already in use", { timeout: 12000 }, async () => {
  const dir = tmpStateDir("conflict");

  // Hold a port ourselves.
  const blocker = net.createServer();
  heldServers.add(blocker);
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => resolve());
  });
  const port = /** @type {any} */ (blocker.address()).port;

  const { code, output } = await runCli([
    "server",
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--ollama-url",
    "http://127.0.0.1:1",
    "--state-dir",
    dir,
  ]);

  assert.equal(code, 1);
  assert.match(output, /in use/i);
  assert.equal(fs.existsSync(stateFile(dir)), false, "a failed start must not leave a state file");
});
