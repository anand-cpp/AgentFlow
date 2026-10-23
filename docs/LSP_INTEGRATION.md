# LSP integration

AgentFlow can talk to a language server. Two things come out of that: you can ask
the server questions from the terminal or a chat, and — the reason it exists —
the agent's own edits are checked against it, with the resulting diagnostics fed
back into the model's next prompt so it corrects itself inside the same task.

This document is the reference for **what the LSP layer does, how it is exposed,
and how it stays out of the way**. The implementation lives in
[`src/core/lsp/`](../src/core/lsp/); the shared command dispatcher is
[`src/commands/lsp.js`](../src/commands/lsp.js).

## Design rules

- **Zero runtime dependencies.** `src/core/lsp/*` uses `node:child_process`,
  `node:fs`, `node:path` and the standard library only. It implements JSON-RPC
  2.0 framing over stdio itself — no `vscode-languageserver-protocol`, no
  `vscode-jsonrpc`.
- **Advisory, never load-bearing.** A language server that is slow, absent, or
  crashing must never fail or stall a run. Every path from the agent into the
  server is wrapped so a broken server degrades to "no diagnostics", not to a
  failed tool call.
- **Byte-accurate framing.** The `Content-Length` header counts UTF-8 **bytes**,
  not characters, and the decoder tolerates a message split across any chunk
  boundary. A naive character count desynchronises the stream the first time a
  message carries a non-ASCII character.
- **Supervised processes.** A server that crashes is restarted with a bounded
  backoff (three attempts by default), then reported and left alone. A crash
  never takes AgentFlow down.
- **Windows-correct.** npm-installed servers are `.cmd` shims, so on Windows the
  server is launched through `cmd.exe`; shutdown uses `taskkill /T` to reap the
  whole process tree rather than orphaning the real server behind the shim.
- **Workspace-scoped.** Every file the tools touch is resolved inside the
  workspace root; a path that escapes it is refused (`PATH_OUTSIDE_WORKSPACE`).
- **Advisory, not authoritative.** LSP diagnostics are one more signal in the
  prompt, not a gate. A clean server never blocks a write; a noisy one never
  fails one.

## Two front doors

The same dispatcher serves both:

```sh
aflow lsp <subcommand> [options]     # the CLI command
```

and, inside a chat session:

```
/lsp <subcommand>
```

`aflow lsp` and `/lsp` share `dispatchLsp`, so they behave identically. The CLI
can resolve files relative to another directory with `--project PATH` and can
emit `--json`.

Each query starts the server registered for the file's extension, asks one
question, and stops it. This is deliberately one-shot: the terminal does not need
a warm server, and paying the start-up cost keeps `aflow lsp` free of hidden
daemon state. (The agent runtime is the opposite — it keeps a server warm for the
duration of a task.)

## Subcommands

| Subcommand | What it does |
|---|---|
| `status` | list every registered server, whether it is installed, and its install command |
| `diagnostics <file>` | start the file's server, re-analyse it, and print its diagnostics |
| `hover <file> <line> <column>` | the type / docs at a position |
| `definition <file> <line> <column>` | where the symbol at a position is defined |

Lines and columns are **1-based** on the command line (the LSP positions inside
the core are 0-based; the boundary converts).

```sh
node bin/aflow.js lsp status
node bin/aflow.js lsp diagnostics src/app.ts
node bin/aflow.js lsp hover src/app.ts 12 5
node bin/aflow.js lsp definition src/app.ts 12 5
```

## Registered servers

Servers are looked up by file extension. The table lives in
[`src/core/lsp/registry.js`](../src/core/lsp/registry.js) and is data, not code:

