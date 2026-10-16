// Session timeline renderer.
//
// A session is an append-only sequence of entries (note, conversation, tool_result,
// agent, tribunal_run, context, provider_transition, ...). The timeline turns that
// stream into a navigable list: each node is one entry, ordered by sequence, with
// a short human-readable label. It is intentionally pure -- takes a plain array of
// session entries and returns ANSI strings -- so tests can render it without a
// terminal and without touching disk.
//
// Entries are FLAT: SessionStore.append spreads the payload onto the entry, so a
// conversation entry is `{seq, ts, kind, role, content, at}`, not
// `{seq, ts, kind, payload:{...}}`. The label extractor reads those top-level
// fields; there is no `payload` wrapper to unwrap.
//
// Navigation is separate from rendering (navigateTimeline) to keep the view
// stateless. Colour comes from cli/ui.js, so NO_COLOR and non-TTY output
// degrade to plain text without this module making TTY decisions.

import { bold, dim, cyan, gray, green, red, yellow, paint, truncate, width as uiWidth, pad } from "../cli/ui.js";

export const TIMELINE_DIRECTIONS = Object.freeze({ UP: -1, DOWN: 1, TOP: -2, BOTTOM: 2 });

/**
 * @typedef {object} TimelineNode
 * @property {number} seq
 * @property {string|null} ts
 * @property {string} kind
 * @property {string|null} agent
 * @property {string} label
 * @property {object} entry
 */

/**
 * @typedef {object} Timeline
 * @property {TimelineNode[]} nodes
 * @property {number} active
 * @property {number} count
 */

/** Shorten a label without losing the tail when it is meaningful. */
function shortLabel(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "(empty)";
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function stamp(ts) {
  if (typeof ts !== "string" || ts.length < 16) return "-";
  return `${ts.slice(0, 10)} ${ts.slice(11, 16)}`;
}

function kindColor(kind) {
  switch (kind) {
    case "conversation":
      return cyan;
    case "tool_call":
    case "tool_result":
      return green;
    case "agent":
      return bold;
    case "error":
      return red;
    case "routing":
      return yellow;
    case "tribunal_run":
      return cyan;
    case "checkpoint":
      return gray;
    case "blackboard_ref":
      return dim;
    case "context":
    case "provider_transition":
      return dim;
    default:
      return (t) => t;
  }
}

/**
 * Derive a one-line label from a flat session entry. Fields are read from the
 * entry's top level because SessionStore spreads the payload onto the entry.
 */
function extractLabel(entry) {
  const kind = String(entry?.kind ?? "note");
  const text = (v) => (typeof v === "string" && v.trim() ? v : null);
  if (kind === "conversation") return shortLabel(text(entry.content) ?? `${entry.role ?? "message"}`);
  if (kind === "note") return shortLabel(text(entry.text) ?? "note");
  if (kind === "tool_call") return shortLabel(text(entry.tool) ?? "tool call");
  if (kind === "tool_result") {
    const tool = text(entry.tool) ?? "tool";
    const state = text(entry.outcome) ?? (entry.error ? "error" : "ok");
    return shortLabel(`${tool} → ${state}`);
  }
  if (kind === "agent") {
    const state = text(entry.state) ?? text(entry.status) ?? "run";
    if (Number.isFinite(entry.toolCalls)) {
      const n = entry.toolCalls;
      return shortLabel(`${state} · ${n} tool${n === 1 ? "" : "s"}`);
    }
    return shortLabel(state);
  }
  if (kind === "routing") return shortLabel(text(entry.decision) ?? text(entry.model) ?? "routing");
  if (kind === "tribunal_run") {
    const verdict = text(entry.verdict);
    return shortLabel(verdict ? `tribunal ${verdict}` : "tribunal run");
  }
  if (kind === "error") return shortLabel(text(entry.message) ?? "error");
  if (kind === "checkpoint") return shortLabel(text(entry.summary) ?? text(entry.message) ?? "checkpoint");
  if (kind === "blackboard_ref") return shortLabel(text(entry.ref) ?? text(entry.id) ?? "blackboard ref");
  if (kind === "context") return shortLabel(text(entry.packetRef) ?? "context packet");
  if (kind === "provider_transition") {
    const from = text(entry.from) ?? "-";
    const to = text(entry.to) ?? "-";
    return shortLabel(`${from} → ${to}`);
  }
  return shortLabel(kind.replace(/_/g, " "));
}

/**
 * Build a timeline from session entries (the `entries` array on a Session).
 * Entries are flat objects with at least {seq, ts, kind} and kind-specific
 * fields spread onto the entry itself.
 *
 * @param {Array<object>} sessionEntries
 * @returns {Timeline}
 */
export function buildTimeline(sessionEntries) {
  const list = Array.isArray(sessionEntries) ? sessionEntries.slice() : [];
  const nodes = list
    .filter((e) => e && typeof e === "object")
    .map((entry) => ({
      seq: Number.isFinite(entry.seq) ? entry.seq : 0,
      ts: typeof entry.ts === "string" ? entry.ts : null,
      kind: String(entry.kind ?? "note"),
      agent: entry.agent ? String(entry.agent) : null,
      label: extractLabel(entry),
      entry,
    }))
    .sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      if (a.ts && b.ts && a.ts !== b.ts) return a.ts.localeCompare(b.ts);
      return 0;
    });

  const count = nodes.length;
  const active = count === 0 ? -1 : count - 1; // last entry by default
  return { nodes, active, count };
}

