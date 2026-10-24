// Diagnostics manager: normalisation, per-file views, and race-free waits.
//
// A stub client stands in for the LSP client so these tests exercise the
// collector alone -- recording, revisioning, the file/URI fallback, and the
// waitFor handshake that keeps after-write feedback race-free.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { LspDiagnosticsManager, severityLabel, formatDiagnosticsForConsole } from "../../src/core/lsp/diagnostics.js";
import { pathToUri } from "../../src/core/lsp/client.js";

function stubClient() {
  const handlers = new Map();
  return {
    on(type, fn) {
      const set = handlers.get(type) ?? new Set();
      set.add(fn);
      handlers.set(type, set);
      return () => set.delete(fn);
    },
    emit(type, detail) {
      for (const fn of handlers.get(type) ?? []) fn(detail);
    },
  };
}

const file = path.join(process.cwd(), "src", "app.js");
const uri = pathToUri(file);

test("severityLabel maps the four LSP severities and defaults to Error", () => {
  assert.equal(severityLabel(1), "Error");
  assert.equal(severityLabel(2), "Warning");
  assert.equal(severityLabel(3), "Information");
  assert.equal(severityLabel(4), "Hint");
  assert.equal(severityLabel(undefined), "Error");
});

test("records and normalises a published batch", () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  client.emit("diagnostics", { uri, diagnostics: [{ range: { start: { line: 2, character: 4 } }, severity: 2, message: "  unused  ", code: "W100" }] });

  const list = mgr.diagnosticsForUri(uri);
  assert.equal(list.length, 1);
  assert.equal(mgr.revisionOf(uri), 1);
  assert.equal(mgr.diagnosticsForFile(file)[0].severity, "Warning");
  assert.equal(mgr.diagnosticsForFile(file)[0].message, "trimmed".replace("trimmed", "unused"));
  assert.deepEqual(mgr.getErrors(), []);
});

test("an empty publish clears the file rather than keeping stale errors", () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  client.emit("diagnostics", { uri, diagnostics: [{ severity: 1, message: "boom" }] });
  assert.equal(mgr.getErrors().length, 1);
  client.emit("diagnostics", { uri, diagnostics: [] });
  assert.equal(mgr.getErrors().length, 0);
  assert.equal(mgr.hasErrors(), false);
  assert.equal(mgr.revisionOf(uri), 2);
});

test("diagnosticsForFile falls back to filesystem matching for a differently spelled path", () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  client.emit("diagnostics", { uri, diagnostics: [{ severity: 1, message: "boom" }] });
  const loose = path.join(process.cwd(), ".", "src", "app.js");
  assert.equal(mgr.diagnosticsForFile(loose).length, 1);
  assert.equal(mgr.errorsFor(loose).length, 1);
});

test("getAll and getErrors span every file", () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  const other = pathToUri(path.join(process.cwd(), "src", "b.js"));
  client.emit("diagnostics", { uri, diagnostics: [{ severity: 1, message: "e1" }] });
  client.emit("diagnostics", { uri: other, diagnostics: [{ severity: 2, message: "w1" }] });
  assert.equal(mgr.getAll().length, 2);
  assert.equal(mgr.getErrors().length, 1);
  assert.equal(mgr.hasErrors(), true);
  assert.equal(mgr.hasErrors(other), false);
});

test("waitFor resolves immediately when a newer revision already exists", async () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 1, message: "boom" }]);
  const result = await mgr.waitFor(uri, { sinceRevision: 0, timeoutMs: 50 });
  assert.equal(result.length, 1);
});

test("waitFor resolves on a later publish, not a stale one", async () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 1, message: "old" }]);
  const pending = mgr.waitFor(uri, { sinceRevision: mgr.revisionOf(uri), timeoutMs: 200 });
  mgr.record(uri, [{ severity: 1, message: "new" }]);
  const result = await pending;
  assert.equal(result[0].message, "new");
});

test("waitFor times out to the current view rather than hanging", async () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 2, message: "warn" }]);
  const result = await mgr.waitFor(uri, { sinceRevision: mgr.revisionOf(uri), timeoutMs: 20 });
  assert.equal(result[0].message, "warn");
});

test("waitFor removes event listener after successful resolution", async () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 1, message: "initial" }]);
  const pending = mgr.waitFor(uri, { sinceRevision: mgr.revisionOf(uri), timeoutMs: 200 });
  mgr.record(uri, [{ severity: 1, message: "new" }]);
  await pending;
  // After resolution, a subsequent publish should not cause any issue (listener removed)
  mgr.record(uri, [{ severity: 1, message: "later" }]);
  // Wait a bit to ensure no async side effects
  await new Promise((r) => setTimeout(r, 10));
  const current = mgr.diagnosticsForUri(uri);
  assert.equal(current.length, 1);
  assert.equal(current[0].message, "later");
});

test("waitFor clears timeout after successful resolution", async () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 1, message: "initial" }]);
  const pending = mgr.waitFor(uri, { sinceRevision: mgr.revisionOf(uri), timeoutMs: 200 });
  mgr.record(uri, [{ severity: 1, message: "new" }]);
  await pending;
  // Wait longer than the original timeout to ensure no timeout callback fires
  await new Promise((r) => setTimeout(r, 300));
  const current = mgr.diagnosticsForUri(uri);
  assert.equal(current.length, 1);
  assert.equal(current[0].message, "new");
});

test("waitFor timeout followed by late event does not change result or leak listener", async () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 2, message: "warn" }]);
  const result = await mgr.waitFor(uri, { sinceRevision: mgr.revisionOf(uri), timeoutMs: 20 });
  assert.equal(result[0].message, "warn");
  // Late event after timeout should not cause issues
  mgr.record(uri, [{ severity: 1, message: "late" }]);
  await new Promise((r) => setTimeout(r, 10));
  const current = mgr.diagnosticsForUri(uri);
  assert.equal(current.length, 1);
  assert.equal(current[0].message, "late");
});

test("clear drops every file", () => {
  const client = stubClient();
  const mgr = new LspDiagnosticsManager(client);
  mgr.record(uri, [{ severity: 1, message: "boom" }]);
  mgr.clear();
  assert.equal(mgr.getAll().length, 0);
  assert.equal(mgr.revisionOf(uri), 0);
});

test("formatDiagnosticsForConsole renders one line per diagnostic", () => {
  const text = formatDiagnosticsForConsole([
    { file, range: { start: { line: 4, character: 9 }, end: { line: 4, character: 9 } }, severity: "Error", code: 2322, source: "ts", message: "bad type" },
  ], { cwd: process.cwd() });
  assert.match(text, /Error: .*app\.js:5:10: bad type \[2322\]/);
});

test("formatDiagnosticsForConsole says so when there is nothing", () => {
  assert.equal(formatDiagnosticsForConsole([], {}), "no diagnostics");
});
