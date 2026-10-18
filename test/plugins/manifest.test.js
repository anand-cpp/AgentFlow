// Unit tests for the plugin manifest schema: JSON-file and package.json
// forms, validation edge cases, version gating, and spec normalization.
// Everything runs in throwaway temp directories.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MANIFEST_FILE,
  PERMISSION_KEYS,
  readPluginManifest,
  validatePluginManifest,
  satisfiesMinVersion,
  loadPluginSpec,
} from "../../src/core/plugins/manifest.js";

function dirWith(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-plug-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("readPluginManifest prefers agentflow.plugin.json over package.json", (t) => {
  const dir = dirWith(t, {
    [MANIFEST_FILE]: JSON.stringify({ id: "a", name: "A" }),
    "package.json": JSON.stringify({ agentflowPlugin: { id: "b", name: "B" } }),
  });
  const { manifest, source, error } = readPluginManifest(dir);
  assert.equal(manifest.id, "a");
  assert.equal(source, MANIFEST_FILE);
  assert.equal(error, null);
});

test("readPluginManifest falls back to the package.json agentflowPlugin key", (t) => {
  const dir = dirWith(t, {
    "package.json": JSON.stringify({ agentflowPlugin: { id: "b" } }),
  });
  const { manifest, source } = readPluginManifest(dir);
  assert.equal(manifest.id, "b");
  assert.equal(source, "package.json");
});

test("readPluginManifest reports invalid plugin JSON as a diagnostic", (t) => {
  const dir = dirWith(t, {
    // BOM-prefixed, like PowerShell 5 writes would be.
    [MANIFEST_FILE]: "\uFEFF{ nope",
  });
  const { manifest, source, error } = readPluginManifest(dir);
  assert.equal(manifest, null);
  assert.equal(source, MANIFEST_FILE);
  assert.match(error, /invalid JSON/);
});

test("readPluginManifest returns null manifest when nothing exists", (t) => {
  const dir = dirWith(t, {});
  const { manifest, source, error } = readPluginManifest(dir);
  assert.equal(manifest, null);
  assert.equal(source, null);
  assert.equal(error, null);
});

test("validatePluginManifest accepts a complete manifest", () => {
  const { valid, errors } = validatePluginManifest({
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    description: "d",
    author: "x",
    main: "main.js",
    permissions: { tools: true, hooks: ["onInit", "onShutdown"] },
    minAgentFlowVersion: "0.9.0",
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validatePluginManifest rejects missing and malformed ids", () => {
  assert.equal(validatePluginManifest({}).valid, false);
  assert.equal(validatePluginManifest({ id: "" }).valid, false);
  assert.equal(validatePluginManifest({ id: "has space" }).valid, false);
  assert.equal(
    validatePluginManifest({ id: "x".repeat(65) }).valid,
    false,
    "id longer than 64 chars rejected"
  );
  assert.equal(validatePluginManifest({ id: "_leading" }).valid, false);
});

test("validatePluginManifest rejects non-object manifests", () => {
  for (const bad of [null, undefined, "x", 42, []]) {
    const { valid, errors } = validatePluginManifest(bad);
    assert.equal(valid, false);
    assert.equal(errors.length, 1);
  }
});

test("validatePluginManifest rejects bad semver strings", () => {
  for (const v of [null, "1", "1.2", "^1.2.3", "latest", {}]) {
    const { valid } = validatePluginManifest({ id: "a", version: v });
    assert.equal(valid, false, `version ${String(v)} rejected`);
  }
});

test("validatePluginManifest rejects absolute or traversing main", () => {
  assert.equal(validatePluginManifest({ id: "a", main: "C:\\evil\\x.js" }).valid, false);
  assert.equal(validatePluginManifest({ id: "a", main: "/evil/x.js" }).valid, false);
  assert.equal(validatePluginManifest({ id: "a", main: "../evil.js" }).valid, false);
  assert.equal(validatePluginManifest({ id: "a", main: "lib/./x.js" }).valid, true);
});

test("validatePluginManifest rejects unknown permission domains", () => {
  const { valid, errors } = validatePluginManifest({
    id: "a",
    permissions: { provders: true },
  });
  assert.equal(valid, false);
  assert.match(errors[0], /unknown permission/);
});

test("validatePluginManifest accepts only known permission keys with good values", () => {
  const { valid } = validatePluginManifest({
    id: "a",
    permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])),
  });
  assert.equal(valid, true);
});

test("validatePluginManifest requires boolean or string-array permission values", () => {
  assert.equal(validatePluginManifest({ id: "a", permissions: { tools: 1 } }).valid, false);
  assert.equal(validatePluginManifest({ id: "a", permissions: { tools: ["x", 2] } }).valid, false);
  assert.equal(validatePluginManifest({ id: "a", permissions: { hooks: ["onInit"] } }).valid, true);
});

test("satisfiesMinVersion compares numeric triples", () => {
  assert.equal(satisfiesMinVersion("1.0.0", "1.2.0"), true);
  assert.equal(satisfiesMinVersion("1.2.0", "1.2.0"), true);
  assert.equal(satisfiesMinVersion("1.3.0", "1.2.9"), false);
  assert.equal(satisfiesMinVersion("2.0.0", "1.9.9"), false);
  assert.equal(satisfiesMinVersion("1.2.3-beta", "1.2.3-beta"), true);
  assert.equal(satisfiesMinVersion("0", "1.0.0"), true, "malformed min parses as 0.0.0");
});

test("loadPluginSpec normalizes fields and defaults main to index.js", (t) => {
  const dir = dirWith(t, {
    [MANIFEST_FILE]: JSON.stringify({
      id: "sample",
      name: "Sample",
      version: "1.0.0",
      permissions: { tools: true },
    }),
  });
  const spec = loadPluginSpec(dir, { currentVersion: "1.0.0" });
  assert.equal(spec.valid, true);
  assert.equal(spec.id, "sample");
  assert.equal(spec.main, "index.js");
  assert.deepEqual(
    Object.entries(spec.permissions).map(([k, v]) => [k, v]),
    [["tools", true], ["providers", false], ["hooks", false], ["commands", false]]
  );
});

test("loadPluginSpec keeps invalid plugins listable with diagnostics", (t) => {
  const dir = dirWith(t, {
    [MANIFEST_FILE]: JSON.stringify({ version: "bad" }),
  });
  const spec = loadPluginSpec(dir, { currentVersion: "1.0.0" });
  assert.equal(spec.valid, false);
  assert.ok(spec.errors.length >= 1);
  // Directory-basename fallback id keeps listing/disabling usable.
  assert.match(spec.id, /^aflow-plug-/);
});

test("loadPluginSpec flags version gate failures without crashing", (t) => {
  const dir = dirWith(t, {
    [MANIFEST_FILE]: JSON.stringify({ id: "old", minAgentFlowVersion: "99.99.0" }),
  });
  const spec = loadPluginSpec(dir, { currentVersion: "1.0.0" });
  assert.equal(spec.versionOk, false);
  assert.equal(spec.valid, false);
  assert.match(spec.errors[0], /requires AgentFlow >= 99\.99\.0/);
});

test("loadPluginSpec never throws on unreadable manifests", (t) => {
  const dir = dirWith(t, {});
  const spec = loadPluginSpec(dir, { currentVersion: "1.0.0" });
  assert.equal(spec.valid, false);
  assert.match(spec.errors[0], /no agentflow\.plugin\.json/);
});
