// Device registry for Hackathon Mode.
//
// Tracks enrolled devices through the approval workflow:
//   invited -> registered -> pending_approval -> approved | rejected | revoked
//
// A device must be explicitly approved by the Admin before it can receive
// project tasks. Approval is recorded with the approver's identity and a
// timestamp for audit purposes. Revocation immediately isolates the device.
//
// No provider credentials or secrets are stored on device records.

export const DEVICE_STATUS = {
  INVITED: "invited",
  REGISTERED: "registered",
  PENDING_APPROVAL: "pending_approval",
  APPROVED: "approved",
  REJECTED: "rejected",
  REVOKED: "revoked",
};

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A device record in the registry. */
export function createDeviceRecord({
  deviceId,
  sessionId,
  publicKey = null,
  deviceInfo = null,
  invitationToken = null,
  status = DEVICE_STATUS.REGISTERED,
} = {}) {
  if (!DEVICE_ID_RE.test(deviceId)) throw new Error("invalid deviceId");
  if (!sessionId) throw new Error("sessionId required");

  return {
    deviceId,
    sessionId,
    publicKey,
    deviceInfo,
    invitationToken,
    status,
    registeredAt: new Date().toISOString(),
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    revokedAt: null,
    revokedReason: null,
    lastHeartbeat: null,
    currentTaskId: null,
    completedTaskIds: [],
    failedTaskIds: [],
  };
}

/**
 * DeviceRegistry — enrollment and approval lifecycle for worker devices.
 *
 * Separated from worker task state: a device can be registered (invitation
 * validated) without being approved. Only approved devices receive project
 * task assignments.
 */
export class DeviceRegistry {
  constructor() {
    this.devices = new Map(); // deviceId -> DeviceRecord
    this._approvalLog = []; // audit entries
  }

  /** Register a device after invitation validation. Returns the device record. */
  registerDevice({
    deviceId,
    sessionId,
    publicKey = null,
    deviceInfo = null,
    invitationToken = null,
  } = {}) {
    if (this.devices.has(deviceId)) {
      throw new Error(`device already registered: ${deviceId}`);
    }

    const record = createDeviceRecord({
      deviceId,
      sessionId,
      publicKey,
      deviceInfo,
      invitationToken,
      status: DEVICE_STATUS.REGISTERED,
    });
    this.devices.set(deviceId, record);
    return { ...record };
  }

  /** Move a device to pending_approval (pre-flight checks completed). */
  markPendingApproval(deviceId) {
    const record = this.devices.get(deviceId);
    if (!record) throw new Error(`unknown device: ${deviceId}`);
    if (record.status !== DEVICE_STATUS.REGISTERED) {
      throw new Error(
        `device ${deviceId} is ${record.status}, cannot mark pending approval`,
      );
    }
    record.status = DEVICE_STATUS.PENDING_APPROVAL;
    return { ...record };
  }

  /** Approve a device. Requires explicit Admin approval. */
  approveDevice({ deviceId, approvedBy } = {}) {
    if (!deviceId) throw new Error("deviceId required");
    if (!approvedBy) throw new Error("approvedBy required");
    const record = this.devices.get(deviceId);
    if (!record) throw new Error(`unknown device: ${deviceId}`);
    if (record.status !== DEVICE_STATUS.REGISTERED &&
        record.status !== DEVICE_STATUS.PENDING_APPROVAL) {
      throw new Error(
        `device ${deviceId} is ${record.status}, not pending approval`,
      );
    }

    record.status = DEVICE_STATUS.APPROVED;
    record.approvedAt = new Date().toISOString();
    record.approvedBy = approvedBy;

    this._approvalLog.push({
      deviceId,
      action: "approve",
      approvedBy,
      at: record.approvedAt,
    });

    return { ...record };
  }

  /** Reject a device. */
  rejectDevice({ deviceId, rejectedBy, reason } = {}) {
    if (!deviceId) throw new Error("deviceId required");
    if (!rejectedBy) throw new Error("rejectedBy required");
    const record = this.devices.get(deviceId);
    if (!record) throw new Error(`unknown device: ${deviceId}`);
    if (record.status !== DEVICE_STATUS.REGISTERED &&
        record.status !== DEVICE_STATUS.PENDING_APPROVAL &&
        record.status !== DEVICE_STATUS.APPROVED) {
      throw new Error(
        `device ${deviceId} is ${record.status}, cannot reject`,
      );
    }

    record.status = DEVICE_STATUS.REJECTED;
    record.rejectionReason = reason || null;

    this._approvalLog.push({
      deviceId,
      action: "reject",
      rejectedBy,
      reason,
      at: new Date().toISOString(),
    });

    return { ...record };
  }

  /** Revoke a device (immediate isolation). */
  revokeDevice({ deviceId, revokedBy, reason } = {}) {
    if (!deviceId) throw new Error("deviceId required");
    if (!revokedBy) throw new Error("revokedBy required");
    const record = this.devices.get(deviceId);
    if (!record) throw new Error(`unknown device: ${deviceId}`);
    if (record.status === DEVICE_STATUS.REVOKED) {
      return { ...record }; // already revoked
    }

    record.status = DEVICE_STATUS.REVOKED;
    record.revokedAt = new Date().toISOString();
    record.revokedReason = reason || null;
    record.currentTaskId = null;

    this._approvalLog.push({
      deviceId,
      action: "revoke",
      revokedBy,
      reason,
      at: record.revokedAt,
    });

    return { ...record };
  }

  /** Get a device record by id. */
  getDevice(deviceId) {
    const record = this.devices.get(deviceId);
    return record ? { ...record } : null;
  }

  /** List devices matching a status filter. */
  listDevices(status = null) {
    const out = [];
    for (const [_deviceId, record] of this.devices) {
      if (status === null || record.status === status) {
        out.push({ ...record });
      }
    }
    return out;
  }

  /** List pending approval devices (awaiting Admin decision). */
  getPendingApproval() {
    return this.listDevices(DEVICE_STATUS.PENDING_APPROVAL);
  }

  /** List approved devices. */
  getApprovedDevices() {
    return this.listDevices(DEVICE_STATUS.APPROVED);
  }

  /** Check whether a device is approved. */
  isApproved(deviceId) {
    const record = this.devices.get(deviceId);
    return record ? record.status === DEVICE_STATUS.APPROVED : false;
  }

  /** Check whether a device can receive tasks (registered + approved). */
  canReceiveTasks(deviceId) {
    return this.isApproved(deviceId);
  }

  /** Update a device's heartbeat. */
  heartbeat(deviceId) {
    const record = this.devices.get(deviceId);
    if (!record) return false;
    record.lastHeartbeat = new Date().toISOString();
    return true;
  }

  /** Get the approval audit log. */
  getApprovalLog() {
    return this._approvalLog.slice();
  }

  /** Number of devices by status. */
  getStats() {
    const stats = {};
    for (const status of Object.values(DEVICE_STATUS)) {
      stats[status] = 0;
    }
    for (const record of this.devices.values()) {
      stats[record.status] = (stats[record.status] || 0) + 1;
    }
    return stats;
  }
}

export default {
  DEVICE_STATUS,
  createDeviceRecord,
  DeviceRegistry,
};
