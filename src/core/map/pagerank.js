// Repository map, phase 4: PageRank.
//
// Pure JS, no numeric libraries: the graph is an adjacency map, the maths is
// 30 lines, and the correctness argument lives in the tests. The iteration is
// the textbook one — weighted outflow, uniform teleport, dangling rank
// redistributed — with two additions the map layer needs:
//
//   · optional node biases (personalization), so a later caller can boost
//     files relevant to the current task without rebuilding the graph;
//   · a bounded iteration count with an epsilon stop, so a pathological
//     cycle in file imports can still never spin forever.
//
// Scores are normalised to sum to 1, which makes them comparable across map
// sizes and trivial to render as percentages.

const DEFAULTS = { damping: 0.85, epsilon: 1e-9, maxIterations: 100 };

/**
 * Run PageRank over a RefGraph-shaped input (anything with `nodes()` and
 * `neighbors(id)` returning weighted outbound entries).
 *
 * @template T
 * @param {{ nodes(): Array<{id: string} | string>, neighbors(id: string): Array<{id: string, weight?: number}> }} graph
 * @param {{
 *   damping?: number,
 *   epsilon?: number,
 *   maxIterations?: number,
 *   biases?: Map<string, number> | null,
 * }} [options]
 * @returns {Map<string, number>} node id -> score, all scores sum to 1
 */
export function pagerank(graph, options = {}) {
  const damping = clamp01(options.damping ?? DEFAULTS.damping, 0.85);
  const epsilon = Math.max(0, Number(options.epsilon) > 0 ? options.epsilon : DEFAULTS.epsilon);
  const maxIterations = Math.max(1, Math.floor(options.maxIterations ?? DEFAULTS.maxIterations));

  const nodeList = graph
    .nodes()
    .map((n) => (typeof n === "string" ? n : n.id));
  if (nodeList.length === 0) return new Map();

  // De-duplicate defensively: a repeated node id must not divide by N twice.
  const ids = [...new Set(nodeList)];
  const n = ids.length;
  const index = new Map(ids.map((id, i) => [id, i]));

  // Adjacency as weighted transition rows, normalised per source node.
  const outbound = [];
  const dangling = []; // ids with no real outbound targets
  for (const id of ids) {
    const adj = graph.neighbors(id) ?? [];
    const targets = [];
    let total = 0;
    const seen = new Set();
    for (const nb of adj) {
      if (!index.has(nb.id) || nb.id === id || seen.has(nb.id)) continue;
      seen.add(nb.id);
      const w = Number.isFinite(nb.weight) && nb.weight > 0 ? nb.weight : 1;
      targets.push([index.get(nb.id), w]);
      total += w;
    }
    if (total === 0) {
      outbound.push([]);
      dangling.push(index.get(id));
    } else {
      outbound.push(targets.map(([i2, w]) => [i2, w / total]));
      dangling.push(-1);
    }
  }

  // Biases: a personalised jump distribution. Absent or invalid entries fall
  // back to uniform so the teleport always sums to 1.
  let bias;
  if (options.biases && options.biases.size) {
    const b = new Float64Array(n);
    let sum = 0;
    for (const [id, value] of options.biases) {
      const i = index.get(id);
      if (i === undefined || !Number.isFinite(value) || value <= 0) continue;
      b[i] = value;
      sum += value;
    }
    if (sum > 0) bias = b.map((v) => v / sum);
  }
  if (!bias) {
    const uniform = 1 / n;
    bias = new Float64Array(n).fill(uniform);
  }

  // Standard iteration: follow links with probability `damping`, teleport
  // with 1-damping, and hand dangling rank to the teleport.
  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  for (let iter = 0; iter < maxIterations; iter += 1) {
    next.fill(0);
    let danglingSum = 0;
    for (let i = 0; i < n; i += 1) danglingSum += dangling[i] >= 0 ? rank[i] : 0;
    const dangleShare = (damping * danglingSum) / n;
    for (let i = 0; i < n; i += 1) {
      const share = rank[i];
      for (const [target, w] of outbound[i]) next[target] += damping * share * w;
    }
    let delta = 0;
    for (let i = 0; i < n; i += 1) {
      const r = (1 - damping) * bias[i] + dangleShare + next[i];
      delta += Math.abs(r - rank[i]);
      next[i] = r;
    }
    // Swap the buffers: only one of the two arrays is live per iteration, so
    // the freshly-written one becomes `rank` and the stale one becomes the
    // scratch space the next iteration refills.
    const tmp = rank;
    rank = next;
    next = tmp;
    if (delta < epsilon * n) break;
  }

  const out = new Map();
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += rank[i];
  const norm = sum > 0 ? 1 / sum : 1;
  for (let i = 0; i < n; i += 1) out.set(ids[i], rank[i] * norm);
  return out;
}

function clamp01(v, fallback) {
  const num = Number(v);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

export default pagerank;
