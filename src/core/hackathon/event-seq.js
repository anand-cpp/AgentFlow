// Event sequencing and deduplication for Hackathon Mode.
//
// Tracks event sequence numbers per session, detects duplicate events, and
// handles out-of-order delivery. Every event carries a monotonically increasing
// sequence number; the coordinator uses this to detect replays and gaps.
//
// This is the worker↔coordinator event sequencing layer, separate from the
// existing EventLog (which is append-only file storage). The two complement
// each other: EventLog persists events to disk; event-seq ensures in-order,
// deduplicated delivery between coordinator and workers.

export const EVENT_SEQ_VERSION = 1;

/** Per-session sequence tracker. */
export class EventSequence {
  constructor({ sessionId } = {}) {
    if (!sessionId) throw new Error("sessionId required");
    this.sessionId = sessionId;
    this.lastSequence = 0; // highest sequence seen
    this.seen = new Set(); // sequence numbers already processed (for dedup)
    this.pending = new Map(); // sequence -> event (out-of-order buffer)
    this.version = EVENT_SEQ_VERSION;
  }

  /** Process an incoming event. Returns { ok, duplicate, sequence, gap, delivered }. */
  accept(event) {
    const seq = event.sequence || 0;

    // Duplicate detection.
    if (this.seen.has(seq)) {
      return { ok: true, duplicate: true, sequence: seq, gap: false };
    }

    // Gap detection: if this sequence is more than 1 ahead of the next
    // expected sequence, we missed events.
    const gap = seq > this.lastSequence + 1;

    // Record the event as seen and buffer it.
    this.seen.add(seq);
    this.pending.set(seq, event);

    // Deliver any pending events that are now contiguous from lastSequence.
    const delivered = [];
    let next = this.lastSequence + 1;
    while (this.pending.has(next)) {
      delivered.push(this.pending.get(next));
      this.pending.delete(next);
      this.lastSequence = next;
      next += 1;
    }

    return { ok: true, duplicate: false, sequence: seq, gap, delivered };
  }

  /** Check whether a sequence number has already been processed. */
  isDuplicate(sequence) {
    return this.seen.has(sequence);
  }

  /** Get the next expected sequence number. */
  nextExpected() {
    return this.lastSequence + 1;
  }

  /** Get count of buffered out-of-order events. */
  pendingCount() {
    return this.pending.size;
  }

  /** Get state for persistence. */
  toJSON() {
    return {
      version: this.version,
      sessionId: this.sessionId,
      lastSequence: this.lastSequence,
      seen: [...this.seen],
    };
  }

  /** Restore from persisted state. */
  static fromJSON(json) {
    const tracker = new EventSequence({ sessionId: json.sessionId });
    tracker.lastSequence = json.lastSequence || 0;
    tracker.seen = new Set(json.seen || []);
    tracker.version = json.version || EVENT_SEQ_VERSION;
    return tracker;
  }
}

/** Global registry of sequence trackers, one per session. */
export class EventSequenceRegistry {
  constructor() {
    this.trackers = new Map(); // sessionId -> EventSequence
  }

  /** Get or create a tracker for a session. */
  getOrCreate(sessionId) {
    if (!sessionId) throw new Error("sessionId required");
    let tracker = this.trackers.get(sessionId);
    if (!tracker) {
      tracker = new EventSequence({ sessionId });
      this.trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  /** Get a tracker without creating. */
  get(sessionId) {
    return this.trackers.get(sessionId) || null;
  }

  /** Remove a tracker (session ended). */
  remove(sessionId) {
    this.trackers.delete(sessionId);
  }
}

export default { EventSequence, EventSequenceRegistry, EVENT_SEQ_VERSION };
