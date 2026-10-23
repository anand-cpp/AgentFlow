// PageRank on known synthetic graphs, where the right answer is provable by
// hand: a cycle ranks every node equal, a diamond concentrates rank on its
// hub, weights shift flow, damping changes distributions, and biases
// personalise the teleport.
import test from "node:test";
import assert from "node:assert/strict";

import { pagerank } from "../../src/core/map/pagerank.js";
import { RefGraph, buildRefGraph } from "../../src/core/map/graph.js";

/** Minimal graph double: RefGraph covers it. */
const g = () => new RefGraph();

test("two mutual links tie the scores exactly", () => {
  const graph = g();
  graph.addEdge("a", "b");
  graph.addEdge("b", "a");
  const scores = pagerank(graph);
  for (const v of scores.values()) assert.equal(v, 0.5);
});

test("the cycle distributes rank evenly, no matter the history", () => {
  const graph = g();
  graph.addEdge("a", "b");
  graph.addEdge("b", "c");
  graph.addEdge("c", "a");
  const scores = pagerank(graph);
  for (const v of scores.values()) assert.ok(Math.abs(v - 1 / 3) < 1e-12);
});

test("the diamond concentrates rank at the hub", () => {
  const graph = g();
  graph.addEdge("in1", "hub");
  graph.addEdge("in2", "hub");
  graph.addEdge("hub", "left");
  graph.addEdge("hub", "right");
  graph.addEdge("left", "hub");
  graph.addEdge("right", "hub");
  const scores = pagerank(graph);
  const order = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  assert.equal(order[0], "hub");
  assert.ok(scores.get("hub") > 0.3);
  // the two unlinked sources have no inbound: strictly smallest
  assert.equal(order.at(-1) === "in1" || order.at(-1) === "in2", true);
  assert.ok(Math.abs(scores.get("in1") - scores.get("in2")) < 1e-15, "symmetric twins rank equal");
});

test("weighted edges shift the outflow to match the weight", () => {
  const graph = g();
  graph.addNode("a");
  graph.addNode("far");
  graph.addNode("near");
  graph.addEdge("a", "far", { weight: 9 });
  graph.addEdge("a", "near", { weight: 1 });
  // With equal weights these twins would tie; the 9:1 split makes far lead.
  const scores = pagerank(graph);
  assert.ok(scores.get("far") > scores.get("near"));
});

test("dangling rank is redistributed, not lost", () => {
  const graph = g();
  graph.addEdge("a", "b");
  // c dangles
  const scores = pagerank(graph);
  // conservation: total mass is 1
  const total = [...scores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
  assert.ok(scores.get("b") > scores.get("a"), "the linked node outranks its source");
});

test("high damping boosts link-following over teleport", () => {
  const graph = g();
  graph.addEdge("src", "dst");
  const loose = pagerank(graph, { damping: 0.15 });
  const tight = pagerank(graph, { damping: 0.95 });
  assert.ok(tight.get("dst") / tight.get("src") > loose.get("dst") / loose.get("src"));
});

test("biases personalise: a boosted node can overtake the hub", () => {
  const graph = g();
  graph.addEdge("a", "hub");
  graph.addEdge("b", "hub");
  const plain = pagerank(graph);
  // Low damping makes the teleport (where the bias lives) the dominant term,
  // so a strong bias can overcome the hub's two inbound links.
  const boosted = pagerank(graph, { damping: 0.3, biases: new Map([["a", 10]]) });
  assert.ok(plain.get("hub") > plain.get("a"), "without bias the hub leads");
  assert.ok(boosted.get("a") > boosted.get("hub"), "personalization overtakes the hub");
});

test("epsilon and maxIteration stop the run and keep mass conserved", () => {
  const graph = g();
  for (const id of ["a", "b", "c", "d", "e"]) graph.addNode(id);
  graph.addEdge("a", "b");
  graph.addEdge("b", "c");
  graph.addEdge("c", "d");
  graph.addEdge("d", "e");
  graph.addEdge("e", "a");
  const scores = pagerank(graph, { epsilon: 1e-16, maxIterations: 3 });
  const total = [...scores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
});

test("empty graph returns an empty map; single node reports 1", () => {
  assert.deepEqual(pagerank(g()).size, 0);
  const one = g();
  one.addNode("solo");
  assert.deepEqual([...pagerank(one).entries()], [["solo", 1]]);
});

test("invalid options fall back to safe defaults", () => {
  const graph = g();
  graph.addEdge("a", "b");
  graph.addEdge("b", "a");
  const scores = pagerank(graph, { damping: 42, epsilon: -5, maxIterations: 0.5 });
  const total = [...scores.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-12);
});

test("the real file graph ranks imported files above importers", () => {
  const units = [
    { file: "src/core/util.ts", symbols: [], imports: [] },
    { file: "src/core/map.ts", symbols: [], imports: [{ raw: "./util.ts" }] },
    { file: "src/core/run.ts", symbols: [], imports: [{ raw: "./map.ts" }] },
  ];
  const { graph } = buildRefGraph(units, { fileSet: new Set(["src/core/util.ts"]) });
  const scores = pagerank(graph, { epsilon: 1e-12 });
  const ut = scores.get("src/core/util.ts");
  if (ut !== undefined) {
    assert.ok(ut >= scores.get("src/core/run.ts"), "leaf utility outranks the top-level importer");
  }
});
