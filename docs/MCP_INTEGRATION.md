# MCP integration

AgentFlow can talk to MCP (Model Context Protocol) servers. An MCP server is a
small program (or HTTP endpoint) that exposes **tools**, **resources**, and
**prompt templates** — a file reader, a database query engine, an issue tracker,
anything. Once configured, every tool a running server advertises becomes an
ordinary AgentFlow agent tool, namespaced so it can never collide with a
built-in one.

This document is the reference for **what the MCP layer does, how servers are
configured, and how a broken server stays out of the way**. The implementation
lives in [`src/core/mcp/`](../src/core/mcp/); the shared command dispatcher is
[`src/commands/mcp.js`](../src/commands/mcp.js).

## Design rules

- **Zero runtime dependencies.** `src/core/mcp/*` uses `node:child_process`,
  `node:http`, `node:https`, `node:url`, `node:fs` and the standard library
  only. It implements JSON-RPC 2.0 over stdio (newline-delimited JSON) and the
  SSE two-endpoint transport itself — no `@modelcontextprotocol/sdk`.
- **Protocol version 2024-11-05.** The client handshakes with
  `protocolVersion: "2024-11-05"`, clientInfo `{ name: "AgentFlow", version:
  "0.3.0" }`, and capabilities `{ roots: { listChanged: false }, sampling: {} }`.
  Server-initiated requests (e.g. `sampling/createMessage`) are answered with a
  JSON-RPC `-32601` method-not-found error; AgentFlow does not model for servers.
- **Isolated failure.** A server that fails to spawn, crashes mid-session, or
  times out never fails a run. The manager catches each server's start-up
  failure separately and records it as `status: "failed"` on that server's
  entry; every other server keeps running. A spawn failure settles pending
  requests immediately instead of letting them ride out the 10 s deadline.
- **No auto-restart.** Deliberately different from the LSP layer: a dead stdio
  server is left alone rather than restarted, because a restart would silently
  invalidate the session state the caller is mid-conversation with. The next
  `startAll()` (e.g. the next CLI invocation) starts it fresh.
- **Stdio is newline-delimited JSON.** Not LSP's `Content-Length` framing —
  each JSON-RPC message is one line, decoded with a hand-rolled line buffer
  that tolerates a message split across any chunk boundary.
- **SSE follows the MCP two-endpoint shape.** `GET <url>/sse` subscribes and
  the first `event: endpoint` frames carry the POST target; requests go out as
  HTTP POSTs to that target and replies ride back on the GET stream. `send()`
  throws `SSE transport not ready (no endpoint)` until the endpoint event
  arrives.
- **Windows-correct shutdown.** `StdioTransport.close()` reaps the whole
  process tree with `taskkill /T` so nothing is orphaned behind a `.cmd` shim.

## Configuration

The config is discovered in this order — the first file that exists wins:

1. `.agentflow/mcp.json`
2. `mcp.json`
3. `package.json` → the `mcp.mcpServers` key

The schema is the `mcpServers` block used by Claude Desktop and OpenCode, so an
existing config drops in unchanged. `${VAR}` inside `command`, `args`, and
`url` expands from the environment (an unset variable expands to the empty
string):

```json
{
  "mcpServers": {
    "sqlite": {
      "command": "uvx",
      "args": ["mcp-server-sqlite", "--db-path", "test.db"]
    },
    "remote-api": { "url": "http://localhost:8080/sse" }
  }
}
```

- An entry with a `command` uses the **stdio** transport; one with a `url`
  uses **SSE**. An entry with neither is skipped with a diagnostic.
- `command` may be an array (`["cmd", "arg1"]`) — OpenCode's local form — which
  becomes `command` + `args`.
- A UTF-8 BOM (PowerShell 5's `Set-Content -Encoding UTF8` writes one) is
  stripped before parsing.
- Invalid JSON is a diagnostic, not a crash: the server list is simply empty.

## Two front doors

```sh
aflow mcp status                       # configured servers and what they expose
aflow mcp tools                        # every tool, with its JSON Schema
aflow mcp call <server> <tool> '{"k":"v"}'
aflow mcp read <server> <uri>
```

and, inside a chat session, the same dispatcher as `/mcp <subcommand>`. Each
invocation starts the configured servers, does one operation, and stops them —
deliberately one-shot, like `aflow lsp`. `--project PATH` resolves the config
relative to another directory.

Status rendering is honest per server: `connected` (discovered tool and
resource counts), or `failed` with the underlying error. AgentFlow exits `0`
when the requested operation ran and `1` when it could not.

## Tools in the agent runtime

Discovered tools are wrapped in AgentFlow's internal tool schema and registered
into the runtime's tool map under the namespaced name:

```
mcp__<serverName>__<toolName>       →  mcp__sqlite__read_query
```

That is the whole integration: the namespace is the contract. `runTool`'s
permission pipeline (scopes, allow entries, redaction) applies to an MCP tool
exactly as to a built-in — an agent needs a matching `allow` entry, and MCP
tools are granted the `read` scope by default ("external fetch of text", the
conservative choice). A tool-level MCP error (`isError: true`) surfaces as a
thrown tool error, not a silent pass, so the transcript records an honest
`error` outcome.

Resource payloads follow the MCP wire format: text resources decode as UTF-8
and binary resources stay base64; a `notifications/resources/updated` event
invalidates the cached listing. Prompt templates expand through
`prompts/get` into role/content messages that slot into agent context.

## Doctor

`aflow doctor` reports MCP separately and never fails on it:

| Config state | Reported status |
|---|---|
| no `mcp.json` anywhere | `unconfigured` |
| every stdio command resolvable on PATH (or SSE) | `ok` |
| some commands missing from PATH | `warn` |
| every command missing from PATH | `info` |

An absent binary is a missing *feature*, not a broken *installation*, so it can
never turn doctor red.

## Custom servers

Any process that speaks JSON-RPC 2.0 over stdio works — the integration tests
drive a hand-written
[`test/mcp/fixtures/mock-mcp-server.js`](../test/mcp/fixtures/mock-mcp-server.js)
through the real manager. To add one, create an executable, emit one JSON-RPC
response line per request line on stdout, and answer `initialize` with your
capabilities. `ping` should return an empty result; `shutdown` should exit
cleanly.
