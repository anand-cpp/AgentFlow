// Hackathon persistence tests — session save and load.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSession, validateSession, persistSession, loadSession,
} from "../../../src/core/hackathon/session.js";

describe("Persistence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hackathon-persist-"));
  after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* cleanup best-effort */
    }
  });

  it("persists and loads a session", async () => {
    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });
    session.status = "active";

    await persistSession(dir, session);

    const file = path.join(dir, `${session.id}.json`);
    assert.ok(fs.existsSync(file));

    const result = loadSession(dir, session.id);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value.id, session.id);
    assert.strictEqual(result.value.leaderId, "leader-1");
    assert.strictEqual(result.value.status, "active");
    assert.strictEqual(result.value.projectIdea, "build a todo app");
  });

  it("rejects loading a missing session", () => {
    const result = loadSession(dir, "nonexistent-session");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "missing");
  });

  it("rejects loading a session with wrong version", async () => {
    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    await persistSession(dir, session);

    // Corrupt the version on disk.
    const file = path.join(dir, `${session.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.version = 99;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));

    assert.throws(() => loadSession(dir, session.id), /version 99/);
  });

  it("redacts secrets before persisting", async () => {
    const session = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    // Inject a secret-like field.
    session.apiKey = "sk-1234567890abcdef";

    await persistSession(dir, session);

    const file = path.join(dir, `${session.id}.json`);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("sk-1234567890abcdef"), "secret should be redacted");
  });

  it("validateSession throws on invalid session", () => {
    assert.throws(() => validateSession(null), /must be an object/);
    assert.throws(() => validateSession({}), /unsupported session version/);
  });
});
