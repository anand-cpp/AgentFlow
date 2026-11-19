// WebSocket transport for Hackathon Mode LAN/non-LAN communication.
//
// Provides secure, authenticated WebSocket connectivity between coordinator
// and workers. Works over LAN (local WebSocket server) or over the internet
// (via relay). Device identity and session credentials are bound to the
// WebSocket connection; messages are end-to-end encrypted at the session
// layer (invitation tokens + nonce-based replay protection).
//
// Server side: the coordinator hosts a WebSocket server (or uses an overlay
// network like Tailscale/Headscale for non-LAN). This module implements the
// client-side transport; the server accepts connections and validates
// invitation tokens before admitting workers.
//
// No unauthenticated public ports are exposed. Connections require a valid
// invitation token and are bound to a specific session+worker.

import {
  TRANSPORT_STATE,
  HackathonTransport,
} from "./transport.js";
import { validateEvent } from "./events.js";

const DEFAULT_RECONNECT_INTERVAL_MS = 3000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_PING_INTERVAL_MS = 30000;
const DEFAULT_PONG_TIMEOUT_MS = 10000;

/**
 * WebSocketTransport — client-side WebSocket transport for Hackathon Mode.
 *
 * Connects to a coordinator WebSocket server, authenticates with an
 * invitation token, and exchanges validated HackathonEvents.
 *
 * Supports automatic reconnection with exponential backoff, ping/pong
 * liveness, and message-size limits matching the event protocol.
 */
class WebSocketTransport extends HackathonTransport {
  constructor({
    sessionId,
    workerId,
    url = null,
    invitationToken = null,
    reconnectIntervalMs = DEFAULT_RECONNECT_INTERVAL_MS,
    maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS,
    pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
    pongTimeoutMs = DEFAULT_PONG_TIMEOUT_MS,
  } = {}) {
    super({ sessionId, workerId });
    this._url = url;
    this._invitationToken = invitationToken;
    this._reconnectIntervalMs = reconnectIntervalMs;
    this._maxReconnectAttempts = maxReconnectAttempts;
    this._pingIntervalMs = pingIntervalMs;
    this._pongTimeoutMs = pongTimeoutMs;

    this._ws = null;
    this._reconnectAttempts = 0;
    this._pingTimer = null;
    this._pongTimer = null;
    this._shouldReconnect = true;
    this._sendQueue = [];
  }

  /** Get the WebSocket URL. */
  get url() {
    return this._url;
  }

