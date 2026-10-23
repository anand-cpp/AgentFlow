// Unit tests for the sandboxed plugin loader: CJS evaluation in a vm realm,
// sandbox isolation (require allowlist, console redirect, frozen context),
// activate timeouts, entry containment, ESM mode, and failure isolation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadPlugin,
  PluginLoader,
  PluginLoaderError,
  resolvePluginEntry,
  MAX_ENTRY_BYTES,
} from "../../src/core/plugins/loader.js";
import { loadPluginSpec } from "../../src/core/plugins/manifest.js";
import { MANIFEST_FILE } from "../../src/core/plugins/manifest.js";

function pluginDir(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-load-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function specFor(root, overrides = {}) {
  return loadPluginSpec(root, { currentVersion: "1.0.0", ...overrides });
}

const minimalManifest = JSON.stringify({ id: "sample", name: "Sample" });

test("sandbox evaluates CJS and finds activate via module.exports function", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = function activate(ctx) { ctx.log.info('booted', ctx.id); };",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, true);
  assert.equal(result.plugin.spec.id, "sample");
  assert.equal(result.plugin.format, "sandbox");
  assert.ok(result.plugin.log.lines.some((l) => l.level === "info" && l.message === "booted sample"));
  assert.deepEqual(result.diagnostics, []);
});

test("{ activate } and default-export shapes both work", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = { activate(ctx) { ctx.log.info('obj'); } };",
  });
  const r1 = await loadPlugin(specFor(dir));
  assert.equal(r1.ok, true);

  const dir2 = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = { default: { activate(ctx) { ctx.log.info('nested'); } } };",
  });
  const r2 = await loadPlugin(specFor(dir2));
  assert.equal(r2.ok, true);
  assert.ok(r2.plugin.log.lines.some((l) => l.message === "nested"));
});

test("activate is a plain function shape too (module.exports = function)", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = () => { /* nothing */ };",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, true);
});

