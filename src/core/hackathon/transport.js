// Hackathon Mode transport abstraction.
//
// Defines the transport interface for coordinator↔worker communication. The
// same event protocol works regardless of whether the underlying connection is
// local-process, LAN, or internet.
//
// Phase 2 implements LocalTransport only: coordinator and worker run in the
// same process, communicating through an in-memory message bus. This is real
// local-process communication — not mocked, not simulated.
//
// LAN and internet transports (WebSocket, relay) are NOT implemented in Phase 2
// and are clearly marked as NOT IMPLEMENTED. This phase does not expose any
// network listeners.

import { validateEvent, createEvent, HackathonEvent } from "./events.js";

/** Transport connection states. */
export const TRANSPORT_STATE = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  CLOSED: "closed",
};

/** Base transport class. Follows the MCP transport convention: connect/send/close
 *  with on/emit event listeners. Subclasses implement the actual wire protocol. */
export class HackathonTransport {
  constructor({ sessionId, workerId } = {}) {
    this.sessionId = sessionId;
    this.workerId = workerId;
    this.state = TRANSPORT_STATE.DISCONNECTED;
    this._listeners = new Map();
    this._sendQueue = [];
    this._maxMessageBytes = 64 * 1024;
  }

  /** Connect the transport. Subclasses implement. */
  async connect() {
    throw new Error("HackathonTransport.connect must be implemented");
  }

  /** Send a validated event over the transport. Subclasses implement. */
  async send(_event) {
    throw new Error("HackathonTransport.send must be implemented");
  }

  /** Close the transport. Subclasses implement. */
  async close() {
    this.state = TRANSPORT_STATE.CLOSED;
  }

  /** Register a listener for incoming events. */
  on(type, fn) {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Emit an event to all listeners of a type. */
  emit(type, detail) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(detail);
      } catch {
        /* swallow listener errors */
      }
    }
  }

  /** Validate and envelope an outgoing event. */
  _envelope(event) {
    if (!(event instanceof HackathonEvent)) {
      event = createEvent(event);
    }
    validateEvent(event);
    return event;
  }
}

export default {
  TRANSPORT_STATE,
  HackathonTransport,
};

/**
 * Local in-process transport for Phase 2.
 *
 * Coordinator and worker live in the same process. Messages are delivered
 * through an in-memory bus shared by the two endpoints. No network is used.
 * No listener is exposed on any network port.
 *
 * This is NOT LAN and NOT internet transport. It is explicitly marked as
 * local-process only.
 */
class LocalTransport extends HackathonTransport {
  constructor({ bus, sessionId, workerId } = {}) {
    super({ sessionId, workerId });
    if (!bus) throw new Error("LocalTransport requires a bus");
    this.bus = bus;
    this._subscriptionId = null;
  }

  async connect() {
    if (this.state !== TRANSPORT_STATE.DISCONNECTED) return;
    this.state = TRANSPORT_STATE.CONNECTING;
    this._subscriptionId = this.bus.subscribe(this.sessionId, (envelope) => {
      // Only deliver events addressed to this worker (or broadcast).
      if (envelope.workerId && envelope.workerId !== this.workerId) return;
      try {
        const ev = HackathonEvent.fromJSON(envelope);
        this.emit("message", ev);
      } catch {
        /* ignore malformed inbound messages */
      }
    });
    this.state = TRANSPORT_STATE.CONNECTED;
    this.emit("connect", { workerId: this.workerId, sessionId: this.sessionId });
  }

  async send(event) {
    const envelope = this._envelope(event);
    const serialized = envelope.toJSON();
    const size = Buffer.byteLength(JSON.stringify(serialized), "utf8");
    if (size > this._maxMessageBytes) {
      throw new Error(`message exceeds ${this._maxMessageBytes} byte limit`);
    }
    if (this.state !== TRANSPORT_STATE.CONNECTED) {
      throw new Error("transport not connected");
    }
    await this.bus.publish(this.sessionId, serialized);
    this.emit("sent", { eventId: envelope.eventId, type: envelope.type });
  }

  async close() {
    if (this._subscriptionId !== null) {
      this.bus.unsubscribe(this.sessionId, this._subscriptionId);
      this._subscriptionId = null;
    }
    this.state = TRANSPORT_STATE.CLOSED;
    this.emit("close", { workerId: this.workerId });
  }
}

/**
 * In-memory message bus for LocalTransport.
 *
 * Publish/subscribe within a single process. Multiple sessions are isolated
 * by session id. Each publish delivers to all subscribers of that session.
 */
class LocalBus {
  constructor() {
    this._subscriptions = new Map(); // sessionId -> Map(subscriptionId -> callback)
    this._nextSubId = 0;
  }

  /** Subscribe to messages for a session. Returns a subscription id. */
  subscribe(sessionId, callback) {
    if (!this._subscriptions.has(sessionId)) {
      this._subscriptions.set(sessionId, new Map());
    }
    const subs = this._subscriptions.get(sessionId);
    const id = this._nextSubId += 1;
    subs.set(id, callback);
    return id;
  }

  /** Unsubscribe a subscription. */
  unsubscribe(sessionId, subscriptionId) {
    const subs = this._subscriptions.get(sessionId);
    if (subs) subs.delete(subscriptionId);
  }

  /** Publish a message to all subscribers of a session. */
  async publish(sessionId, message) {
    const subs = this._subscriptions.get(sessionId);
    if (!subs) return;
    for (const callback of subs.values()) {
      try {
        callback(message);
      } catch {
        /* swallow subscriber errors */
      }
    }
  }

  /** Number of subscribers for a session (for testing/diagnostics). */
  subscriberCount(sessionId) {
    const subs = this._subscriptions.get(sessionId);
    return subs ? subs.size : 0;
  }
}

export { LocalTransport, LocalBus };