  /** Connect to the WebSocket server and authenticate. */
  async connect() {
    if (this.state !== TRANSPORT_STATE.DISCONNECTED) return;
    if (!this._url) {
      throw new Error("WebSocketTransport requires a URL");
    }

    this.state = TRANSPORT_STATE.CONNECTING;

    try {
      const ws = await this._openWebSocket();
      this._ws = ws;
      this._setupWebSocketHandlers(ws);

      // Wait for the open event.
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 10000);
        ws.addEventListener("open", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
        ws.addEventListener("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        }, { once: true });
      });

      // Authenticate: send the invitation token as the first message.
      await this._sendRaw({
        type: "hackathon.auth",
        sessionId: this.sessionId,
        workerId: this.workerId,
        invitationToken: this._invitationToken,
      });

      this.state = TRANSPORT_STATE.CONNECTED;
      this._reconnectAttempts = 0;
      this._startPing();
      this._flushSendQueue();

      this.emit("connect", {
        workerId: this.workerId,
        sessionId: this.sessionId,
      });
    } catch (err) {
      this.state = TRANSPORT_STATE.DISCONNECTED;
      this._ws = null;
      this._scheduleReconnect();
      throw err;
    }
  }

  /** Open the raw WebSocket connection. */
  _openWebSocket() {
    return new Promise((resolve, reject) => {
      // Node 21+ provides a global WebSocket. Fall back to 'ws' package if
      // available for older environments.
      const WebSocket = typeof globalThis.WebSocket !== "undefined"
        ? globalThis.WebSocket
        : null;
      if (!WebSocket) {
        reject(new Error("WebSocket is not available in this environment"));
        return;
      }

      const ws = new WebSocket(this._url);
      ws.binaryType = "arraybuffer";
      resolve(ws);
    });
  }

  /** Set up WebSocket event handlers. */
  _setupWebSocketHandlers(ws) {
    ws.addEventListener("message", (event) => {
      try {
        let data;
        if (event.data instanceof ArrayBuffer) {
          data = JSON.parse(Buffer.from(event.data).toString("utf8"));
        } else {
          data = JSON.parse(event.data);
        }

        // Handle server protocol messages.
        if (data.type === "hackathon.auth_result") {
          if (data.ok) {
            // Authentication succeeded.
          } else {
            this._close(TRANSPORT_STATE.CLOSED);
            this.emit("error", new Error(data.error || "authentication failed"));
          }
          return;
        }
        if (data.type === "hackathon.ping") {
          this._sendRaw({ type: "hackathon.pong" });
          return;
        }
        if (data.type === "hackathon.pong") {
          this._resetPongTimer();
          return;
        }
        if (data.type === "hackathon.close") {
          this._close(TRANSPORT_STATE.CLOSED, data.reason);
          return;
        }

        // Otherwise treat as a HackathonEvent.
        const ev = validateEvent(data) && data;
        this.emit("message", ev);
      } catch {
        /* ignore malformed inbound messages */
      }
    });

    ws.addEventListener("close", () => {
      this._stopPing();
      if (this.state === TRANSPORT_STATE.CONNECTED ||
          this.state === TRANSPORT_STATE.CONNECTING) {
        this.state = TRANSPORT_STATE.DISCONNECTED;
        this._ws = null;
        if (this._shouldReconnect) {
          this._scheduleReconnect();
        }
        this.emit("disconnect", {
          workerId: this.workerId,
          sessionId: this.sessionId,
        });
      }
    });

    ws.addEventListener("error", (err) => {
      this.emit("error", err);
    });
  }

  /** Send a validated event over the WebSocket. */
  async send(event) {
    const envelope = this._envelope(event);
    const serialized = JSON.stringify(envelope.toJSON());
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > this._maxMessageBytes) {
      throw new Error(`message exceeds ${this._maxMessageBytes} byte limit`);
    }

    if (this.state === TRANSPORT_STATE.CONNECTED && this._ws) {
      this._ws.send(serialized);
      this.emit("sent", { eventId: envelope.eventId, type: envelope.type });
    } else {
      // Queue for delivery after reconnect.
      this._sendQueue.push(serialized);
      throw new Error("transport not connected — message queued for retry");
    }
  }

  /** Send a raw (unenveloped) message. */
  async _sendRaw(data) {
    const serialized = JSON.stringify(data);
    if (this.state === TRANSPORT_STATE.CONNECTED && this._ws) {
      this._ws.send(serialized);
    } else {
      this._sendQueue.push(serialized);
    }
  }

  /** Flush queued messages after reconnection. */
  _flushSendQueue() {
    const queued = this._sendQueue;
    this._sendQueue = [];
    for (const message of queued) {
      if (this._ws && this.state === TRANSPORT_STATE.CONNECTED) {
        this._ws.send(message);
      }
    }
  }

  /** Start ping/pong liveness. */
  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this.state === TRANSPORT_STATE.CONNECTED) {
        this._sendRaw({ type: "hackathon.ping" });
        this._pongTimer = setTimeout(() => {
          // No pong received — assume connection is dead.
          this._ws.close();
        }, this._pongTimeoutMs);
      }
    }, this._pingIntervalMs);
    this._pingTimer.unref?.();
  }

  /** Reset the pong timeout timer. */
  _resetPongTimer() {
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  /** Stop ping/pong timers. */
  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  /** Schedule reconnection with exponential backoff. */
  _scheduleReconnect() {
    if (!this._shouldReconnect || this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.state = TRANSPORT_STATE.CLOSED;
      this.emit("error", new Error("max reconnect attempts reached"));
      return;
    }

    this._reconnectAttempts += 1;
    const backoff = Math.min(
      this._reconnectIntervalMs * Math.pow(2, this._reconnectAttempts - 1),
      30000,
    );

    setTimeout(() => {
      if (!this._shouldReconnect) return;
      this.state = TRANSPORT_STATE.DISCONNECTED;
      this.emit("reconnecting", {
        attempt: this._reconnectAttempts,
        maxAttempts: this._maxReconnectAttempts,
        workerId: this.workerId,
      });
      this.connect().catch(() => {
        /* reconnect failed — will retry on next backoff */
      });
    }, backoff).unref?.();
  }

  /** Close the WebSocket connection. */
  async close() {
    this._shouldReconnect = false;
    this._stopPing();
    this._scheduleReconnect = () => {};
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        /* ignore close errors */
      }
      this._ws = null;
    }
    this.state = TRANSPORT_STATE.CLOSED;
    this.emit("close", { workerId: this.workerId });
  }

  /** Close with a specific state. */
  _close(state, reason) {
    this._stopPing();
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
      this._ws = null;
    }
    this.state = state;
    this.emit("close", { workerId: this.workerId, reason });
  }
}

export { TRANSPORT_STATE } from "./transport.js";
export { WebSocketTransport };
