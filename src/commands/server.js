// `aflow server` — control the standalone in-repo gateway.
//
// The gateway (src/core/gateway-server.js) is what lets AgentFlow run without a
// separately-installed 9Router service. This command is the human surface over
// it: start it (foreground or detached), stop it, and see whether it is up.
//
// Runtime state lives in one small JSON file under the platform state directory
// (override with --state-dir or AGENTFLOW_STATE_DIR):
//
//   %LOCALAPPDATA%\agentflow\server\server.json      (Windows)
//   ~/.local/state/agentflow/server/server.json      (macOS/Linux)
//
// It holds { pid, host, port, url, startedAt, version } -- references only, so
// `status` can report a live PID and uptime without the server having to be
// reachable, and `stop` knows exactly which process to signal.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { defineCommand } from "../cli/registry.js";
import {
  GatewayServer,
  GatewayPortConflictError,
  GatewayInsecureError,
  assertSecureBind,
  defaultServerDir,
  GATEWAY_VERSION,
  GATEWAY_DEFAULTS,
} from "../core/gateway-server.js";
import { defaultKeysFile } from "../core/keys.js";
import { bold, dim, heading, table, green, red, yellow } from "../cli/ui.js";

const USAGE_ERROR = 2;

function usage(message) {
  const err = /** @type {Error & { usage: boolean }} */ (new Error(message));
  err.usage = true;
  return err;
}

// ---------------------------------------------------------------------------
// state file
// ---------------------------------------------------------------------------

function stateDir(flags) {
  return flags["state-dir"] ? String(flags["state-dir"]) : defaultServerDir();
}

function stateFilePath(flags) {
  return path.join(stateDir(flags), "server.json");
}

function readState(flags) {
  try {
    const file = stateFilePath(flags);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // A corrupt state file is not fatal: `status` reports "not running" and
    // `start` overwrites it. Refusing to run because a scratch file is garbage
    // would be a worse failure than the one it reports.
    return null;
  }
}

function writeState(flags, state) {
  const dir = stateDir(flags);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(flags), `${JSON.stringify(state, null, 2)}\n`);
}

function removeState(flags) {
  try {
    fs.rmSync(stateFilePath(flags), { force: true });
  } catch {
    /* best effort */
  }
}

/** Whether a PID is alive. Signal 0 probes without delivering anything. */
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