/**
 * Render a single timeline node as a one-line string.
 *
 * @param {TimelineNode} node
 * @param {boolean} isActive
 * @returns {string}
 */
export function renderTimelineNode(node, isActive) {
  if (!node) return dim("(empty)");
  const marker = isActive ? paint("›", "bold") : " ";
  const seq = pad(String(node.seq ?? "?"), 3, "right");
  const time = pad(stamp(node.ts), 17);
  const kind = pad(truncate(node.kind.replace(/_/g, " "), 14), 14);
  const agent = node.agent ? truncate(node.agent, 10) : "-";
  const paintKind = kindColor(node.kind);
  const label = truncate(node.label, 48);
  const base = `${marker} ${dim(seq)} ${dim(time)} ${paintKind(kind)} ${dim(pad(agent, 10))} ${label}`;
  return isActive ? bold(base) : base;
}

/**
 * Render the whole timeline.
 *
 * @param {Timeline|object} timeline
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.offset]  index to start from (0-based)
 * @returns {string}
 */
export function renderTimeline(timeline, options = {}) {
  const t = timeline && typeof timeline === "object" ? timeline : { nodes: [], active: -1, count: 0 };
  const nodes = Array.isArray(t.nodes) ? t.nodes : [];
  const count = t.count ?? nodes.length;
  const active = Number.isFinite(t.active) ? t.active : count - 1;
  const width = Number.isInteger(options.width) && options.width > 20 ? options.width : 0;
  const height = Number.isInteger(options.height) && options.height > 4 ? options.height : 12;
  const offsetOpt = Number.isFinite(options.offset) ? options.offset : 0;

  if (count === 0) {
    const title = bold("TIMELINE");
    return `${title}\n${dim("  no entries")}`;
  }

  const header = `${bold("TIMELINE")} ${dim(`(${count} entries)`)}`;
  const start = Math.max(0, Math.min(nodes.length - 1, offsetOpt));
  const end = Math.min(nodes.length, start + height);
  const visible = nodes.slice(start, end);

  const lines = [header];
  for (let i = 0; i < visible.length; i += 1) {
    const idx = start + i;
    const node = visible[idx];
    const line = renderTimelineNode(node, idx === active);
    if (width > 0 && uiWidth(line) > width) {
      lines.push(truncate(line, width));
    } else {
      lines.push(line);
    }
  }

  if (end < nodes.length) lines.push(dim(`  … ${nodes.length - end} more`));
  return lines.join("\n");
}

/**
 * Navigate the timeline by direction.
 * Directions: -1 (up), +1 (down), -2 (top), +2 (bottom).
 *
 * @param {Timeline|object} timeline
 * @param {number} direction
 * @returns {Timeline}
 */
export function navigateTimeline(timeline, direction) {
  const t = timeline && typeof timeline === "object" ? timeline : { nodes: [], active: -1, count: 0 };
  const nodes = Array.isArray(t.nodes) ? t.nodes : [];
  const count = nodes.length;
  let active = Number.isFinite(t.active) ? t.active : count - 1;
  if (count === 0) {
    return { nodes, active: -1, count: 0 };
  }
  if (direction === TIMELINE_DIRECTIONS.TOP) {
    active = 0;
  } else if (direction === TIMELINE_DIRECTIONS.BOTTOM) {
    active = count - 1;
  } else if (direction === TIMELINE_DIRECTIONS.UP) {
    active = Math.max(0, active - 1);
  } else if (direction === TIMELINE_DIRECTIONS.DOWN) {
    active = Math.min(count - 1, active + 1);
  }
  return { nodes, active, count };
}

export default {
  TIMELINE_DIRECTIONS,
  buildTimeline,
  renderTimeline,
  renderTimelineNode,
  navigateTimeline,
};
