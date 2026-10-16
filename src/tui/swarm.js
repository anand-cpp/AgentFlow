// Swarm graph: the agent handoff DAG.
//
// A swarm is a set of agent runs, each possibly delegating to another. The
// records come from the session's AGENT entries -- the outcome objects the
// runtime persists (agentId, model, state, completed, iterations, toolCalls,
// durationMs, and optional parent/from). This module turns that flat list into a
// top-down graph and renders it as an indented tree, which is the honest shape
// for a terminal: no cursor positioning, no dependency, and the parent/child
// relation is legible from the connectors.
//
// One decision is deliberate here: edges prefer an explicit `parent` or `from`
// on a record. Only when a record names neither is a sequential chain assumed
// (each run is the child of the one before it). A record that carries the field
// as null starts a new tree rather than dangling.
//
// Layout is longest-path layering: a node sits one level below its deepest
// parent, so a diamond (A -> B, A -> C, B -> D, C -> D) puts D below both --
// the only layering that reads correctly top-down.
//
// Every renderer is a pure function of the graph. Colour comes from cli/ui.js,
// so NO_COLOR and non-TTY output degrade to plain text.

import { bold, dim, cyan, green, red, yellow, truncate, width as uiWidth } from "../cli/ui.js";

/** The states a run can end (or sit) in, mapped onto the glyphs we draw. */
const RUN_MARK = {
  completed: { glyph: "\u2713", paint: green }, // ✓
  failed: { glyph: "\u2717", paint: red }, // ✗
  timed_out: { glyph: "\u2717", paint: red },
  cancelled: { glyph: "\u2717", paint: yellow },
  running: { glyph: "\u25cf", paint: cyan }, // ●
  waiting_approval: { glyph: "\u25cf", paint: yellow },
  ready: { glyph: "\u00b7", paint: dim }, // ·
  context_loading: { glyph: "\u00b7", paint: dim },
  created: { glyph: "\u00b7", paint: dim },
};

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where a run's duration comes from: an explicit field, else its wall clock. */
function durationOf(record) {
  if (typeof record?.durationMs === "number" && Number.isFinite(record.durationMs)) return record.durationMs;
  const start = Number(record?.startedAt);
  const end = Number(record?.finishedAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  return null;
}

function statusOf(record) {
  const raw = String(record?.state ?? "").toLowerCase();
  if (raw) return raw;
  if (record?.completed === true) return "completed";
  return "created";
}

/**
 * @typedef {object} SwarmNode
 * @property {number} index
 * @property {string} id
 * @property {number|null} parent
 * @property {string} agentId
 * @property {string|null} model
 * @property {string} state
 * @property {boolean} completed
 * @property {number} iterations
 * @property {number} toolCalls
 * @property {number|null} durationMs
 * @property {number} layer
 * @property {boolean} explicitParent
 * @property {object} record
 *
 * @typedef {object} SwarmEdge
 * @property {number} from
 * @property {number} to
 *
 * @typedef {object} SwarmGraph
 * @property {SwarmNode[]} nodes
 * @property {SwarmEdge[]} edges
 * @property {number[]} roots
 * @property {Array<number[]>} layers  node indices, grouped by layer
 */

/**
 * Build the swarm graph from agent-run records.
 *
 * @param {Array<object>} agentEvents
 * @returns {SwarmGraph}
 */
export function buildSwarmGraph(agentEvents) {
  const list = Array.isArray(agentEvents) ? agentEvents.filter(isObject) : [];
  const nodes = list.map((record, index) => ({
    index,
    id: typeof record.id === "string" && record.id ? record.id : `${record.agentId ?? "agent"}#${index}`,
    parent: null,
    agentId: String(record.agentId ?? record.agent ?? "agent"),
    model: record.model ? String(record.model) : null,
    state: statusOf(record),
    completed: record.completed === true,
    iterations: Number.isFinite(record.iterations) ? record.iterations : 0,
    toolCalls: Number.isFinite(record.toolCalls) ? record.toolCalls : 0,
    durationMs: durationOf(record),
    layer: 0,
    explicitParent: false,
    record,
  }));

  // Resolve parents. An explicit `parent` (index) or `from` (index) wins.
  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node.index);

  const resolveRef = (ref) => {
    if (Number.isInteger(ref) && ref >= 0 && ref < nodes.length) return ref;
    if (typeof ref === "string" && byId.has(ref)) return byId.get(ref);
    return null;
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const record = list[i];
    const hasExplicit = Object.prototype.hasOwnProperty.call(record, "parent") || Object.prototype.hasOwnProperty.call(record, "from");
    if (hasExplicit) {
      const ref = record.parent ?? record.from ?? null;
      const resolved = resolveRef(ref);
      nodes[i].parent = resolved;
      nodes[i].explicitParent = resolved !== null;
    } else {
      // Sequential chain: each run is the child of the one before it.
      nodes[i].parent = i === 0 ? null : i - 1;
    }
  }

  const edges = [];
  for (const node of nodes) {
    if (node.parent === node.index) node.parent = null; // a self-parent is a root
    if (node.parent !== null) edges.push({ from: node.parent, to: node.index });
  }

  const roots = nodes.filter((n) => n.parent === null).map((n) => n.index);
  const graph = { nodes, edges, roots, layers: [] };
  layoutDAG(graph);
  return graph;
}

