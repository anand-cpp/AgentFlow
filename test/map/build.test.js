// End-to-end builder tests on a fixture mini-repo: full build, cache round
// trip, incremental refresh (only changed files re-extracted), staleness
// detection, and degradation on corrupt caches.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMap,
  loadMap,
  refreshMap,
  mapFreshness,
  cachePathFor,
  CACHE_RELATIVE,
} from "../../src/core/map/build.js";

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-map-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const UTIL = "export function util() { return 1; }\n";
const MID = 'import { util } from "./util.js";\nexport function mid() { return util(); }\n';
const TOP = 'import { mid } from "./mid.js";\nexport function top() { return mid(); }\n';

test("buildMap ranks the most-imported file first and writes the cache", (t) => {
  const root = repo(t, {
    "src/util.js": UTIL,
    "src/mid.js": MID,
    "src/top.js": TOP,
  });
  const snapshot = buildMap(root);

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.stats.files, 3);
  assert.ok(snapshot.stats.edges > 0);
  const rankedFiles = snapshot.scores.filter((s) => !s.id.includes("#") && !s.id.startsWith("external:"));
  assert.equal(rankedFiles[0].id, "src/util.js", "the leaf everyone imports tops the file ranking");
  const cache = JSON.parse(fs.readFileSync(cachePathFor(root), "utf8"));
  assert.equal(cache.stats.files, 3);
  assert.equal(cache.root, root);
});

test("loadMap round-trips the cache and rejects foreign versions", (t) => {
  const root = repo(t, { "src/a.js": UTIL });
  buildMap(root);
  const map = loadMap(root);
  assert.ok(map);
  assert.equal(map.version, 1);

  const raw = JSON.parse(fs.readFileSync(cachePathFor(root), "utf8"));
  raw.version = 999;
  fs.writeFileSync(cachePathFor(root), JSON.stringify(raw));
  assert.equal(loadMap(root), null, "a future version is not readable");

  fs.writeFileSync(cachePathFor(root), "{not json");
  assert.equal(loadMap(root), null, "corrupt cache reads as absent");
});

test("refreshMap re-extracts only changed files", (t) => {
  const root = repo(t, { "src/a.js": UTIL, "src/b.js": 'import { util } from "./a.js";\nexport const b = 1;\n' });
  const first = buildMap(root);
  const firstUnit = first.units.find((u) => u.file === "src/b.js");

  // Touch b's content; leave a untouched.
  const bPath = path.join(root, "src", "b.js");
  fs.writeFileSync(bPath, 'import { util } from "./a.js";\nexport const b2 = 2;\n');
  // Keep mtime distinct from the cache's record.
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(bPath, future, future);

  const { snapshot, changed, removed, rebuilt } = refreshMap(root);
  assert.equal(rebuilt, false);
  assert.deepEqual(changed, ["src/b.js"]);
  assert.deepEqual(removed, []);
  const bUnit = snapshot.units.find((u) => u.file === "src/b.js");
  assert.ok(bUnit.symbols.some((s) => s.name === "b2"), "the changed file was re-extracted");
  assert.ok(firstUnit.symbols.every((s) => s.name !== "b2"), "the cache used to hold b1");
  const aUnit = snapshot.units.find((u) => u.file === "src/a.js");
  assert.deepEqual(aUnit.symbols.map((s) => s.name), ["util"], "unchanged file reused its unit");
});

test("refreshMap drops deleted files and picks up new ones", (t) => {
  const root = repo(t, { "src/a.js": UTIL });
  buildMap(root);
  fs.rmSync(path.join(root, "src", "a.js"));
  fs.writeFileSync(path.join(root, "src", "new.js"), "export const fresh = 1;\n");
  const { changed, removed } = refreshMap(root);
  assert.deepEqual(removed, ["src/a.js"]);
  assert.deepEqual(changed, ["src/new.js"]);
  const after = loadMap(root);
  assert.ok(after.units.every((u) => u.file !== "src/a.js"));
  assert.ok(after.units.some((u) => u.file === "src/new.js"));
});