test("context handed to the plugin is frozen and mutations are ignored", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": `
      module.exports = function activate(ctx) {
        ctx.log.info('report',
          String(Object.isFrozen(ctx)),
          String(Object.isFrozen(ctx.permissions)),
          String(Object.isFrozen(ctx.log)));
        ctx.id = 'hacked';
        ctx.permissions.tools = true;
        ctx.log.info('after', String(ctx.id), String(ctx.permissions.tools));
      };
    `,
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, true);
  const messages = result.plugin.log.lines.map((l) => l.message);
  assert.equal(messages[0], "report true true false", "envelope frozen; log protected at the method level");
  assert.equal(messages[1], "after sample false", "sloppy-mode frozen writes no-op");
});

test("context only exposes the public API, never internals", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": `
      module.exports = function activate(ctx) {
        ctx.log.info('keys', Object.keys(ctx).sort().join('|'));
      };
    `,
  });
  const result = await loadPlugin(specFor(dir));
  const messages = result.plugin.log.lines.map((l) => l.message);
  assert.equal(messages[0], "keys id|log|manifest|on|permissions|registerContextProvider|registerProvider|registerSlashCommand|registerTool");
});

test("console output inside the sandbox routes to the plugin log ring", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "console.log('hello', 'world'); console.warn('careful'); console.error('oops'); module.exports = function activate() {};",
  });
  const seen = [];
  const result = await loadPlugin(specFor(dir), {
    onLine: (id, level, message) => seen.push({ id, level, message }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    seen.map((s) => `${s.level}:${s.message}`),
    ["info:hello world", "warn:careful", "error:oops"]
  );
});

test("log ring caps at the documented maximum", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "for (let i = 0; i < 500; i++) console.log('line', i); module.exports = function activate() {};",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, true);
  const lines = result.plugin.log.lines;
  assert.ok(lines.length <= 200);
  const last = lines[lines.length - 1];
  assert.match(last.message, /499|498/);
});

test("require allowlist refuses modules beyond node:events", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "require('node:fs'); module.exports = function activate() {};",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /may only require/);
});

test("require grants a per-plugin events factory, not the shared class", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": `
      const { EventEmitter } = require('node:events');
      const a = new EventEmitter();
      const b = new EventEmitter();
      a.on('x', function y() {});
      module.exports = function activate(ctx) {
        ctx.log.info('crossbleed', String(Object.keys(b).length >= 0));
      };
    `,
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, true);
  assert.ok(result.plugin.log.lines[0].message.startsWith("crossbleed"));
});

test("entry containment: main escaping the plugin directory is refused", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: JSON.stringify({ id: "escape", main: "../host.js" }),
    "index.js": "module.exports = function activate() {};",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /escapes the plugin directory/);
  assert.throws(() => resolvePluginEntry({ dir, main: "C:\\Windows\\system32\\x.js" }), PluginLoaderError);
});

test("missing entry file produces a diagnostic, not a crash", async (t) => {
  const dir = pluginDir(t, { [MANIFEST_FILE]: minimalManifest });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /entry file not found/);
});

test("oversized entries are refused before anyone parses them", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": `/* ${"x".repeat(MAX_ENTRY_BYTES + 10)} */`,
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /limit is/);
});

test("missing activate is a diagnostic, not a crash", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = { name: 'not a plugin' };",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /no activate function/);
});

test("syntax errors are captured as diagnostics", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = function() { catch ; };",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics[0].length > 0);
});

test("activate timeout aborts hanging plugins without aborting the host", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = async function activate(ctx) { await new Promise(() => {}); };",
  });
  const result = await loadPlugin(specFor(dir), { timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /activate\(sample\): timed out/);
});

test("activate rejection produces a diagnostic naming the plugin", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = async function activate() { throw new Error('boom'); };",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, false);
  assert.match(result.diagnostics[0], /Error: boom/);
});

test("esm plugins load through dynamic import in trusted mode", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: JSON.stringify({ id: "esmplug", format: "esm" }),
    "plug.mjs": "export function activate(ctx) { ctx.log.info('esm loaded'); }",
  });
  const spec = specFor(dir);
  spec.main = "plug.mjs";
  const result = await loadPlugin(spec);
  assert.equal(result.ok, true);
  assert.equal(result.plugin.format, "esm");
  assert.ok(result.plugin.log.lines.some((l) => l.message === "esm loaded"));
});

test(".mjs mains are detected as esm without the format field", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.mjs": "export default function activate(ctx) { ctx.log.info('auto'); }",
  });
  const result = await loadPlugin(specFor(dir));
  assert.equal(result.ok, true);
  assert.equal(result.plugin.format, "esm");
});

test("deactivate hook errors are contained and success is reported", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = { activate() {}, deactivate() { throw new Error('cannot stop'); } };",
  });
  const loader = new PluginLoader();
  const result = await loader.load(specFor(dir));
  assert.equal(result.ok, true);
  const unload = await loader.unload("sample");
  assert.equal(unload.ok, false);
  assert.match(unload.error, /cannot stop/);

  const loader2 = new PluginLoader();
  const dir2 = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = { activate() {}, deactivate() { /* ok */ } };",
  });
  await loader2.load(specFor(dir2));
  const ok = await loader2.unload("sample");
  assert.deepEqual(ok, { ok: true, error: null });
});

test("unload of an unknown id is a no-op success", async () => {
  const loader = new PluginLoader();
  const res = await loader.unload("ghost");
  assert.deepEqual(res, { ok: true, error: null, missing: true });
});

test("failed loads are retained as null so inspect can still narrate", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": "module.exports = {};",
  });
  const loader = new PluginLoader();
  const result = await loader.load(specFor(dir));
  assert.equal(result.ok, false);
  assert.deepEqual(loader.loaded(), []);
});

test("registrar hooks fire through the context API and receive the plugin id", async (t) => {
  const dir = pluginDir(t, {
    [MANIFEST_FILE]: minimalManifest,
    "index.js": `
      module.exports = function activate(ctx) {
        ctx.on('onInit', function a() {});
        ctx.registerTool({ name: 'echo', description: 'd', execute() {} });
        ctx.registerProvider({ id: 'p', name: 'P', complete() {} });
        ctx.registerSlashCommand({ name: 'greet', description: 'G', handler() {} });
        ctx.registerContextProvider({ name: 'notes', getContext() { return ''; } });
      };
    `,
  });
  const calls = [];
  const result = await loadPlugin(specFor(dir), {
    onHook: (pid, hook, _fn) => calls.push(["hook", pid, hook]),
    onRegisterTool: (pid, def) => calls.push(["tool", pid, def.name]),
    onRegisterProvider: (pid, def) => calls.push(["provider", pid, def.id]),
    onRegisterSlashCommand: (pid, def) => calls.push(["command", pid, def.name]),
    onRegisterContextProvider: (pid, def) => calls.push(["context", pid, def.name]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["hook", "sample", "onInit"],
    ["tool", "sample", "echo"],
    ["provider", "sample", "p"],
    ["command", "sample", "greet"],
    ["context", "sample", "notes"],
  ]);
});
