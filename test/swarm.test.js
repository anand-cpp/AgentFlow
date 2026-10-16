// Swarm graph (src/tui/swarm.js): building the agent-handoff DAG from flat
// agent-run records and rendering it as a top-down tree. Pure functions; colour
// disabled via the shared ui module.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const s = await import("../src/tui/swarm.js");
const ui = await import("../src/cli/ui.js");
ui.setColor(false);

const run = (agentId, extra = {}) => ({ agentId, state: "completed", completed: true, iterations: 1, toolCalls: 0, durationMs: 100, ...extra });

test("buildSwarmGraph chains records sequentially when no parent is given", () => {
  const g = s.buildSwarmGraph([run("a"), run("b"), run("c")]);
  assert.equal(g.nodes.length, 3);
  assert.equal(g.nodes[0].parent, null);
  assert.equal(g.nodes[1].parent, 0);
  assert.equal(g.nodes[2].parent, 1);
  assert.deepEqual(g.roots, [0]);
  assert.deepEqual(g.layers, [[0], [1], [2]]);
  assert.deepEqual(g.edges, [
    { from: 0, to: 1 },
    { from: 1, to: 2 },
  ]);
});

test("buildSwarmGraph honours an explicit numeric parent", () => {
  const g = s.buildSwarmGraph([run("root"), run("a", { parent: 0 }), run("b", { parent: 0 })]);
  assert.equal(g.nodes[1].parent, 0);
  assert.equal(g.nodes[2].parent, 0);
  assert.deepEqual(g.roots, [0]);
  assert.deepEqual(g.layers, [[0], [1, 2]]);
  assert.equal(g.nodes[1].explicitParent, true);
});

test("buildSwarmGraph resolves a parent given as a node id string", () => {
  const g = s.buildSwarmGraph([{ id: "root", agentId: "root" }, { agentId: "kid", parent: "root" }]);
  assert.equal(g.nodes[1].parent, 0);
});

test("buildSwarmGraph treats an explicit null parent as a new root", () => {
  const g = s.buildSwarmGraph([run("a", { parent: null }), run("b", { parent: null })]);
  assert.equal(g.nodes[0].parent, null);
  assert.equal(g.nodes[1].parent, null, "an explicit null does not chain");
  assert.deepEqual(g.roots, [0, 1]);
  assert.equal(g.edges.length, 0);
});

test("buildSwarmGraph tolerates empty, null and malformed input", () => {
  assert.deepEqual(s.buildSwarmGraph([]).nodes, []);
  assert.deepEqual(s.buildSwarmGraph(null).nodes, []);
  const g = s.buildSwarmGraph([null, "x", run("ok")]);
  assert.equal(g.nodes.length, 1, "non-objects are dropped");
  assert.equal(g.nodes[0].agentId, "ok");
});

test("buildSwarmGraph gives distinct ids when ids are absent", () => {
  const g = s.buildSwarmGraph([{ agentId: "a" }, { agentId: "a" }]);
  assert.notEqual(g.nodes[0].id, g.nodes[1].id);
});

test("buildSwarmGraph derives durationMs from the wall clock when absent", () => {
  const g = s.buildSwarmGraph([{ agentId: "a", startedAt: 1000, finishedAt: 1500 }]);
  assert.equal(g.nodes[0].durationMs, 500);
  const noClock = s.buildSwarmGraph([{ agentId: "a", durationMs: 42 }]);
  assert.equal(noClock.nodes[0].durationMs, 42);
  assert.equal(s.buildSwarmGraph([{ agentId: "a" }]).nodes[0].durationMs, null);
});

test("buildSwarmGraph reads state and falls back to completed", () => {
  assert.equal(s.buildSwarmGraph([{ agentId: "a", state: "FAILED" }]).nodes[0].state, "failed");
  assert.equal(s.buildSwarmGraph([{ agentId: "a", completed: true }]).nodes[0].state, "completed");
  assert.equal(s.buildSwarmGraph([{ agentId: "a" }]).nodes[0].state, "created");
});

test("layoutDAG puts a node one below its deepest parent", () => {
  const g = s.buildSwarmGraph([
    run("root", { parent: null }),
    run("left", { parent: 0 }),
    run("right", { parent: 0 }),
    run("deep", { parent: 1 }),
  ]);
  const byId = (id) => g.nodes.find((n) => n.agentId === id);
  assert.equal(byId("left").layer, 1);
  assert.equal(byId("right").layer, 1);
  assert.equal(byId("deep").layer, 2, "deepest parent decides the layer");
  assert.deepEqual(g.layers, [[0], [1, 2], [3]]);
});

