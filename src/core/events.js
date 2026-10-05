// Structured event log.
//
// Every interesting decision becomes a line of JSON in one append-only file.
// The point is that "why did it route there?" and "why did that tool run?" are
// answerable after the fact, from evidence, without re-running anything.
//
// Design constraints, in priority order:
//
//  1. Never leak a credential. Every payload passes through redactDeep before
//     it reaches disk, not on the way to the terminal. A log file outlives the
//     process and gets pasted into issues.
//  2. Never throw. Logging must not be able to break the operation it observes.
//  3. Be greppable. JSONL, one event per line, stable field names.
//
// Deliberately not implemented: log levels that filter writes. If you don't want
// events, don't create a logger. Sampling would hide exactly the rare failures
// you most need to see.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { redactDeep } from "./redact.js";

export const LEVELS = ["debug", "info", "warn", "error"];
const LEVEL_ORDER = new Map(LEVELS.map((l, i) => [l, i]));

// Stable event names. These are the API — rename one and you break anyone's
// log queries, so they are declared rather than sprinkled as string literals.
export const EVENTS = {
  GATEWAY_PROBE: "gateway.probe",
  GATEWAY_ERROR: "gateway.error",
  ROUTE_DECISION: "route.decision",
  ROUTE_ATTEMPT: "route.attempt",
  ROUTE_FALLBACK: "route.fallback",
  TOOL_PRECHECK: "tool.precheck",
  TOOL_APPROVAL: "tool.approval",
  TOOL_EXECUTE: "tool.execute",
  TOOL_POSTCHECK: "tool.postcheck",
  TOOL_DENIED: "tool.denied",
  TOOL_ERROR: "tool.error",
  AGENT_START: "agent.start",
  AGENT_STOP: "agent.stop",
  AGENT_ERROR: "agent.error",
  AGENT_STATE: "agent.state",
  // Agent runtime lifecycle. Added alongside the three above rather than
  // replacing them: those names are already in the wild and events.js treats a
  // rename as a breaking change to anyone's log queries. The runtime emits the
  // granular set below; the three legacy names stay declared for compatibility.
  AGENT_CONTEXT_LOADED: "agent.context_loaded",
  AGENT_MODEL_SELECTED: "agent.model_selected",
  // The candidate set, emitted before routing. Separate from `model_selected` on
  // purpose: nothing has been selected at this point, and an event named
  // "selected" that fires before the choice invites a reader to trust a selection
  // the router may never make.
  AGENT_ROUTE_PLANNED: "agent.route_planned",
  AGENT_TOOL_REQUESTED: "agent.tool_requested",
  AGENT_TOOL_APPROVED: "agent.tool_approved",
  // The three terminal tool states, separated rather than folded into
  // AGENT_TOOL_COMPLETED with a status field. AGENT_TOOL_COMPLETED fires for every
  // call that returned a result object, including refusals and failures -- it means
  // "the pipeline finished", not "it worked". A consumer that has to check a status
  // field to learn whether a tool failed is doing the same work the event type was
  // supposed to do for it, and a dashboard built on the lazy version reports a
  // refusal as a success.
  AGENT_TOOL_STARTED: "agent.tool_started",
  AGENT_TOOL_COMPLETED: "agent.tool_completed",
  AGENT_TOOL_FAILED: "agent.tool_failed",
  AGENT_TOOL_CANCELLED: "agent.tool_cancelled",
  AGENT_OUTPUT: "agent.output",
  AGENT_FAILED: "agent.failed",
  AGENT_RETRYING: "agent.retrying",
  AGENT_COMPLETED: "agent.completed",
  AGENT_CANCELLED: "agent.cancelled",
  AGENT_PERMISSION_DENIED: "agent.permission_denied",
  PLUGIN_LOAD: "plugin.load",
  PLUGIN_ERROR: "plugin.error",
  SESSION_START: "session.start",
  SESSION_END: "session.end",
};

/**
 * Default log location. Honours XDG_STATE_HOME like other Unix tools, falling
 * back to ~/.local/state on macOS/Linux and %LOCALAPPDATA% on Windows.
 */
export function defaultLogPath() {
  if (process.env.AGENTFLOW_LOG_PATH) return process.env.AGENTFLOW_LOG_PATH;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "agentflow", "agentflow.jsonl");
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agentflow", "agentflow.jsonl");
}

/** Monotonic-ish clock with enough resolution to order rapid events. */
function nowIso() {
  return new Date().toISOString();
}

let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}

/**
 * Validate and normalise an event. Returns null for anything unusable so a bad
 * call site degrades to a missing event rather than a crash.
 */