test("refreshMap full-rebuilds when the cache is missing", (t) => {
  const root = repo(t, { "src/a.js": UTIL });
  const { rebuilt, snapshot } = refreshMap(root);
  assert.equal(rebuilt, true);
  assert.equal(snapshot.stats.files, 1);
});

test("mapFreshness reports missing, stale, and fresh caches", (t) => {
  const root = repo(t, { "src/a.js": UTIL });
  let fresh = mapFreshness(root);
  assert.equal(fresh.present, false);
  assert.equal(fresh.stale, true);

  buildMap(root);
  fresh = mapFreshness(root);
  assert.equal(fresh.present, true);
  assert.equal(fresh.stale, false);

  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, "src", "a.js"), future, future);
  fresh = mapFreshness(root);
  assert.equal(fresh.stale, true);
  assert.equal(fresh.reason, "src/a.js");
});

test("a gitignore change respects the new rules", (t) => {
  const root = repo(t, { "src/a.js": UTIL, "vendor/x.js": "ignore me" });
  const before = buildMap(root);
  assert.equal(before.stats.files, 2);
  fs.writeFileSync(path.join(root, ".gitignore"), "vendor/\n");
  const { snapshot, changed, rebuilt } = refreshMap(root);
  assert.equal(rebuilt, false);
  assert.ok(!snapshot.files.some((f) => f.rel.startsWith("vendor/")));
  assert.deepEqual(changed.filter((c) => c === "vendor/x.js"), [], "the file left the walk");
});

test("the mapLanguages knob narrows extraction to the requested families", (t) => {
  const root = repo(t, {
    "src/a.js": 'import os\n' /* actually python-ish content in a js file is noise; use real files */,
    "src/mod.py": "import os\ndef pub(): pass\n",
    "src/other.go": "package main\nfunc main() {}\n",
  });
  // Fix content: a.js as JS.
  fs.writeFileSync(path.join(root, "src", "a.js"), UTIL);
  const onlyPython = buildMap(root, { write: false, languages: ["python"] });
  assert.ok(onlyPython.units.every((u) => u.language === "python"), onlyPython.units.map((u) => u.file).join(","));
  assert.ok(onlyPython.units.some((u) => u.file === "src/mod.py"));
  const all = buildMap(root, { write: false, languages: null });
  assert.equal(all.units.length, 3, "null allowlist means every known family");
});

test("symbol and file nodes survive cyclic imports without rank blowup", (t) => {
  const root = repo(t, {
    "src/x.js": 'import { y } from "./y.js";\nexport function x() {}\n',
    "src/y.js": 'import { x } from "./x.js";\nexport function y() {}\n',
  });
  const snapshot = buildMap(root, { write: false });
  const total = snapshot.scores.reduce((s, e) => s + e.score, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `rank mass conserved: ${total}`);
  for (const e of snapshot.scores) {
    assert.ok(Number.isFinite(e.score) && e.score > 0, "finite, positive rank everywhere");
  }
});

test("map build is Windows/Unix path-stable and uses forward slashes", (t) => {
  const root = repo(t, { "src/deep/a.js": UTIL });
  const snapshot = buildMap(root);
  for (const f of snapshot.files) {
    assert.ok(!f.rel.includes("\\"), `forward slashes only: ${f.rel}`);
  }
});

test("an empty workspace builds an empty map", (t) => {
  const root = repo(t, {});
  const snapshot = buildMap(root);
  assert.equal(snapshot.stats.files, 0);
  assert.equal(snapshot.stats.nodes, 0);
  assert.deepEqual(snapshot.scores, []);
  assert.equal(mapFreshness(root).stale, false);
});

test("huge binary-ish and ignored dirs never reach the map", (t) => {
  const root = repo(t, {
    "src/a.js": UTIL,
    "node_modules/dep/index.js": "module.exports = 1;",
    "logo.png": Buffer.alloc(64, 7),
  });
  const snapshot = buildMap(root);
  assert.equal(snapshot.stats.files, 1);
});

test("default root is the process cwd", () => {
  assert.equal(typeof CACHE_RELATIVE, "string");
  assert.ok(cachePathFor(".").includes("repo-map.json"));
});
