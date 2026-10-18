// Unit tests for the MCP stdio transport: line buffering, JSON framing, error
// handling, process lifecycle. Drives StdioTransport with an injected spawn so
// tests run without any real MCP server being installed.
import test from "node:test";
import assert from "node:assert/strict";
import { StdioTransport } from "../../src/core/mcp/transports/stdio.js";
import { McpTransport } from "../../src/core/mcp/transports/base.js";

function emit(map, type, ...args) {
  const set = map.get(type);
  if (!set) return;
  for (const fn of [...set]) fn(...args);
}

/** A ChildProcess double with recordable streams the tests can push data into. */
function fakeChild() {
  const stdoutOn = new Map();
  const stderrOn = new Map();
  const childOn = new Map();
  const child = {
    stdin: {
      written: "",
      ended: false,
      write(data) { this.written += String(data); },
      end() { this.ended = true; },
    },
    on(type, fn) {
      let s = childOn.get(type);
      if (!s) { s = new Set(); childOn.set(type, s); }
      s.add(fn);
      return child;
    },
  };
  child.stdout = { on: (type, fn) => { let s = stdoutOn.get(type); if (!s) { s = new Set(); stdoutOn.set(type, s); } s.add(fn); } };
  child.stderr = { on: (type, fn) => { let s = stderrOn.get(type); if (!s) { s = new Set(); stderrOn.set(type, s); } s.add(fn); } };
  child.pid = 4242;
  child.emitStdout = (chunk) => emit(stdoutOn, "data", chunk);
  child.emitStderr = (chunk) => emit(stderrOn, "data", chunk);
  child.emitExit = (code, signal) => emit(childOn, "exit", code, signal);
  child.emitError = (err) => emit(childOn, "error", err);
  return child;
}

test("StdioTransport extends the transport base", () => {
  const t = new StdioTransport({ command: "node" });
  assert.ok(t instanceof McpTransport);
});

test("transport requires a command", () => {
  assert.throws(() => new StdioTransport({}), /requires a command/);
});

test("connect spawns the process with piped stdio", () => {
  /** @type {{ command: string, args: string[], options: object } | null} */
  let observed = null;
  const child = fakeChild();
  const spawnFn = (command, args, options) => {
    observed = { command, args, options };
    return child;
  };
  const t = new StdioTransport({ command: "uvx", args: ["mcp-server"], spawn: spawnFn });
  t.connect();
  assert.ok(observed != null);
  if (!observed) throw new Error("spawn was not called");
  assert.equal(observed.command, "uvx");
  assert.deepEqual(observed.args, ["mcp-server"]);
  assert.equal(observed.options.stdio.length, 3);
  assert.equal(t.command, "uvx");
  t.close();
});

test("connect is idempotent", () => {
  let spawns = 0;
  const spawnFn = () => { spawns += 1; return fakeChild(); };
  const t = new StdioTransport({ command: "x", spawn: spawnFn });
  t.connect();
  t.connect();
  assert.equal(spawns, 1);
});

test("line buffering: a message split across chunks parses once", () => {
  const messages = [];
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.on("message", (m) => messages.push(m));
  t.connect();
  child.emitStdout('{"jsonrpc":"2.0"}\n{"jso');
  child.emitStdout('nrpc":"2.0"}\n');
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { jsonrpc: "2.0" });
  assert.deepEqual(messages[1], { jsonrpc: "2.0" });
});

test("blank lines and CRLF terminators are skipped", () => {
  const messages = [];
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.on("message", (m) => messages.push(m));
  t.connect();
  child.emitStdout('\r\n{"a":1}\r\n\n{"b":2}\n');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
});

test("malformed JSON emits a parse error, not a throw", () => {
  const errors = [];
  const messages = [];
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.on("error", (e) => errors.push(e));
  t.on("message", (m) => messages.push(m));
  t.connect();
  child.emitStdout("definitely not json\n");
  assert.equal(messages.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, "parse");
});

test("send writes newline-delimited JSON to stdin", () => {
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.connect();
  t.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  assert.equal(child.stdin.written, '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n');
});

test("send before connect throws", () => {
  const t = new StdioTransport({ command: "x", spawn: () => fakeChild() });
  assert.throws(() => t.send({ jsonrpc: "2.0" }), /not connected/);
});

test("process exit marks the transport closed and emits exit", () => {
  const exits = [];
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.on("exit", (e) => exits.push(e));
  t.connect();
  child.emitExit(1, "SIGTERM");
  assert.equal(t.closed, true);
  assert.deepEqual(exits, [{ code: 1, signal: "SIGTERM" }]);
});

test("child error events surface as error events", () => {
  const errors = [];
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.on("error", (e) => errors.push(e));
  t.connect();
  child.emitError(new Error("boom"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, "spawn");
});

test("close ends stdin and marks the transport closed", () => {
  const child = fakeChild();
  const t = new StdioTransport({ command: "x", spawn: () => child });
  t.connect();
  t.close();
  assert.equal(child.stdin.ended, true);
  assert.equal(t.closed, true);
});