test("layoutDAG tolerates a cycle without hanging", () => {
  const g = /** @type {any} */ ({ nodes: [{ index: 0, parent: 1, layer: 0 }, { index: 1, parent: 0, layer: 0 }], edges: [], roots: [], layers: [] });
  assert.doesNotThrow(() => s.layoutDAG(g));
  assert.ok(Number.isInteger(g.nodes[0].layer));
  assert.ok(Array.isArray(g.layers));
});

test("renderSwarmNode renders the glyph, agent, model and cost", () => {
  const node = s.buildSwarmGraph([run("planner", { model: "a/big", iterations: 2, toolCalls: 3, durationMs: 1200 })]).nodes[0];
  const out = s.renderSwarmNode(node);
  assert.match(out, /planner/);
  assert.match(out, /a\/big/);
  assert.match(out, /completed/);
  assert.match(out, /2 iter/);
  assert.match(out, /3 tools/);
  assert.match(out, /1\.2s/);
  assert.ok(!out.includes("\u001b"));
});

test("renderSwarmNode accepts a bare agent id and a duration override", () => {
  const out = s.renderSwarmNode("solo", "running", 500);
  assert.match(out, /solo/);
  assert.match(out, /running/);
  assert.match(out, /500ms/);
});

test("renderSwarmNode singularises one tool and shows '-' for no duration", () => {
  const out = s.renderSwarmNode({ agentId: "a", state: "completed", toolCalls: 1, durationMs: null }, "completed", null);
  assert.match(out, /1 tool\b/);
  assert.doesNotMatch(out, /1 tools/);
});

test("renderSwarmEdge shows a labelled connector and an elbow for the last child", () => {
  const mid = s.renderSwarmEdge(0, 1);
  const last = s.renderSwarmEdge(0, 2, { last: true });
  assert.match(mid, /├─▶/);
  assert.match(mid, /0 → 1/);
  assert.match(last, /└─▶/);
  assert.match(last, /0 → 2/);
});

test("renderSwarmGraph draws a header and an indented tree", () => {
  const g = s.buildSwarmGraph([run("root", { parent: null }), run("kid", { parent: 0 })]);
  const out = s.renderSwarmGraph(g, { width: 100 });
  const lines = out.split("\n");
  assert.match(lines[0], /SWARM/);
  assert.match(lines[0], /2 agents/);
  assert.match(lines[0], /1 edge/);
  const rootLine = lines.find((l) => /root/.test(l));
  const kidLine = lines.find((l) => /kid/.test(l));
  assert.match(rootLine, /^\s{2}/, "root is indented two spaces");
  assert.match(kidLine, /├─▶|└─▶/, "child carries a connector");
  assert.ok(!out.includes("\u001b"));
});

test("renderSwarmGraph marks repeated parents without redrawing the subtree", () => {
  const g = s.buildSwarmGraph([
    run("root", { parent: null }),
    run("a", { parent: 0 }),
    run("b", { parent: 0 }),
    run("shared", { parent: 1 }),
    run("shared2", { parent: 2 }),
  ]);
  const out = s.renderSwarmGraph(g);
  assert.match(out, /shared/);
  assert.match(out, /shared2/);
});

test("renderSwarmGraph says so when there are no runs", () => {
  const out = s.renderSwarmGraph(s.buildSwarmGraph([]));
  assert.match(out, /SWARM/);
  assert.match(out, /no agent runs/);
});

test("renderSwarmGraph never throws on malformed input", () => {
  assert.doesNotThrow(() => s.renderSwarmGraph());
  assert.doesNotThrow(() => s.renderSwarmGraph(null));
  assert.doesNotThrow(() => s.renderSwarmGraph({ nodes: "no" }));
});

test("renderSwarmGraph clips long lines to the requested width", () => {
  const g = s.buildSwarmGraph([run("a-really-long-agent-name-here", { model: "some/really/long/model/identifier", durationMs: 999999 })]);
  const out = s.renderSwarmGraph(g, { width: 40 });
  for (const line of out.split("\n")) assert.ok(ui.width(line) <= 40, `line too wide: ${JSON.stringify(line)}`);
});

test("renderSwarmGraph renders a cyclic graph without dropping nodes", () => {
  const g = /** @type {any} */ ({
    nodes: [
      { index: 0, id: "a", agentId: "a", parent: 1, layer: 0, state: "created", completed: false, iterations: 0, toolCalls: 0, durationMs: null, model: null },
      { index: 1, id: "b", agentId: "b", parent: 0, layer: 0, state: "created", completed: false, iterations: 0, toolCalls: 0, durationMs: null, model: null },
    ],
    edges: [],
    roots: [],
    layers: [],
  });
  const out = s.renderSwarmGraph(g);
  assert.match(out, /a/);
  assert.match(out, /b/);
});
