// Worker authentication for Hackathon Mode.
//
// Short-lived scoped invitation credentials. Workers authenticate with a
// session-scoped token that expires. Revocation is supported. No provider API
// keys or secrets are transferred between computers.

import crypto from "node:crypto";
import { createInvitationToken } from "./session.js";

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes default
const NONCE_TTL_MS = 5 * 60 * 1000; // nonces expire after 5 minutes

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

  // Expiration: prefer the credential's expiresAt, fall back to the
  // worker record's stored invitationExpiresAt (set when the invitation
  // was created). This ensures expired invitations are rejected even when
  // callers only pass the token.
  const expiresAt = credential.expiresAt
    ? new Date(credential.expiresAt)
    : workerRecord.invitationExpiresAt
      ? new Date(workerRecord.invitationExpiresAt)
      : null;
  if (expiresAt && now > expiresAt.getTime()) {
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

/**
 * NonceTracker — replay protection for worker requests.
 *
 * Tracks used nonces so each nonce can only be accepted once within its TTL.
 * Expired nonces are garbage-collected on check.
 */
export class NonceTracker {
  constructor({ ttlMs = NONCE_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this._nonces = new Map(); // nonce -> expiry timestamp
  }

  /** Record a nonce as used. Returns false if the nonce was already used. */
  use(nonce, now = Date.now()) {
    if (this._nonces.has(nonce)) return false;
    this._nonces.set(nonce, now + this.ttlMs);
    return true;
  }

  /** Check whether a nonce is fresh (not yet used). Does not mark it as used. */
  isFresh(nonce, _now = Date.now()) {
    if (this._nonces.has(nonce)) return false;
    return true;
  }

  /** Garbage-collect expired nonces. Returns the count removed. */
  gc(now = Date.now()) {
    let removed = 0;
    for (const [nonce, expiry] of this._nonces) {
      if (now > expiry) {
        this._nonces.delete(nonce);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of tracked (non-expired) nonces. */
  size(now = Date.now()) {
    this.gc(now);
    return this._nonces.size;
  }
}

export default {
  createWorkerIdentity,
  issueInvitation,
  validateInvitation,
  revokeInvitation,
  createNonce,
  NonceTracker,
  TOKEN_TTL_MS,
};
