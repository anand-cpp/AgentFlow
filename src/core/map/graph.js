// Repository map, phase 3: import resolution and the reference graph.
//
// The extractor said "src/a.ts imports ./b". This module decides what that
// means structurally: every raw specifier becomes candidate paths (see
// extract.js) and the first candidate that is a real workspace file wins.
// Winners become directed edges A→B meaning "A references B"; losers become
// external stub nodes that exist so nothing hangs off an edge into the void,
// but, having no inbound edges, rank low in every pass.
//
// Nodes carry the file's path or a symbol qname; the whole thing is a plain
// adjacency map, which is all PageRank needs — nothing here is clever.

import { importCandidates } from "./extract.js";

export class RefGraph {
  constructor() {
    /** @type {Map<string, {id: string, kind: "file"|"symbol"|"external", external?: boolean}>} */
    this._nodes = new Map();
    /** @type {Map<string, Map<string, number>>} adjacency: id -> (target -> weight) */
    this._adj = new Map();
    /** @type {Array<{from: string, to: string, weight: number, kind: string}>} */
    this._edges = [];
  }

  /**
   * @param {string} id
   * @param {{kind: "file"|"symbol"|"external", external?: boolean, [k: string]: unknown}} [data]
   */
  addNode(id, data) {
    const nodes = this._nodes;
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind: "file", ...data });
      this._adj.set(id, new Map());
    }
    return nodes.get(id);
  }

  /**
   * @param {string} from
   * @param {string} to
   * @param {{weight?: number, kind?: string}} [data]
   */
  addEdge(from, to, { weight = 1, kind = "import" } = {}) {
    if (!from || !to || from === to) return;
    this.addNode(from, { kind: kind === "defines" ? "file" : this._nodes.get(from)?.kind ?? "file" });
    this.addNode(to, { kind: kind === "defines" ? "symbol" : this._nodes.get(to)?.kind ?? "external" });
    const adj = this._adj.get(from);
    if (!adj.has(to)) {
      adj.set(to, weight);
      this._edges.push({ from, to, weight, kind });
    }
  }

  node(id) {
    return this._nodes.get(id) ?? null;
  }

  hasNode(id) {
    return this._nodes.has(id);
  }

  hasEdge(from, to) {
    return this._adj.get(from)?.has(to) ?? false;
  }

  /** Outbound neighbours with weights. */
  neighbors(id) {
    const adj = this._adj.get(id);
    if (!adj) return [];
    return [...adj.entries()].map(([id2, weight]) => ({ id: id2, weight }));
  }

  outDegree(id) {
    return this._adj.get(id)?.size ?? 0;
  }

  inDegree(id) {
    let count = 0;
    for (const adj of this._adj.values()) {
      if (adj.has(id)) count += 1;
    }
    return count;
  }

  nodes() {
    return [...this._nodes.values()];
  }

  edges() {
    return [...this._edges];
  }

  /** Length of an edge in the pagerank transition matrix. */
  size() {
    return { nodes: this._nodes.size, edges: this._edges.length };
  }
}

/**
 * Resolve one raw specifier against the set of real workspace files.
 *
 * @param {string} raw specifier from the source
 * @param {string} fromFile importing file
 * @param {Set<string>} fileSet workspace-relative paths that exist
 * @returns {{ resolved: string|null, external: boolean }}
 */
export function resolveImport(raw, fromFile, fileSet) {
  for (const candidate of importCandidates(raw, fromFile)) {
    if (fileSet.has(candidate)) return { resolved: candidate, external: false };
  }
  return { resolved: null, external: true };
}

/**
 * Build the reference graph from extracted files.
 *
 * File nodes are workspace-relative paths. Each file also defines symbol
 * nodes along low-weight edges, so a PageRank pass propagates importance to
 * the symbols people import most indirectly. External targets (packages,
 * urls, unresolvable paths) get `external:true` stub nodes — they soak up
 * rank on the way out but have no inbound edges, so they stay negligible.
 *
 * @param {Array<{file: string, symbols: Array<{ name: string, [k: string]: unknown }>, imports: Array<{ raw: string, resolved?: string | null }>}>} units
 * @param {{ fileSet?: Set<string>, defineWeight?: number }} [options]
 * @returns {{ graph: RefGraph, unresolved: Array<{file: string, raw: string}> }}
 */
export function buildRefGraph(units, options = {}) {
  const fileSet = options.fileSet instanceof Set ? options.fileSet : new Set(units.map((u) => u.file));
  const defineWeight = options.defineWeight ?? 0.3;
  const graph = new RefGraph();
  const unresolved = [];

  for (const unit of units) {
    graph.addNode(unit.file, { kind: "file" });
    for (const symbol of unit.symbols ?? []) {
      graph.addEdge(unit.file, `${unit.file}#${symbol.name}`, { weight: defineWeight, kind: "defines" });
    }
    for (const entry of unit.imports ?? []) {
      const target = entry.resolved
        ? (fileSet.has(entry.resolved) ? entry.resolved : resolveImport(entry.raw, unit.file, fileSet).resolved)
        : resolveImport(entry.raw, unit.file, fileSet).resolved;
      if (target) {
        // Write the resolution back on the caller's unit, so snapshot
        // consumers (context packing, the CLI) see resolved targets
        // without rebuilding the graph.
        entry.resolved = target;
        graph.addEdge(unit.file, target, { weight: 1, kind: "import" });
      } else {
        unresolved.push({ file: unit.file, raw: entry.raw });
        // Declare the stub with its external flag before wiring the edge;
        // addNode never merges into an existing node.
        graph.addNode(`external:${entry.raw}`, { kind: "external", external: true });
        graph.addEdge(unit.file, `external:${entry.raw}`, { weight: 1, kind: "external" });
      }
    }
  }

  return { graph, unresolved };
}

export default { RefGraph, resolveImport, buildRefGraph };
