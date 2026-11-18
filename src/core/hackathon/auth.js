// Worker authentication for Hackathon Mode.
//
// Short-lived scoped invitation credentials. Workers authenticate with a
// session-scoped token that expires. Revocation is supported. No provider API
// keys or secrets are transferred between computers.

import crypto from "node:crypto";
import { createInvitationToken } from "./session.js";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes default

/** Worker identity. */
export function createWorkerIdentity({ workerId, sessionId, publicKey = null } = {}) {
  if (!workerId) throw new Error("workerId required");
  if (!sessionId) throw new Error("sessionId required");
  return {
    workerId,
    sessionId,
    publicKey,
    createdAt: new Date().toISOString(),
  };
}

/** Issue a short-lived invitation credential for a worker to join a session. */
export function issueInvitation({ sessionId, workerId, ttlMs = TOKEN_TTL_MS } = {}) {
  if (!sessionId) throw new Error("sessionId required");
  if (!workerId) throw new Error("workerId required");

  const token = createInvitationToken({ sessionId, workerId, ttlMs });
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;

  return {
    token,
    workerId,
    sessionId,
    issuedAt,
    expiresAt,
    ttlMs,
  };
}

/** Validate an invitation credential against a worker record. */
export function validateInvitation(credential, { workerRecord, now = Date.now() } = {}) {
  if (!credential || !credential.token) {
    return { ok: false, reason: "missing credential" };
  }
  if (!workerRecord) {
    return { ok: false, reason: "worker not registered" };
  }
  if (workerRecord.status === "revoked") {
    return { ok: false, reason: "worker revoked" };
  }
  if (workerRecord.invitationToken !== credential.token) {
    return { ok: false, reason: "token mismatch" };
  }
  if (now > credential.expiresAt) {
    return { ok: false, reason: "invitation expired" };
  }
  return { ok: true, workerId: workerRecord.workerId };
}

/** Revoke a worker's invitation. */
export function revokeInvitation(workerRecord) {
  if (!workerRecord) return false;
  workerRecord.invitationToken = null;
  workerRecord.status = "revoked";
  workerRecord.revokedAt = new Date().toISOString();
  return true;
}

/** Generate a worker-scoped nonce for request signing (replay protection). */
export function createNonce() {
  return crypto.randomBytes(16).toString("hex");
}

export default {
  createWorkerIdentity,
  issueInvitation,
  validateInvitation,
  revokeInvitation,
  createNonce,
  TOKEN_TTL_MS,
};
