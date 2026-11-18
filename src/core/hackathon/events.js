// Hackathon Mode event protocol.
//
// Structured events for coordinator↔worker communication. Every event carries
// identity (session, worker, task), a sequence number, and a validated payload.
// Events are the source of truth for progress and state reconciliation.
//
// Event types:
//
//   WORKER_REGISTERED   worker authenticated and joined the session
//   WORKER_CONNECTED    worker transport connection established
//   WORKER_DISCONNECTED worker transport connection lost
//   WORKER_HEARTBEAT    worker liveness check-in
//   WORKER_RECONNECTED  worker reconnected after disconnect
//   TASK_DISPATCHED     coordinator assigned a task contract to a worker
//   TASK_ACCEPTED       worker accepted a dispatched task
//   TASK_STARTED        worker began executing a task
//   TASK_PROGRESS       worker reported progress on a task
//   TASK_BLOCKED        worker reported a blocker on a task
//   TASK_COMPLETED      worker reported task completion with evidence
//   TASK_FAILED         worker reported task failure
//   TASK_CANCELLED      task cancelled by coordinator or worker
//   LEASE_RENEWED       task lease extended
//   LEASE_EXPIRED       task lease expired
//   TASK_REASSIGNED     task reassigned to a different worker

import crypto from "node:crypto";

export const HACKATHON_EVENTS = {
  WORKER_REGISTERED: "hackathon.worker_registered",
  WORKER_CONNECTED: "hackathon.worker_connected",
  WORKER_DISCONNECTED: "hackathon.worker_disconnected",
  WORKER_HEARTBEAT: "hackathon.worker_heartbeat",
  WORKER_RECONNECTED: "hackathon.worker_reconnected",
  TASK_DISPATCHED: "hackathon.task_dispatched",
  TASK_ACCEPTED: "hackathon.task_accepted",
  TASK_STARTED: "hackathon.task_started",
  TASK_PROGRESS: "hackathon.task_progress",
  TASK_BLOCKED: "hackathon.task_blocked",
  TASK_COMPLETED: "hackathon.task_completed",
  TASK_FAILED: "hackathon.task_failed",
  TASK_CANCELLED: "hackathon.task_cancelled",
  LEASE_RENEWED: "hackathon.lease_renewed",
  LEASE_EXPIRED: "hackathon.lease_expired",
  TASK_REASSIGNED: "hackathon.task_reassigned",
};

const EVENT_TYPES = new Set(Object.values(HACKATHON_EVENTS));

export const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB message-size limit

/** A validated Hackathon event. */
export class HackathonEvent {
  constructor({
    eventId = null,
    sessionId = null,
    workerId = null,
    taskId = null,
    sequence = 0,
    type = null,
    payload = {},
    timestamp = null,
  } = {}) {
    this.eventId = eventId || `ev-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    this.sessionId = sessionId;
    this.workerId = workerId;
    this.taskId = taskId;
    this.sequence = sequence;
    this.type = type;
    this.payload = payload;
    this.timestamp = timestamp || new Date().toISOString();
  }

  toJSON() {
    return {
      eventId: this.eventId,
      sessionId: this.sessionId,
      workerId: this.workerId,
      taskId: this.taskId,
      sequence: this.sequence,
      type: this.type,
      payload: this.payload,
      timestamp: this.timestamp,
    };
  }

  static fromJSON(json) {
    return new HackathonEvent(json);
  }
}

/** Validate an event. Throws on invalid. */
export function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("event must be an object");
  }
  if (!event.eventId || typeof event.eventId !== "string") {
    throw new Error("event requires an eventId");
  }
  if (!event.sessionId || typeof event.sessionId !== "string") {
    throw new Error("event requires a sessionId");
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new Error(`unknown event type: ${event.type}`);
  }
  if (typeof event.sequence !== "number" || event.sequence < 0) {
    throw new Error("event requires a non-negative sequence number");
  }
  if (!event.timestamp || typeof event.timestamp !== "string") {
    throw new Error("event requires a timestamp");
  }
  // Message-size limit: serialized payload must not exceed the cap.
  const size = Buffer.byteLength(JSON.stringify(event.payload || {}), "utf8");
  if (size > MAX_PAYLOAD_BYTES) {
    throw new Error(`event payload exceeds ${MAX_PAYLOAD_BYTES} byte limit`);
  }
  return true;
}

/** Create a new event with validation. */
export function createEvent({ sessionId, workerId = null, taskId = null, sequence = 0, type, payload = {} } = {}) {
  const event = new HackathonEvent({ sessionId, workerId, taskId, sequence, type, payload });
  validateEvent(event);
  return event;
}

export default {
  HACKATHON_EVENTS,
  HackathonEvent,
  validateEvent,
  createEvent,
  MAX_PAYLOAD_BYTES,
};
