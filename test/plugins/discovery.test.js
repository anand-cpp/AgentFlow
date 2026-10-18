// Unit tests for plugin discovery: the three install locations, precedence and
// shadowing, node_modules prefix matching, enable/disable toggling, and the
// enabled/disabled/invalid status derivation. All run inside temp trees with
// the global dir injected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  globalPluginsDir,
  pluginsStateFile,
  readPluginState,
  writePluginState,
  setPluginEnabled,
  discoverPlugins,
} from "../../src/core/plugins/discovery.js";
import { MANIFEST_FILE } from "../../src/core/plugins/manifest.js";

/** Admission helper: every plugin fixture gets a valid minimal manifest file
 *  unless the test overrides the content string. */
function makePlugin(root, rel, manifest = { id: path.basename(rel) }) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MANIFEST_FILE),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest)
  );
  return dir;
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-disc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("globalPluginsDir honors AGENTFLOW_CONFIG_DIR", (t) => {
  const prev = process.env.AGENTFLOW_CONFIG_DIR;
  process.env.AGENTFLOW_CONFIG_DIR = "Z:\\fake-config";
  t.after(() => {
    if (prev === undefined) delete process.env.AGENTFLOW_CONFIG_DIR;
    else process.env.AGENTFLOW_CONFIG_DIR = prev;
  });
  assert.equal(path.basename(globalPluginsDir()), "plugins");
  assert.ok(globalPluginsDir().includes("fake-config"));
});

test("discoverPlugins finds workspace plugins with status enabled", (t) => {
  const root = tempRoot(t);
  makePlugin(root, path.join(".agentflow", "plugins", "alpha"));
  const { plugins, diagnostics } = discoverPlugins({ workspaceRoot: root, nodeModulesDir: path.join(root, "none") });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, "alpha");
  assert.equal(plugins[0].status, "enabled");
  assert.equal(plugins[0].source, "workspace");
  assert.deepEqual(diagnostics, []);
});

test("discoverPlugins reports a manifest-less workspace directory", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, ".agentflow", "plugins", "no-manifest"), { recursive: true });
  const { diagnostics } = discoverPlugins({ workspaceRoot: root, nodeModulesDir: path.join(root, "none") });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /no agentflow\.plugin\.json manifest/);
});

test("global source is scanned and shadows resolve workspace-first", (t) => {
  const root = tempRoot(t);
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-gdisc-"));
  t.after(() => fs.rmSync(globalDir, { recursive: true, force: true }));

  makePlugin(root, path.join(".agentflow", "plugins", "dup"), { id: "dup", version: "2.0.0" });
  makePlugin(root, path.join(".agentflow", "plugins", "onlyws"));
  makePlugin(globalDir, "dup");
  makePlugin(globalDir, "onlyglobal");

  const { plugins } = discoverPlugins({
    workspaceRoot: root,
    globalDir,
    nodeModulesDir: path.join(root, "none"),
  });
  const ids = plugins.map((p) => `${p.id}@${p.version ?? "?"}`);
  assert.deepEqual(ids.sort(), ["dup@2.0.0", "onlyglobal@?", "onlyws@?"]);
  assert.equal(plugins.filter((p) => p.id === "dup")[0].source, "workspace");
});

test("node_modules matches agentflow-plugin-* and scoped names only", (t) => {
  const root = tempRoot(t);
  const nm = path.join(root, "node_modules");
  makePlugin(nm, "agentflow-plugin-ok", { id: "nmod" });
  makePlugin(nm, path.join("@scope", "agentflow-plugin-scoped"), { id: "scoped" });
  makePlugin(nm, "some-other-package"); // no manifest, no prefix: invisible
  makePlugin(nm, "my-plugin-cool"); // prefix mismatch: invisible

  const { plugins, diagnostics } = discoverPlugins({ workspaceRoot: root, globalDir: path.join(root, "none") });
  const ids = plugins.map((p) => p.id).sort();
  assert.deepEqual(ids, ["nmod", "scoped"]);
  for (const p of plugins) {
    assert.equal(p.source, "node_modules");
    assert.equal(p.status, "enabled");
  }
  assert.deepEqual(diagnostics, [], "name-matched but manifest-less packages are silent");
});

test("disabled state in plugins.json marks status disabled", (t) => {
  const root = tempRoot(t);
  makePlugin(root, path.join(".agentflow", "plugins", "alpha"));
  assert.equal(setPluginEnabled("alpha", false, root).ok, true);

  const { plugins } = discoverPlugins({ workspaceRoot: root, nodeModulesDir: path.join(root, "none") });
  assert.equal(plugins[0].status, "disabled");

  setPluginEnabled("alpha", true, root);
  const after = discoverPlugins({ workspaceRoot: root, nodeModulesDir: path.join(root, "none") });
  assert.equal(after.plugins[0].status, "enabled");
});

test("invalid manifests surface with status invalid and diagnostics", (t) => {
  const root = tempRoot(t);
  makePlugin(root, path.join(".agentflow", "plugins", "broken"), "{ not json");
  const { plugins, diagnostics } = discoverPlugins({ workspaceRoot: root, nodeModulesDir: path.join(root, "none") });
  assert.equal(plugins[0].status, "invalid");
  assert.equal(diagnostics.length, 1);
});

test("readPluginState tolerates missing, corrupt, and malformed files", (t) => {
  const root = tempRoot(t);
  assert.deepEqual(readPluginState(root).enabled, {}, "absent file is empty state");

  fs.mkdirSync(path.join(root, ".agentflow"), { recursive: true });
  fs.writeFileSync(pluginsStateFile(root), "{ nope");
  assert.deepEqual(readPluginState(root).enabled, {}, "corrupt file is empty state");

  fs.writeFileSync(pluginsStateFile(root), JSON.stringify({ plugins: { a: "yes", b: false, c: {} } }));
  assert.deepEqual(readPluginState(root).enabled, { b: false });
});

test("writePluginState persists and setPluginEnabled merges", (t) => {
  const root = tempRoot(t);
  assert.equal(writePluginState({ a: true, b: false }, root).ok, true);
  assert.equal(setPluginEnabled("c", true, root).ok, true);
  assert.deepEqual(readPluginState(root).enabled, { a: true, b: false, c: true });
});

test("workspace plugin ordering is deterministic (id-sorted per source)", (t) => {
  const root = tempRoot(t);
  makePlugin(root, path.join(".agentflow", "plugins", "zeta"));
  makePlugin(root, path.join(".agentflow", "plugins", "alpha"));
  const { plugins } = discoverPlugins({ workspaceRoot: root, nodeModulesDir: path.join(root, "none") });
  assert.deepEqual(plugins.map((p) => p.id), ["alpha", "zeta"]);
});

test("globalPluginsDir falls back to platform config dirs without the env var", () => {
  delete process.env.AGENTFLOW_CONFIG_DIR;
  const dir = globalPluginsDir();
  assert.equal(path.basename(dir), "plugins");
  assert.ok(path.isAbsolute(dir));
});