| Language | Extensions | Command | Install |
|---|---|---|---|
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `typescript-language-server --stdio` | `npm i -g typescript-language-server typescript` |
| Rust | `.rs` | `rust-analyzer` | `rustup component add rust-analyzer` |
| Go | `.go` | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| C / C++ | `.c .h .cc .cpp .cxx .hpp .hxx .hh` | `clangd` | install clangd (ships with LLVM) |
| Python | `.py .pyi` | `pylsp` | `pip install python-lsp-server` |
| HTML | `.html .htm` | `vscode-html-language-server --stdio` | `npm i -g vscode-langservers-extracted` |
| CSS | `.css .scss .less` | `vscode-css-language-server --stdio` | `npm i -g vscode-langservers-extracted` |
| JSON | `.json .jsonc` | `vscode-json-language-server --stdio` | `npm i -g vscode-langservers-extracted` |

`aflow lsp status` probes each with `where` (Windows) or `which` (elsewhere) and
never throws — a missing server is a normal state, reported with its install
command. `aflow doctor` reports the same as an informational check.

## The self-correction loop

This is the part that earns the integration its place. Inside an agent run:

1. The model calls `filesystem.write`.
2. If the write succeeds and a server is available, the bridge opens (or
   refreshes) the written file in the server.
3. The server re-analyses it and publishes diagnostics; the collector records
   them, keyed by URI and revisioned.
4. On the next iteration, if there are error-severity diagnostics, a block is
   appended to the prompt:

   ```
   [lsp] recent language-server errors:
   - src/app.ts:12:5 'x' is possibly undefined
   Address these errors before continuing.
   ```

5. The model sees the consequences of its own edit and fixes them in the same
   task.

The block is empty (and omitted) when there is nothing to report, so the caller
can append it unconditionally. The whole step is wrapped: a slow, absent, or
broken server logs a warning at most and never turns a good write into a failed
tool call. The wait for diagnostics is revisioned and bounded, so a server that
stays silent is a timeout, not a hang.

## Agent tools

Four read-scoped tools are registered onto the runtime's tool map when a server
is configured:

| Tool | Returns |
|---|---|
| `lsp.status` | whether a server is running, its name, its capabilities, the current error count |
| `lsp.diagnostics` | diagnostics for one file (re-analysed), or every current error |
| `lsp.hover` | hover text at a `file line column` (1-based) |
| `lsp.definition` | definition location(s) for a symbol |

They are registered by `registerLspTools(runtime)` rather than merged into the
frozen real-tool set, so the exact-list contract of the built-in tools does not
change shape when a language server happens to be installed.

## Process supervision

A language server is a long-lived child process, and two things must never
happen: it must not take AgentFlow down with it, and a crash must not silently
disable every LSP feature for the rest of the session.

[`src/core/lsp/process.js`](../src/core/lsp/process.js) owns the child lifecycle.
It frames the streams, emits every state change as an event (`message`,
`stderr`, `restart`, `error`, `exit`), and restarts on an unexpected exit with a
bounded backoff (`restartDelayMs × attempt`, up to `maxRestarts`). A restarted
server starts from a clean decoder. Shutdown is graceful first (`shutdown` then
`exit` over the protocol), then escalates to a hard kill, and on Windows the
kill takes the whole tree with `taskkill /T /F`.

## Layout

| File | Responsibility |
|---|---|
| `framing.js` | JSON-RPC 2.0 base-protocol framing over a byte stream |
| `process.js` | spawn, supervise, restart, and kill the server |
| `registry.js` | which server speaks for which extension; PATH detection |
| `client.js` | request/response, ids, the document lifecycle, path↔URI |
| `diagnostics.js` | collect and query published diagnostics |
| `capabilities.js` | hover, definition, completion, document symbols |
| `agent-bridge.js` | feed diagnostics back into an agent run |
| `tools.js` | the four `lsp.*` agent tools |

## Testing

The suite (`test/lsp/`) drives the real stack against a mock language server
([`test/lsp/fixtures/mock-ls.js`](../test/lsp/fixtures/mock-ls.js)) that speaks
the actual protocol over a real pipe — framing, supervision, handshake,
diagnostics, and the self-correction loop are exercised end to end, not stubbed.
A second fixture ([`test/lsp/fixtures/crash-ls.js`](../test/lsp/fixtures/crash-ls.js))
always crashes, to cover the restart backoff and exhaustion.
