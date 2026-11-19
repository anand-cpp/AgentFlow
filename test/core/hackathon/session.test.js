// Hackathon session tests — validates session creation, records, and tokens.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSession,
  validateSession,
  createWorkerRecord,
  createTaskRecord,
  createLeaseRecord,
  createRiskRecord,
  createInvitationToken,
  validateInvitationToken,
  SESSION_STATUS,
  WORKER_STATUS,
  TASK_STATUS,
  LEASE_STATUS,
} from "../../../src/core/hackathon/session.js";

describe("Hackathon session", () => {
  it("creates a valid session", () => {
    const s = createSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });
    assert.ok(s.id);
    assert.strictEqual(s.leaderId, "leader-1");
    assert.strictEqual(s.projectIdea, "build a todo app");
    assert.strictEqual(s.status, SESSION_STATUS.CREATED);
    assert.ok(s.createdAt);
    assert.ok(s.updatedAt);
    assert.deepStrictEqual(s.workers, {});
    assert.deepStrictEqual(s.tasks, {});
  });

  it("rejects missing leaderId", () => {
    assert.throws(() =>
      createSession({ projectIdea: "x", projectRoot: "/tmp" }),
    /leaderId/);
  });

  it("rejects invalid leaderId", () => {
    assert.throws(() =>
      createSession({ leaderId: "bad id!", projectIdea: "x", projectRoot: "/tmp" }),
    /invalid leaderId/);
  });

  it("validateSession accepts a valid session", () => {
    const s = createSession({
      leaderId: "leader-1",
      projectIdea: "build a todo app",
      projectRoot: "/tmp/proj",
    });
    assert.strictEqual(validateSession(s), true);
  });

  it("validateSession rejects wrong version", () => {
    const s = createSession({
      leaderId: "leader-1",
      projectIdea: "x",
      projectRoot: "/tmp",
    });
    s.version = 99;
    assert.throws(() => validateSession(s), /unsupported session version/);
  });

  it("createWorkerRecord", () => {
    const w = createWorkerRecord({
      workerId: "worker-1",
      invitationToken: "tok-abc",
      capabilities: ["node", "typescript"],
    });
    assert.strictEqual(w.workerId, "worker-1");
    assert.strictEqual(w.status, WORKER_STATUS.REGISTERED);
    assert.deepStrictEqual(w.capabilities, ["node", "typescript"]);
    assert.strictEqual(w.connectedAt, null);
  });

  it("createTaskRecord defaults", () => {
    const t = createTaskRecord({
      taskId: "task-1",
      title: "Add endpoint",
      objective: "Create a health check endpoint",
    });
    assert.strictEqual(t.taskId, "task-1");
    assert.strictEqual(t.status, TASK_STATUS.PENDING);
    assert.strictEqual(t.state, TASK_STATUS.PENDING);
    assert.strictEqual(t.priority, "medium");
    assert.strictEqual(t.version, 1);
    assert.deepStrictEqual(t.dependencies, []);
  });

  it("createLeaseRecord", () => {
    const l = createLeaseRecord({
      leaseId: "lease-1",
      taskId: "task-1",
      workerId: "worker-1",
      expiresAt: "2026-12-01T00:00:00Z",
    });
    assert.strictEqual(l.leaseId, "lease-1");
    assert.strictEqual(l.status, LEASE_STATUS.ACTIVE);
    assert.strictEqual(l.revokedAt, null);
  });

  it("createRiskRecord", () => {
    const r = createRiskRecord({
      riskId: "risk-1",
      severity: "high",
      description: "API mismatch",
      evidence: [{ kind: "commit", value: "abc123" }],
    });
    assert.strictEqual(r.riskId, "risk-1");
    assert.strictEqual(r.severity, "high");
    assert.strictEqual(r.status, "open");
    assert.deepStrictEqual(r.resolutionHistory, []);
  });

  it("createInvitationToken produces a string", () => {
    const tok = createInvitationToken({
      sessionId: "sess-1",
      workerId: "worker-1",
    });
    assert.strictEqual(typeof tok, "string");
    assert.ok(tok.length > 16);
  });

  it("validateInvitationToken accepts a well-formed token", () => {
    const tok = createInvitationToken({
      sessionId: "sess-1",
      workerId: "worker-1",
    });
    const res = validateInvitationToken(tok);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.expired, false);
  });

  it("validateInvitationToken rejects empty", () => {
    assert.strictEqual(validateInvitationToken("").ok, false);
    assert.strictEqual(validateInvitationToken("short").ok, false);
  });
});
