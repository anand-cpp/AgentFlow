// Stdio MCP transport: spawn MCP server and speak newline-delimited JSON-RPC.
//
// Conforms to JSON-RPC 2.0 over stdio for MCP servers. Messages are sent/received
// as newline-delimited JSON (one JSON object per line), not LSP's Content-Length
// framing. This is the canonical MCP transport for local processes.
import { spawn } from "node:child_process";
import { McpTransport } from "./base.js";

function awaitImportSpawn() {
  return { spawn };
}

export class StdioTransport extends McpTransport {
  constructor(options = {}) {
    const { command, args = [], cwd, env, spawn: spawnFn = spawn } = options;
    if (!command) throw new Error("StdioTransport requires a command");
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnFn = spawnFn;
    this.child = null;
    this.buf = "";
    this.closed = false;
  }

  connect() {
    if (this.child) return;
    this.child = this.spawnFn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk) => this._onData(String(chunk)));
    this.child.stderr?.on("data", (chunk) => this.emit("error", { type: "stderr", data: String(chunk) }));
    this.child.on("error", (err) => this.emit("error", { type: "spawn", err }));
    this.child.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
      this.closed = true;
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (line.trim() === "") continue;
      try {
        const msg = JSON.parse(line);
        this.emit("message", msg);
      } catch (err) {
        this.emit("error", { type: "parse", err, line });
      }
    }
  }

  send(message) {
    if (!this.child?.stdin) throw new Error("stdio transport not connected");
    const line = JSON.stringify(message) + "\n";
    this.child.stdin.write(line);
  }

  close() {
    this.closed = true;
    try {
      this.child?.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      if (process.platform === "win32" && this.child?.pid) {
        const { spawn: killSpawn } = awaitImportSpawn();
        killSpawn("taskkill", ["/pid", String(this.child.pid), "/T"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
      } else {
        this.child?.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
}

export default { StdioTransport };
