// CLI integration for `aflow map`: show/build/query/stats against a fixture
// repo, plus slash-dispatch parity. Runs against the real module exports, the
// same way the mcp and blackboard CLI tests do.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dispatchMap, mapSlash, fileRanking } from "../../src/commands/map.js";
import { cachePathFor } from "../../src/core/map/build.js";

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-mapcli-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const FILES = {
  "src/util.js": "export function util() { return 1; }\n",
  "src/mid.js": 'import { util } from "./util.js";\nexport function mid() { return util(); }\n',
  "src/top.js": 'import { mid } from "./mid.js";\nexport function top() { return mid(); }\n',
};

test("show auto-builds a missing cache and prints the ranked tree", async (t) => {
  const root = repo(t, FILES);
  const result = await dispatchMap(root, []);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("repository map"), result.text);
  assert.ok(result.text.includes("src/util.js"), "the top-ranked file is listed");
  assert.ok(result.text.includes("util"), "exported symbols surface");
  assert.ok(fs.existsSync(cachePathFor(root)), "show left a cache behind");
});

test("fileRanking filters symbols and externals, sorts by score", async (t) => {
  const root = repo(t, FILES);
  const result = await dispatchMap(root, []);
  const ranking = fileRanking(result.data.map);
  assert.ok(ranking.every((r) => !r.id.includes("#") && !r.id.startsWith("external:")));
  for (let i = 1; i < ranking.length; i += 1) {
    assert.ok(ranking[i - 1].score >= ranking[i].score, "descending");
  }
});

test("build forces a full rebuild and reports counts", async (t) => {
  const root = repo(t, FILES);
  await dispatchMap(root, ["show"]);
  const mtime1 = fs.statSync(cachePathFor(root)).mtimeMs;
  const result = await dispatchMap(root, ["build"]);
  assert.equal(result.ok, true);
  assert.ok(/rebuilt/.test(result.text));
  assert.ok(result.data.stats.files === 3);
  assert.ok(fs.statSync(cachePathFor(root)).mtimeMs >= mtime1, "the cache was rewritten");
});

test("query re-ranks around keywords", async (t) => {
  const root = repo(t, FILES);
  await dispatchMap(root, ["show"]);
  const result = await dispatchMap(root, ["query", "mid", "handler"]);
  assert.equal(result.ok, true);
  assert.ok(result.data.query === "mid handler");
  const text = result.text;
  assert.ok(text.includes("src/mid.js"), "the queried file appears");
  assert.ok(text.includes("## Repository map"), "query output is the prompt-shaped block");
  // A query with no text is a usage error.
  const empty = await dispatchMap(root, ["query"]);
  assert.equal(empty.ok, false);
});

test("stats reports nodes, edges, age and top ten", async (t) => {
  const root = repo(t, FILES);
  await dispatchMap(root, ["show"]);
  const result = await dispatchMap(root, ["stats"]);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("repo map stats"));
  assert.ok(result.text.includes("fresh"), "fresh cache reports as fresh");
  assert.ok(result.text.includes("top 10:"));
});

test("stats auto-builds when the cache is missing", async (t) => {
  const root = repo(t, FILES);
  const result = await dispatchMap(root, ["stats"]);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("built just now"), result.text);
});

test("unknown subcommand and help behave like mcp", async (t) => {
  const root = repo(t, FILES);
  const bad = await dispatchMap(root, ["explode"]);
  assert.equal(bad.ok, false);
  assert.ok(bad.text.includes("unknown map subcommand"));
  const help = await dispatchMap(root, ["help"]);
  assert.equal(help.ok, true);
  assert.ok(help.text.includes("aflow map build"));
});

test("mapSlash mirrors dispatchMap", async (t) => {
  const root = repo(t, FILES);
  const text = await mapSlash("stats", { root });
  assert.ok(text.includes("repo map stats"));
  const bad = await mapSlash("bogus", { root });
  assert.ok(bad.includes("unknown map subcommand"));
  const show = await mapSlash("", { root });
  assert.ok(show.includes("src/util.js"));
});

test("an empty workspace stats cleanly, never crashes", async (t) => {
  const root = repo(t, {});
  const result = await dispatchMap(root, ["stats"]);
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("files          0"), result.text);
});