function resolveServerOptions(flags, config) {
  const port =
    flags.port != null && flags.port !== true ? Number(flags.port) : config?.serverPort ?? GATEWAY_DEFAULTS.port;
  const host = flags.host ? String(flags.host) : config?.serverHost ?? GATEWAY_DEFAULTS.host;
  const ollamaUrl = flags["ollama-url"]
    ? String(flags["ollama-url"])
    : config?.ollamaUrl ?? GATEWAY_DEFAULTS.ollamaUrl;
  // The API key is never a CLI flag -- a key in argv lands in shell history and
  // the process table. It comes from config or AGENTFLOW_SERVER_API_KEY only.
  const apiKey = config?.serverApiKey ?? null;
  // Keys written by `aflow setup` are folded into provider resolution, so the
  // server picks them up without the user having to source anything.
  const keysFile = flags["keys-file"] ? String(flags["keys-file"]) : defaultKeysFile();
  return { port, host, ollamaUrl, apiKey, keysFile };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

async function startSub({ flags, config, out }) {
  const opts = resolveServerOptions(flags, config);

  const existing = readState(flags);
  if (existing && isAlive(existing.pid) && existing.pid !== process.pid) {
    await out.init(
      { started: false, reason: "already_running", server: existing },
      () =>
        `${yellow("already running")} pid ${bold(existing.pid)} at ${existing.url}\n${dim(
          "aflow server stop   to stop it"
        )}`,
    );
    return 1;
  }

  // Refuse an insecure bind before doing anything observable (state file, fork).
  try {
    assertSecureBind({ host: opts.host, apiKey: opts.apiKey });
  } catch (err) {
    if (err instanceof GatewayInsecureError) {
      await out.init(
        { started: false, reason: "insecure_bind", host: err.host },
        () => `${red("cannot start")} ${err.message}`,
      );
      return 1;
    }
    throw err;
  }

  if (flags.daemon) return spawnDaemon(flags, opts, out);

  const server = new GatewayServer(opts);
  try {
    await server.start();
  } catch (err) {
    if (err instanceof GatewayPortConflictError) {
      await out.init(
        { started: false, reason: "port_in_use", port: err.port, host: err.host },
        () => `${red("cannot start")} ${err.message}\n${dim("another process is using this port; stop it or pass --port <n>")}`,
      );
      return 1;
    }
    throw err;
  }

  const addr = server.address();
  const state = {
    pid: process.pid,
    host: addr.host,
    port: addr.port,
    url: server.url(),
    startedAt: Date.now(),
    version: GATEWAY_VERSION,
  };
  writeState(flags, state);
  out.info(dim(`state file: ${stateFilePath(flags)}`));

  await out.init(
    { started: true, server: state },
    (r) =>
      [
        heading(bold("aflow server start")),
        table(
          [
            { k: "state", v: green("listening") },
            { k: "url", v: r.server.url },
            { k: "pid", v: String(r.server.pid) },
            { k: "ollama", v: opts.ollamaUrl },
          ],
          [
            { key: "k", label: "" },
            { key: "v", label: "" },
          ],
        ),
        "",
        dim("press Ctrl+C to stop"),
      ].join("\n"),
  );

  // Hold the foreground process open until a signal arrives. The listening
  // socket already keeps the event loop alive, but awaiting a shutdown promise
  // gives SIGINT/SIGTERM a single, ordered place to close the server and clear
  // the state file before the process exits.
  return await new Promise((resolve) => {
    let settled = false;
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      await server.close().catch(() => {});
      removeState(flags);
      resolve(code);
    };
    process.once("SIGINT", () => {
      out.info(dim("shutting down"));
      finish(0);
    });
    process.once("SIGTERM", () => finish(0));
    server.server?.once("close", () => finish(0));
  });
}

