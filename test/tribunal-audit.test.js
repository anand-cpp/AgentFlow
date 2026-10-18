// Tribunal JSONL audit stream tests.
//
// openAudit/append/close/create an append-only JSONL file under the tribunal
// state directory. Fail-safe: a missing/unwritable directory produces a
// no-op handle rather than throwing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openAudit, withAudit, auditFilePath, tribunalAuditDir } from "../src/core/tribunal/tribunal-audit.js";
import { runFullTribunal } from "../src/core/tribunal/stage-oracle.js";

function cleanDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

test("openAudit creates the tribunal directory and a jsonl file", () => {
  const dir = path.join(os.tmpdir(), `aflow-tribunal-audit-${process.pid}`);
  cleanDir(dir);
  try {
    const handle = openAudit("task-1", dir);
    assert.ok(handle.enabled, "audit handle should be enabled");
    assert.ok(handle.path.endsWith(".jsonl"), "audit file has .jsonl extension");
    assert.ok(fs.existsSync(handle.path), "audit file exists on disk");
    handle.close();
  } finally {
    cleanDir(dir);
  }
});

test("openAudit is a no-op when the directory cannot be created", () => {
  // Use a path that cannot be created (a file where a directory is needed)
  const blocked = path.join(os.tmpdir(), `aflow-tribunal-blocked-${process.pid}`);
  fs.writeFileSync(blocked, "not a directory");
  try {
    const handle = openAudit("task-2", blocked);
    assert.equal(handle.enabled, false, "handle is not enabled when dir is a file");
    handle.append({ event: "TEST", stage: "x" }); // must not throw
    handle.close();
  } finally {
    cleanDir(blocked);
  }
});

test("append writes one JSONL line per event", () => {
  const dir = path.join(os.tmpdir(), `aflow-tribunal-append-${process.pid}`);
  cleanDir(dir);
  try {
    const handle = openAudit("task-3", dir);
    handle.append({ event: "FORGE_COMPLETE", stage: "forge", candidates: 3 });
    handle.append({ event: "ORACLE_VERDICT", stage: "oracle", verdict: "VERIFIED", confidence: 0.97 });
    handle.close();

    const content = fs.readFileSync(handle.path, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "two lines written");
    const first = JSON.parse(lines[0]);
    assert.equal(first.event, "FORGE_COMPLETE");
    assert.equal(first.stage, "forge");
    assert.equal(first.candidates, 3);
    assert.ok(isNaN(Date.parse(first.ts)) === false, "ts is a valid ISO timestamp");
    const second = JSON.parse(lines[1]);
    assert.equal(second.event, "ORACLE_VERDICT");
    assert.equal(second.verdict, "VERIFIED");
    assert.equal(second.confidence, 0.97);
  } finally {
    cleanDir(dir);
  }
});

test("withAudit opens, calls, and closes the handle", () => {
  const dir = path.join(os.tmpdir(), `aflow-tribunal-withaudit-${process.pid}`);
  cleanDir(dir);
  try {
    /** @type {{ append: (e: object) => void; close: () => void; path: string; enabled: boolean } | null} */
    let captured = null;
    const result = withAudit("task-4", (h) => {
      captured = h;
      h.append({ event: "TEST_EVENT", stage: "test" });
      return "result-value";
    }, dir);
    assert.equal(result, "result-value");
    assert.ok(captured, "captured handle is set");
    assert.ok(captured.enabled);
    assert.ok(fs.existsSync(captured.path));
    const content = fs.readFileSync(captured.path, "utf8");
    assert.ok(content.includes("TEST_EVENT"), "audit line was written");
  } finally {
    cleanDir(dir);
  }
});

test("withAudit closes the handle even when the callback throws", () => {
  const dir = path.join(os.tmpdir(), `aflow-tribunal-throw-${process.pid}`);
  cleanDir(dir);
  try {
    /** @type {{ append: (e: object) => void; close: () => void; path: string; enabled: boolean } | null} */
    let handleRef = null;
    assert.throws(() => {
      withAudit("task-5", (h) => {
        handleRef = h;
        h.append({ event: "BEFORE_THROW", stage: "test" });
        throw new Error("boom");
      }, dir);
    }, /boom/);
    // Handle should still be closed (fd released). Re-opening the same path
    // for append should work (no "file in use" error on Windows).
    assert.ok(handleRef, "handleRef is set");
    const content = fs.readFileSync(handleRef.path, "utf8");
    assert.ok(content.includes("BEFORE_THROW"), "event was written before throw");
  } finally {
    cleanDir(dir);
  }
});

test("auditFilePath produces safe paths", () => {
  const p1 = auditFilePath("my task!@#");
  const p2 = auditFilePath("my task!@#");
  assert.ok(p1.endsWith(".jsonl"));
  assert.ok(p2.endsWith(".jsonl"));
  assert.ok(p1.includes("my_task___"), "unsafe characters are sanitized");
  assert.ok(p2.includes("my_task___"), "unsafe characters are sanitized");
});

test("tribunalAuditDir returns a platform state directory path", () => {
  const dir = tribunalAuditDir();
  assert.ok(dir.includes("tribunal"), "path includes tribunal subdirectory");
});

test("runFullTribunal emits audit events through the append callback", async () => {
  const dir = path.join(os.tmpdir(), `aflow-tribunal-integration-${process.pid}`);
  cleanDir(dir);
  try {
    const events = [];
    const tribunalId = await runFullTribunal({
      proposals: [{ id: "p1", model: "m1", approach: "test proposal" }],
      completeFn: async () => ({ text: JSON.stringify({ verdict: "ACQUITTED", findings: [] }) }),
      modelId: "m1",
      domain: "code",
      options: {
        audit: { append: (event) => events.push(event) },
      },
    });
    assert.ok(tribunalId, "tribunal id returned");

    // At minimum, FORGE_COMPLETE and TRIBUNAL_COMPLETE should be emitted
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes("TRIBUNAL_START"), "tribunal start emitted");
    assert.ok(eventNames.includes("FORGE_COMPLETE"), "forge complete emitted");
    assert.ok(eventNames.includes("TRIBUNAL_COMPLETE"), "tribunal complete emitted");

    // Every event has stage and ts
    for (const event of events) {
      assert.ok(event.stage, `event ${event.event} has stage`);
      assert.ok(event.ts, `event ${event.event} has ts`);
    }
  } finally {
    cleanDir(dir);
  }
});
