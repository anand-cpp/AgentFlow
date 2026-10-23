// Unit tests for the reference graph: import resolution against a real file
// set, degrees and adjacency, define/external edges, and never-self-linking.
import test from "node:test";
import assert from "node:assert/strict";

import { RefGraph, resolveImport, buildRefGraph } from "../../src/core/map/graph.js";

test("resolveImport picks the first candidate that is a real file", () => {
  const files = new Set(["src/b.ts", "src/lib/c/index.js"]);
  assert.deepEqual(resolveImport("./b.ts", "src/a.ts", files), { resolved: "src/b.ts", external: false });
  assert.deepEqual(
    resolveImport("../lib/c", "src/core/x.ts", files),
    { resolved: "src/lib/c/index.js", external: false },
  );
  assert.deepEqual(resolveImport("node:path", "a.js", files), { resolved: null, external: true });
});

test("the graph tracks nodes, edges, degrees and adjacency", () => {
  const g = new RefGraph();
  g.addNode("a", { kind: "file" });
  g.addEdge("a", "b", { weight: 2 });
  g.addEdge("a", "c", { weight: 1 });
  g.addEdge("b", "a", { weight: 1 });

  assert.equal(g.size().nodes, 3);
  assert.equal(g.size().edges, 3);
  assert.equal(g.outDegree("a"), 2);
  assert.equal(g.inDegree("a"), 1);
  assert.deepEqual(g.neighbors("a").map((n) => n.id), ["b", "c"]);
  assert.equal(g.neighbors("a")[0].weight, 2);
  assert.equal(g.neighbors("b")[0].weight, 1);
  assert.equal(g.hasEdge("a", "b"), true);
  assert.equal(g.hasEdge("c", "a"), false);
  assert.equal(g.node("a").kind, "file");
  assert.equal(g.node("b").kind, "external", "addEdge without a declared target defers to external");
});

test("self-edges are refused", () => {
  const g = new RefGraph();
  g.addNode("x", { kind: "file" });
  g.addEdge("x", "x");
  assert.equal(g.size().nodes, 1);
  assert.equal(g.size().edges, 0);
});

test("buildRefGraph resolves workspace targets and stubs external ones", () => {
  const units = [
    {
      file: "src/a.ts",
      symbols: [{ name: "hello", kind: "function", line: 1, exported: true }],
      imports: [
        { raw: "./b.ts" },
        { raw: "lodash" },
      ],
    },
    {
      file: "src/b.ts",
      symbols: [],
      imports: [],
    },
  ];
  const { graph, unresolved } = buildRefGraph(units, { fileSet: new Set(["src/a.ts", "src/b.ts"]) });
  assert.equal(graph.size().nodes, 4, "a, b, symbol hello, external lodash stub");
  assert.equal(graph.hasEdge("src/a.ts", "src/b.ts"), true);
  assert.equal(graph.hasEdge("src/a.ts", "src/a.ts#hello"), true);
  assert.equal(graph.hasEdge("src/a.ts", "external:lodash"), true);
  assert.equal(graph.node("external:lodash").external, true);
  assert.equal(graph.inDegree("external:lodash"), 1);
  assert.equal(graph.outDegree("external:lodash"), 0, "the stub has no outbound edges, so its rank bottoms out");
  assert.deepEqual(unresolved, [{ file: "src/a.ts", raw: "lodash" }]);
});

test("a resolved field on the import is trusted when it is a real file", () => {
  const units = [{ file: "a.js", symbols: [], imports: [{ raw: "b.js", resolved: "b.js" }] }];
  const { graph } = buildRefGraph(units, { fileSet: new Set(["a.js", "b.js"]) });
  assert.equal(graph.size().nodes, 2);
  assert.equal(graph.hasEdge("a.js", "b.js"), true);
});

test("a resolved field that is not in fileSet falls back to re-resolution", () => {
  const units = [
    {
      file: "a.js",
      symbols: [],
      imports: [
        // resolved points at a missing path but the raw can still resolve
        { raw: "./b.js", resolved: "nope/b.js" },
      ],
    },
  ];
  const { graph, unresolved } = buildRefGraph(units, { fileSet: new Set(["a.js", "b.js"]) });
  assert.equal(graph.hasEdge("a.js", "b.js"), true);
  assert.equal(unresolved.length, 0);
});

test("symbol nodes exist under their defining file with a low define weight", () => {
  const units = [
    {
      file: "src/x.ts",
      symbols: [
        { name: "one", kind: "function", line: 1, exported: true },
        { name: "two", kind: "function", line: 2, exported: true },
      ],
      imports: [],
    },
  ];
  const { graph } = buildRefGraph(units);
  assert.equal(graph.size().nodes, 3);
  const defEdges = graph.edges().filter((e) => e.to === "src/x.ts#one" || e.to === "src/x.ts#two");
  assert.equal(defEdges.length, 2);
  assert.ok(defEdges.every((e) => e.weight === 0.3));
});

test("inDegree counts distinct inbound files, not multiplicity", () => {
  const units = [
    { file: "a.js", symbols: [], imports: [{ raw: "./c.js" }, { raw: "./c.js" }] },
    { file: "b.js", symbols: [], imports: [{ raw: "./c.js" }] },
  ];
  const { graph } = buildRefGraph(units, { fileSet: new Set(["a.js", "b.js", "c.js"]) });
  assert.equal(graph.inDegree("c.js"), 2);
  assert.equal(graph.size().edges, 2);
});