function normalise(type, level, data) {
  if (typeof type !== "string" || !type) return null;
  const lvl = LEVELS.includes(level) ? level : "info";
  const base = {
    ts: nowIso(),
    seq: nextSeq(),
    level: lvl,
    type,
  };
  if (data && typeof data === "object") {
    // redactDeep never throws (tested), so the try is belt-and-braces for
    // exotic inputs like getters that throw.
    let safe;
    try {
      safe = redactDeep(data);
    } catch {
      safe = { redacted: "payload could not be serialised" };
    }
    Object.assign(base, safe);
  }
  return base;
}

/**
 * An event sink. Kept dependency-free and synchronous-ish so ordering is
 * predictable: appendFileSync means a line is on disk before emit() returns,
 * so a crash cannot lose the event explaining the crash.
 */
export class EventLog {
  constructor({ file = defaultLogPath(), level = "info", enabled = true } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.minLevel = LEVEL_ORDER.has(level) ? level : "info";
    this.errorCount = 0;
  }

  shouldLog(level) {
    return this.enabled && LEVEL_ORDER.get(level) >= LEVEL_ORDER.get(this.minLevel);
  }

  /**
   * Append one event. Never throws — a logging failure is counted and dropped.
   * If the file cannot be created we disable logging rather than repeating the
   * failure on every subsequent event.
   */
  emit(type, data = {}, level = "info") {
    if (!this.shouldLog(level)) return null;
    const event = normalise(type, level, data);
    if (!event) return null;

    let line;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      this.errorCount += 1;
      return null;
    }

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      this.errorCount += 1;
      // One failure to create the directory is usually every failure. Stop
      // trying rather than paying a syscall error per event.
      this.enabled = false;
      return null;
    }

    return event;
  }

  debug(type, data) {
    return this.emit(type, data, "debug");
  }

  info(type, data) {
    return this.emit(type, data, "info");
  }

  warn(type, data) {
    return this.emit(type, data, "warn");
  }

  error(type, data) {
    return this.emit(type, data, "error");
  }
}

/** A log that discards everything. Default so a missed logger is silent. */
export function nullLog() {
  return new EventLog({ enabled: false });
}

/**
 * Read the tail of a JSONL file.
 *
 * Tolerant on purpose: a process killed mid-write leaves a truncated last line,
 * and a log you cannot read is useless exactly when you need it. Unparseable
 * lines are counted and skipped rather than thrown.
 */
export function readEvents({ file = defaultLogPath(), limit = 100, level = null, since = null, type = null } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { events: [], skipped: 0, file, missing: true };
  }

  const minLevel = LEVEL_ORDER.has(level) ? LEVEL_ORDER.get(level) : null;
  const sinceMs = since ? Date.parse(since) : null;
  const out = [];
  let skipped = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      skipped += 1; // truncated final line, or corruption
      continue;
    }
    if (minLevel !== null && LEVEL_ORDER.get(ev.level) < minLevel) continue;
    if (sinceMs !== null && Date.parse(ev.ts) < sinceMs) continue;
    if (type && ev.type !== type) continue;
    out.push(ev);
  }

  // `limit` is a tail, not a head: the newest events are the useful ones.
  const events = limit > 0 ? out.slice(-limit) : out;
  return { events, skipped, file, missing: false };
}

/** Count events grouped by type — the "what has been happening" summary. */
export function summarize(events) {
  const byType = new Map();
  const byLevel = new Map();
  let oldest = null;
  let newest = null;

  for (const ev of events) {
    byType.set(ev.type, (byType.get(ev.type) || 0) + 1);
    byLevel.set(ev.level, (byLevel.get(ev.level) || 0) + 1);
    if (!oldest || ev.ts < oldest) oldest = ev.ts;
    if (!newest || ev.ts > newest) newest = ev.ts;
  }

  return {
    total: events.length,
    byType: [...byType.entries()].sort((a, b) => b[1] - a[1]),
    byLevel: [...byLevel.entries()].sort((a, b) => b[1] - a[1]),
    oldest,
    newest,
  };
}

/** Human-readable one-liner for an event, used by `aflow logs`. */
export function formatEvent(ev) {
  const parts = [ev.ts, ev.level.toUpperCase().padEnd(5), ev.type];
  const rest = { ...ev };
  delete rest.ts;
  delete rest.seq;
  delete rest.level;
  delete rest.type;
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  return parts.join("  ");
}

export default { EventLog, EVENTS, LEVELS, defaultLogPath, readEvents, summarize, formatEvent, nullLog };
