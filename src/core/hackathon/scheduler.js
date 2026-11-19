// Task scheduler for Hackathon Mode.
//
// Matches tasks to workers by capability, manages leases (ownership with
// expiration + renewal), and handles reassignment when workers go offline.

import { createLeaseRecord, LEASE_STATUS } from "./session.js";

/** Schedule tasks to workers respecting capabilities, availability, and leases. */
export class Scheduler {
  constructor({ workers = new Map(), taskGraph = null, maxConcurrency = 8 } = {}) {
    this.workers = workers; // workerId -> WorkerRecord
    this.taskGraph = taskGraph;
    this.maxConcurrency = maxConcurrency;
    this.leases = new Map(); // leaseId -> LeaseRecord
    this.taskLeases = new Map(); // taskId -> leaseId
  }

  /** Register a worker's capabilities and availability. */
  registerWorker(workerId, { capabilities = [], available = true } = {}) {
    const rec = this.workers.get(workerId) || {};
    rec.capabilities = capabilities;
    rec.available = available;
    rec.lastSeen = new Date().toISOString();
    this.workers.set(workerId, rec);
  }

  /** Mark a worker as disconnected (leases not immediately revoked — offline work allowed). */
  workerDisconnected(workerId) {
    const rec = this.workers.get(workerId);
    if (rec) {
      rec.available = false;
      rec.disconnectedAt = new Date().toISOString();
    }
  }

  /** Mark a worker as reconnected. */
  workerReconnected(workerId) {
    const rec = this.workers.get(workerId);
    if (rec) {
      rec.available = true;
      rec.connectedAt = new Date().toISOString();
      rec.disconnectedAt = null;
    }
  }

  /** Check whether a worker can perform a task (capability + availability). */
  canPerform(workerId, task) {
    const worker = this.workers.get(workerId);
    if (!worker || !worker.available) return false;
    const required = task.requiredCapabilities || [];
    if (required.length && !required.every((c) => (worker.capabilities || []).includes(c))) {
      return false;
    }
    return true;
  }

  /** Find eligible workers for a task, sorted by availability then capability match. */
  eligibleWorkers(task) {
    const workers = [];
    for (const [workerId, worker] of this.workers) {
      if (this.canPerform(workerId, task)) {
        let score = 0;
        const required = task.requiredCapabilities || [];
        for (const c of required) {
          if ((worker.capabilities || []).includes(c)) score += 1;
        }
        workers.push({ workerId, score });
      }
    }
    workers.sort((a, b) => b.score - a.score || a.workerId.localeCompare(b.workerId));
    return workers.map((w) => w.workerId);
  }

  /** Create a lease for a task assigned to a worker. */
  createLease({ taskId, workerId, ttlMs = 10 * 60 * 1000 } = {}) {
    if (!taskId || !workerId) throw new Error("lease requires taskId and workerId");
    const leaseId = `lease-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const lease = createLeaseRecord({
      leaseId,
      taskId,
      workerId,
      expiresAt: new Date(now + ttlMs).toISOString(),
    });
    this.leases.set(leaseId, lease);
    this.taskLeases.set(taskId, leaseId);
    return lease;
  }

  /** Get the active lease for a task, or null. */
  getLease(taskId) {
    const leaseId = this.taskLeases.get(taskId);
    if (!leaseId) return null;
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    if (lease.status !== LEASE_STATUS.ACTIVE) return null;
    if (Date.now() > Date.parse(lease.expiresAt)) {
      this.expireLease(leaseId);
      return null;
    }
    return lease;
  }

  /** Renew a lease, extending its expiration. */
  renewLease(leaseId, { ttlMs = 10 * 60 * 1000 } = {}) {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error("unknown lease");
    if (lease.status !== LEASE_STATUS.ACTIVE) throw new Error("lease not active");
    lease.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    lease.renewedAt = new Date().toISOString();
    return lease;
  }

  /** Expire a lease (task becomes eligible for reassignment). */
  expireLease(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    lease.status = LEASE_STATUS.EXPIRED;
    lease.revokedAt = new Date().toISOString();
    if (this.taskLeases.get(lease.taskId) === leaseId) {
      this.taskLeases.delete(lease.taskId);
    }
    return true;
  }

  /** Revoke all leases for a worker (worker disconnected permanently). */
  revokeWorkerLeases(workerId) {
    const revoked = [];
    for (const [leaseId, lease] of this.leases) {
      if (lease.workerId === workerId && lease.status === LEASE_STATUS.ACTIVE) {
        this.expireLease(leaseId);
        revoked.push({ leaseId, taskId: lease.taskId });
      }
    }
    return revoked;
  }

  /** Complete a lease (task done). */
  completeLease(leaseId) {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    lease.status = LEASE_STATUS.COMPLETED;
    lease.completedAt = new Date().toISOString();
    if (this.taskLeases.get(lease.taskId) === leaseId) {
      this.taskLeases.delete(lease.taskId);
    }
    return true;
  }

  /** List expired leases needing reassignment. */
  expiredLeases() {
    const out = [];
    const now = Date.now();
    for (const [leaseId, lease] of this.leases) {
      if (lease.status === LEASE_STATUS.ACTIVE && now > Date.parse(lease.expiresAt)) {
        this.expireLease(leaseId);
        out.push(lease);
      }
    }
    return out;
  }

  /** Count active leases for a worker. */
  activeLeaseCount(workerId) {
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.workerId === workerId && lease.status === LEASE_STATUS.ACTIVE) count += 1;
    }
    return count;
  }
}

export default { Scheduler };