async function spawnDaemon(flags, opts, out) {
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "aflow.js");
  const args = ["server", "start", "--port", String(opts.port), "--host", opts.host, "--ollama-url", opts.ollamaUrl];
  if (flags["state-dir"]) args.push("--state-dir", String(flags["state-dir"]));
  // Only forward an explicit keys file; otherwise the child resolves the same
  // platform default the parent would have.
  if (flags["keys-file"]) args.push("--keys-file", String(flags["keys-file"]));

  // Detached + unref so the child outlives this invocation, which is the whole
  // point of --daemon. stdio ignored because there is no terminal to write to.
  const child = spawn(process.execPath, [bin, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Confirm the child actually bound before claiming success. Without this,
  // `--daemon` would report "started" even when the child died on a port
  // conflict a moment later.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const st = readState(flags);
    if (st && isAlive(st.pid) && st.pid !== process.pid) {
      await out.init(
        { started: true, daemon: true, server: st },
        (r) => `${green("started")} (daemon) pid ${bold(r.server.pid)} at ${r.server.url}`,
      );
      return 0;
    }
    await sleep(100);
  }

  await out.init(
    { started: false, reason: "daemon_failed", port: opts.port },
    () => `${red("failed to start")} the background server (see \`aflow logs\`)`,
  );
  return 1;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

async function stopSub({ flags, out }) {
  const state = readState(flags);
  if (!state || !state.pid) {
    await out.init({ stopped: false, reason: "not_running" }, () => dim("gateway is not running"));
    return 1;
  }
  if (!isAlive(state.pid)) {
    removeState(flags);
    await out.init(
      { stopped: false, reason: "stale", pid: state.pid },
      () => `${yellow("not running")} (cleared stale pid ${state.pid})`,
    );
    return 1;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    await out.init({ stopped: false, reason: "signal_failed", pid: state.pid, error: err.message }, () =>
      `${red("could not signal")} pid ${state.pid}: ${err.message}`,
    );
    return 1;
  }

  const exited = await waitForExit(state.pid, 4000);
  removeState(flags);
  await out.init(
    { stopped: true, pid: state.pid, clean: exited },
    (r) => `${green("stopped")} pid ${bold(r.pid)}${r.clean ? "" : dim(" (did not exit within 4s; state cleared)")}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function statusSub({ flags, config, out }) {
  const state = readState(flags);
  const opts = resolveServerOptions(flags, config);
  const url = state?.url || `http://${opts.host}:${opts.port}`;
  const alive = state ? isAlive(state.pid) : false;

  let reachable = false;
  let version = null;
  let probeError = null;
  try {
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const body = /** @type {{ version?: string }} */ (await res.json());
      reachable = true;
      version = body?.version ?? null;
    } else {
      probeError = `HTTP ${res.status}`;
    }
  } catch (err) {
    probeError = err?.name === "TimeoutError" ? "timed out" : err?.message || String(err);
  }

  const uptimeMs = alive && state?.startedAt ? Date.now() - state.startedAt : null;
  const payload = {
    running: reachable,
    pid: state?.pid ?? null,
    url,
    reachable,
    version,
    uptimeMs,
    startedAt: state?.startedAt ?? null,
    error: probeError,
  };

  await out.init(payload, (r) => {
    const lines = [heading(bold("aflow server status"))];
    const stateWord = r.reachable ? green("up") : alive ? yellow("pid alive, not reachable") : red("down");
    lines.push(
      table(
        [
          { k: "server", v: stateWord },
          { k: "url", v: r.url },
          { k: "pid", v: r.pid ? String(r.pid) : dim("(none)") },
          { k: "version", v: r.version || dim("(unknown)") },
          { k: "uptime", v: r.uptimeMs != null ? formatDuration(r.uptimeMs) : dim("(unknown)") },
        ],
        [
          { key: "k", label: "" },
          { key: "v", label: "" },
        ],
      ),
    );
    if (!r.reachable) {
      lines.push("");
      lines.push(dim(r.error ? `probe failed: ${r.error}` : "start it with: aflow server start"));
    }
    return lines.join("\n");
  });

  return reachable ? 0 : 1;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export const serverCommand = defineCommand("server", {
  summary: "run and control the standalone in-repo gateway",
  valueFlags: ["host", "ollama-url", "state-dir", "keys-file"],
  usage: `aflow server [status]
  aflow server start [--port N] [--host HOST] [--ollama-url URL] [--daemon]
  aflow server stop [--state-dir PATH]
  aflow server status

Runs the zero-dependency gateway server (src/core/gateway-server.js) so AgentFlow
does not need a separately-installed 9Router service. The server answers
/api/version, /v1/models, and /v1/chat/completions, routing completions to a
local Ollama instance when one is configured.

  start     bind the port and serve in the foreground; --daemon detaches it
  stop      signal the background server recorded in the state file
  status    report whether the server is reachable, with pid and uptime

  --port N        listen port (default 20127; 0 lets the OS choose)
  --host HOST     bind address (default 127.0.0.1 -- loopback only)
  --ollama-url U  local Ollama base URL (default http://127.0.0.1:11434)
  --daemon        run detached in the background
  --state-dir P   where the pid/state file lives
  --keys-file P   keys.env to load provider keys from (default <state dir>/keys.env)

Provider keys from 'aflow setup' are loaded automatically; an environment
variable always overrides the same key coming from the file.

Auth is configured out-of-band, never on the command line:
  AGENTFLOW_SERVER_API_KEY  optional key required on /v1/* routes; also required
                            before binding --host 0.0.0.0

Exit codes: 0 ok, 1 not running or conflict, 2 usage.

Examples
  aflow server start
  aflow server start --daemon --port 20127
  aflow server status --json
  aflow server stop`,
  run: async ({ args, flags, config, out }) => {
    const [sub = "status"] = args;
    try {
      switch (sub) {
        case "start":
        case "run":
          return await startSub({ flags, config, out });
        case "stop":
          return await stopSub({ flags, out });
        case "status":
          return await statusSub({ flags, config, out });
        default:
          throw usage(`unknown subcommand: ${sub}\n\n${serverCommand.usage}`);
      }
    } catch (err) {
      if (err.usage) {
        await out.init({ error: err.message, usage: serverCommand.usage }, () => `${err.message}\n\n${serverCommand.usage}`);
        return USAGE_ERROR;
      }
      throw err;
    }
  },
});

export default serverCommand;
