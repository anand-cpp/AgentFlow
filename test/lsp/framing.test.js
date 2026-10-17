// LSP framing: byte-length headers and arbitrary chunk boundaries.
//
// The frame decoder is the one place a language server can corrupt everything
// downstream: a wrong Content-Length desynchronises the stream. These tests pin
// the byte-vs-character distinction (non-ASCII) and the split-boundary case.

import test from "node:test";
import assert from "node:assert/strict";

import { LspFrameDecoder, encodeLspMessage, LspFramingError } from "../../src/core/lsp/framing.js";

test("encodes Content-Length as UTF-8 byte length, not character count", () => {
  const frame = encodeLspMessage({ jsonrpc: "2.0", method: "x", params: { m: "café" } });
  const header = frame.subarray(0, frame.indexOf("\r\n\r\n")).toString("latin1");
  const body = frame.subarray(frame.indexOf("\r\n\r\n") + 4);
  const json = body.toString("utf8");
  assert.equal(header, `Content-Length: ${Buffer.byteLength(json, "utf8")}`);
  assert.notEqual(json.length, Buffer.byteLength(json, "utf8")); // the é is 2 bytes
});

test("round-trips a message and reports nothing pending", () => {
  const decoder = new LspFrameDecoder();
  const messages = decoder.push(encodeLspMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(decoder.pending, 0);
});

test("reassembles a message split across chunks", () => {
  const decoder = new LspFrameDecoder();
  const frame = encodeLspMessage({ jsonrpc: "2.0", method: "ping" });
  const a = decoder.push(frame.subarray(0, 10));
  const b = decoder.push(frame.subarray(10));
  assert.equal(a.length, 0);
  assert.equal(b.length, 1);
  assert.equal(b[0].method, "ping");
});

test("decodes several messages from one chunk", () => {
  const decoder = new LspFrameDecoder();
  const chunk = Buffer.concat([encodeLspMessage({ id: 1 }), encodeLspMessage({ id: 2 }), encodeLspMessage({ id: 3 })]);
  const messages = decoder.push(chunk);
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3]);
});

test("treats the header name case-insensitively and ignores extra headers", () => {
  const decoder = new LspFrameDecoder();
  const body = Buffer.from(JSON.stringify({ id: 7 }), "utf8");
  const frame = Buffer.concat([
    Buffer.from(`content-LENGTH: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`, "latin1"),
    body,
  ]);
  assert.equal(decoder.push(frame)[0].id, 7);
});

test("throws on a missing Content-Length", () => {
  const decoder = new LspFrameDecoder();
  assert.throws(() => decoder.push(Buffer.from("Content-Type: x\r\n\r\n{}", "latin1")), (err) => err instanceof LspFramingError && err.code === "lsp_bad_header" && /Content-Length/.test(err.message));
});

test("throws on invalid JSON in the body", () => {
  const decoder = new LspFrameDecoder();
  const frame = Buffer.concat([Buffer.from("Content-Length: 5\r\n\r\n", "latin1"), Buffer.from("{oops", "utf8")]);
  assert.throws(() => decoder.push(frame), (err) => err instanceof LspFramingError && /invalid JSON/.test(err.message));
});

test("refuses a body larger than maxContentLength", () => {
  const decoder = new LspFrameDecoder({ maxContentLength: 4 });
  const frame = Buffer.concat([Buffer.from("Content-Length: 10\r\n\r\n", "latin1"), Buffer.from("0123456789", "utf8")]);
  assert.throws(() => decoder.push(frame), (err) => err instanceof LspFramingError && /larger|maxContentLength|10/.test(err.message));
});

test("reset drops a partial frame", () => {
  const decoder = new LspFrameDecoder();
  decoder.push(Buffer.from("Content-Length: 99\r\n\r\n{\"a\"", "latin1"));
  assert.ok(decoder.pending > 0);
  decoder.reset();
  assert.equal(decoder.pending, 0);
  assert.equal(decoder.push(encodeLspMessage({ id: 9 }))[0].id, 9);
});
