// A minimal, deterministic Language Server used by the LSP test-suite.
//
// It implements just enough of the protocol to drive every client path without
// requiring typescript-language-server et al. to be installed: handshake, the
// document sync lifecycle, hover / definition / completion / symbols, and a
// diagnostic rule that flags the literal token `BAD` so self-correction can be
// tested end to end. It reuses the real framing code -- if framing is broken,
// so is the mock, which is exactly the coupling we want.

import { LspFrameDecoder, encodeLspMessage } from "../../../src/core/lsp/framing.js";

const decoder = new LspFrameDecoder();
const docs = new Map();
let shuttingDown = false;

function send(message) {
  process.stdout.write(encodeLspMessage(message));
}

function diagnosticsFor(text) {
  const diagnostics = [];
  const idx = typeof text === "string" ? text.indexOf("BAD") : -1;
  if (idx !== -1) {
    const before = text.slice(0, idx);
    const line = before.split("\n").length - 1;
    const character = idx - (before.lastIndexOf("\n") + 1);
    diagnostics.push({
      range: { start: { line, character }, end: { line, character: character + 3 } },
      severity: 1,
      code: "mock/bad-token",
      source: "mock-ls",
      message: "found forbidden token BAD",
    });
  }
  return diagnostics;
}

function publish(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics: diagnosticsFor(docs.get(uri) ?? "") },
  });
}

function handle(message) {
  if (!message || typeof message.method !== "string") return;
  const { method, id, params } = message;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            definitionProvider: true,
            completionProvider: { triggerCharacters: ["."] },
            documentSymbolProvider: true,
          },
          serverInfo: { name: "mock-ls", version: "0.0.1" },
        },
      });
      break;
    case "initialized":
    case "$/cancelRequest":
      break;
    case "textDocument/didOpen":
      docs.set(params.textDocument.uri, params.textDocument.text);
      publish(params.textDocument.uri);
      break;
    case "textDocument/didChange":
      docs.set(params.textDocument.uri, params.contentChanges.at(-1).text);
      publish(params.textDocument.uri);
      break;
    case "textDocument/didSave":
      publish(params.textDocument.uri);
      break;
    case "textDocument/didClose":
      docs.delete(params.textDocument.uri);
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
      break;
    case "textDocument/hover":
      send({ jsonrpc: "2.0", id, result: { contents: { kind: "markdown", value: "**mock hover**" } } });
      break;
    case "textDocument/definition":
      send({
        jsonrpc: "2.0",
        id,
        result: { uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
      });
      break;
    case "textDocument/completion":
      send({ jsonrpc: "2.0", id, result: { isIncomplete: false, items: [{ label: "mockSymbol", kind: 6, detail: "mock" }] } });
      break;
    case "textDocument/documentSymbol":
      send({
        jsonrpc: "2.0",
        id,
        result: [
          {
            name: "mockSymbol",
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
          },
        ],
      });
      break;
    case "shutdown":
      shuttingDown = true;
      send({ jsonrpc: "2.0", id, result: null });
      break;
    case "exit":
      process.exit(shuttingDown ? 0 : 1);
      break;
    default:
      if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stdin.on("data", (chunk) => {
  for (const message of decoder.push(chunk)) handle(message);
});
process.stdin.on("end", () => process.exit(shuttingDown ? 0 : 1));