/**
 * Assign each node a layer one below its deepest parent (longest-path layering),
 * then group nodes by layer. Cycles are tolerated: a node reached only through a
 * cycle is treated as a root so the graph always renders.
 *
 * @param {SwarmGraph} graph
 * @returns {SwarmGraph} the same graph, mutated
 */
export function layoutDAG(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const layer = new Array(nodes.length).fill(0);
  const visiting = new Array(nodes.length).fill(false);
  const done = new Array(nodes.length).fill(false);

  const assign = (index) => {
    if (done[index]) return layer[index];
    if (visiting[index]) return layer[index]; // cycle guard
    visiting[index] = true;
    const node = nodes[index];
    layer[index] = node.parent !== null && node.parent !== index ? assign(node.parent) + 1 : 0;
    visiting[index] = false;
    done[index] = true;
    return layer[index];
  };

  for (const node of nodes) assign(node.index);
  for (const node of nodes) node.layer = layer[node.index];

  const maxLayer = nodes.length ? Math.max(...nodes.map((n) => n.layer)) : -1;
  const layers = [];
  for (let i = 0; i <= maxLayer; i += 1) layers.push(nodes.filter((n) => n.layer === i).map((n) => n.index));
  graph.layers = layers;
  return graph;
}

function durationText(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, "0")}s`;
}

function markFor(status, completed) {
  const entry = RUN_MARK[status] ?? (completed ? RUN_MARK.completed : RUN_MARK.created);
  return entry.paint(entry.glyph);
}

function pad(text, width) {
  const s = String(text ?? "");
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Render one agent as a single line: state glyph, who, which model, the cost.
 *
 * @param {object|string} agent   a SwarmNode or an agentId
 * @param {string} [status]
 * @param {number|null} [duration]  milliseconds
 * @returns {string}
 */
export function renderSwarmNode(agent, status, duration) {
  const isNode = isObject(agent);
  const agentId = String((isNode ? agent.agentId : agent) ?? "agent");
  const state = String(status ?? (isNode ? agent.state : "") ?? "").toLowerCase();
  const completed = isNode ? agent.completed === true : false;
  const model = isNode && agent.model ? String(agent.model) : "-";
  const iterations = isNode && Number.isFinite(agent.iterations) ? agent.iterations : 0;
  const toolCalls = isNode && Number.isFinite(agent.toolCalls) ? agent.toolCalls : 0;
  const ms = duration ?? (isNode ? agent.durationMs : null);
  const stateText = state ? state.replace(/_/g, " ") : "unknown";
  const mark = markFor(state, completed);
  const who = truncate(agentId, 16);
  const which = truncate(model, 18);
  return `${mark} ${bold(who)} ${dim(which)} ${pad(stateText, 14)} ${dim(`${iterations} iter`)} ${dim(`${toolCalls} tool${toolCalls === 1 ? "" : "s"}`)} ${dim(durationText(ms))}`;
}

function indentFor(depth, isLastStack) {
  let out = "";
  for (let i = 0; i < depth - 1; i += 1) out += isLastStack[i] ? "   " : "\u2502  "; // │
  return out;
}

/**
 * The connector glyph for one edge. `last` picks the elbow so the final child of
 * a parent is drawn with a corner rather than a tee. Shared by the tree renderer
 * and the standalone edge hint so the two can never drift apart.
 *
 * @param {boolean} last
 * @returns {string}
 */
function edgeGlyph(last) {
  return last ? "\u2514\u2500\u25b6" : "\u251c\u2500\u25b6"; // └─▶ / ├─▶
}

/**
 * The connector for one edge, labelled with the direction it flows.
 *
 * @param {number|string} from
 * @param {number|string} to
 * @param {object} [options]
 * @param {boolean} [options.last]
 * @param {string} [options.indent]
 * @returns {string}
 */
export function renderSwarmEdge(from, to, options = {}) {
  const indent = typeof options.indent === "string" ? options.indent : "";
  return `${indent}${edgeGlyph(Boolean(options.last))} ${dim(`${from} \u2192 ${to}`)}`;
}

/**
 * Render the graph as a top-down tree. Roots sit at the top; each child is drawn
 * beneath its parent with a connector. A node with several parents is drawn once,
 * under its first parent, with the extra parents noted.
 *
 * @param {SwarmGraph|object} graph
 * @param {object} [options]
 * @param {number} [options.width]
 * @returns {string}
 */
export function renderSwarmGraph(graph, options = {}) {
  const g = isObject(graph) ? graph : { nodes: [], edges: [], roots: [], layers: [] };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const width = Number.isInteger(options.width) && options.width > 20 ? options.width : 0;
  const title = `${bold("SWARM")}  ${dim(`\u00b7 ${nodes.length} agent${nodes.length === 1 ? "" : "s"}`)} ${dim(`\u00b7 ${Array.isArray(g.edges) ? g.edges.length : 0} edge(s)`)}`;
  if (nodes.length === 0) return `${title}\n${dim("  no agent runs")}`;

  const children = new Map();
  for (const node of nodes) {
    if (node.parent === null) continue;
    if (!children.has(node.parent)) children.set(node.parent, []);
    children.get(node.parent).push(node.index);
  }

  const roots = Array.isArray(g.roots) && g.roots.length ? g.roots : nodes.filter((n) => n.parent === null).map((n) => n.index);

  const lines = [title, ""];
  const drawn = new Set();

  const walk = (index, depth, isLastStack, isLast) => {
    const node = nodes[index];
    if (!node) return;
    const indent = indentFor(depth, isLastStack);
    const prefix = depth === 0 ? "  " : `${indent}${edgeGlyph(isLast)} `;
    const extra = drawn.has(index) ? dim(" (also reached from another parent)") : "";
    lines.push(`${prefix}${renderSwarmNode(node)}${extra}`);
    if (drawn.has(index)) return;
    drawn.add(index);

    const kids = children.get(index) ?? [];
    kids.forEach((child, i) => walk(child, depth + 1, [...isLastStack, isLast], i === kids.length - 1));
  };

  roots.forEach((root, i) => {
    walk(root, 0, [], i === roots.length - 1);
    if (i < roots.length - 1) lines.push("");
  });

  // Any node never reached (a cycle with no root) gets drawn flat at the end so
  // nothing is silently dropped.
  const orphans = nodes.filter((n) => !drawn.has(n.index));
  if (orphans.length) {
    lines.push("", dim("  unreachable (cyclic):"));
    for (const node of orphans) lines.push(`    ${renderSwarmNode(node)}`);
  }

  const rendered = lines.join("\n");
  if (width > 0) {
    return rendered
      .split("\n")
      .map((line) => (uiWidth(line) > width ? truncate(line, width) : line))
      .join("\n");
  }
  return rendered;
}

export default {
  buildSwarmGraph,
  layoutDAG,
  renderSwarmNode,
  renderSwarmEdge,
  renderSwarmGraph,
};
