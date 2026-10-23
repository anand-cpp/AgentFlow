// End-to-end plugin tests over the on-disk fixtures.
//
// The other plugin suites test one registry at a time with inline sources.
// This file stages real fixture directories into a temp workspace and drives
// the whole chain a user actually touches: discovery reads the manifest, the
// sandbox loads the entry, the manager registers what it declared, the CLI
// reports it, and a full AgentRuntime run observes it.
//
// The fixtures are deliberately spread across the trust surface:
//   sample-plugin  CommonJS, hooks + tool + command + context block
//   broken-plugin  throws during activation (fail-isolation)
//   esm-plugin     ESM, loaded through the trusted import() path

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineAgent, AgentRegistry, TOOL_SCOPE } from "../../src/core/agents/registry.js";
import { AgentRuntime } from "../../src/core/agents/runtime.js";
import { ChatSession } from "../../src/core/chat.js";
import { SessionStore } from "../../src/core/sessions.js";
import { PluginManager } from "../../src/core/plugins/manager.js";
import { discoverPlugins } from "../../src/core/plugins/discovery.js";
import { MANIFEST_FILE } from "../../src/core/plugins/manifest.js";
import { dispatchPlugin } from "../../src/commands/plugin.js";
import { VERSION } from "../../src/core/version.js";

const CATALOGUE = ["oc/muse"];
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Copy named fixtures into a fresh workspace's `.agentflow/plugins/`.
 *
 * The global config dir is redirected too: discovery also scans the user-wide
 * plugins directory, and a test that read the developer's real installed
 * plugins would assert on whatever happened to be on their machine.
 */
function stage(t, names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-fixture-"));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-fixture-global-"));
  const prev = process.env.AGENTFLOW_CONFIG_DIR;
  process.env.AGENTFLOW_CONFIG_DIR = globalDir;

  for (const name of names) {
    const from = path.join(FIXTURES, name);
    const to = path.join(root, ".agentflow", "plugins", name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }

  t.after(() => {
    if (prev === undefined) delete process.env.AGENTFLOW_CONFIG_DIR;
    else process.env.AGENTFLOW_CONFIG_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(globalDir, { recursive: true, force: true });
  });
  return root;
}

async function managerFor(t, root, opts = {}) {
  const mgr = new PluginManager({ workspaceRoot: root, currentVersion: VERSION, ...opts });
  await mgr.init();
  t.after(() => mgr.shutdown().catch(() => {}));
  return mgr;
}

function toolCallJson(calls) {
  return "```json\n" + JSON.stringify(calls) + "\n```";
}

// --- discovery ---------------------------------------------------------------

test("discovery reads the fixtures straight off disk", async (t) => {
  const root = stage(t, ["sample-plugin", "broken-plugin", "esm-plugin"]);
  const { plugins } = discoverPlugins({ workspaceRoot: root, currentVersion: VERSION });

  const ids = plugins.map((p) => p.id).sort();
  assert.deepEqual(ids, ["broken-plugin", "esm-plugin", "sample-plugin"]);

  const sample = plugins.find((p) => p.id === "sample-plugin");
  assert.equal(sample.source, "workspace");
  assert.equal(sample.status, "enabled", "a valid manifest with no state file is enabled");
  assert.equal(sample.version, "1.0.0");
  assert.equal(sample.permissions.tools, true);

  const esm = plugins.find((p) => p.id === "esm-plugin");
  assert.equal(esm.manifest.main, "index.mjs", "the manifest declares the ESM entry");
});

test("enable and disable persist into plugins.json and survive rediscovery", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const { setPluginEnabled } = await import("../../src/core/plugins/discovery.js");

  const off = setPluginEnabled("sample-plugin", false, root);
  assert.equal(off.ok, true);
  assert.ok(fs.existsSync(path.join(root, ".agentflow", "plugins.json")));

  let { plugins } = discoverPlugins({ workspaceRoot: root, currentVersion: VERSION });
  assert.equal(plugins.find((p) => p.id === "sample-plugin").status, "disabled");

  setPluginEnabled("sample-plugin", true, root);
  ({ plugins } = discoverPlugins({ workspaceRoot: root, currentVersion: VERSION }));
  assert.equal(plugins.find((p) => p.id === "sample-plugin").status, "enabled");
});

// --- sandbox loading ---------------------------------------------------------

test("the sandboxed CJS fixture loads and registers exactly what it declared", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const mgr = await managerFor(t, root);

  const plugin = mgr.loaded.get("sample-plugin");
  assert.ok(plugin, "sample-plugin should have activated");

  const stats = mgr.stats();
  const entry = stats.loaded.find((p) => p.id === "sample-plugin");
  assert.deepEqual(entry.tools, [
    "plugin__sample-plugin__guarded",
    "plugin__sample-plugin__remember",
  ]);
  assert.deepEqual(entry.commands, ["sample"]);
  // Context providers are namespaced alongside tools, so a plugin's "notes"
  // block can never shadow another plugin's.
  assert.deepEqual(entry.contexts, ["plugin__sample-plugin__notes"]);
  assert.ok(entry.hooks.includes("beforeAgentRun"));
  assert.ok(entry.hooks.includes("beforeToolExecute"));

  // The fixture's log ring is the real API (log.info, not a callable log).
  // A wrong call here would be swallowed by hook isolation, so assert it.
  await mgr.runAfterAgentRun({ agentId: "planner", completed: true, state: "completed" });
  const logLines = plugin.log.lines.map((l) => l.message).join("\n");
  assert.match(logLines, /saw a run finish/);
  assert.ok(
    plugin.log.lines.every((l) => l.level !== "error"),
    "the reference fixture must not log errors"
  );
});

test("a plugin that throws at activation is recorded, not propagated", async (t) => {
  const root = stage(t, ["sample-plugin", "broken-plugin"]);
  const mgr = await managerFor(t, root);

  assert.equal(mgr.loaded.has("broken-plugin"), false);
  assert.ok(
    mgr.loaded.has("sample-plugin"),
    "one broken plugin must not cost the session the plugins that work"
  );

  const problem = mgr.stats().problems.find((p) => p.id === "broken-plugin");
  assert.ok(problem, "the failure is reported rather than swallowed");
  assert.match(problem.lines.join("\n"), /refuses to activate/);
});

test("the ESM fixture loads through the trusted import path", async (t) => {
  const root = stage(t, ["esm-plugin"]);
  const mgr = await managerFor(t, root);

  const plugin = mgr.loaded.get("esm-plugin");
  assert.ok(plugin, "esm-plugin should have activated");
  assert.equal(plugin.format, "esm");

  const entry = mgr.stats().loaded.find((p) => p.id === "esm-plugin");
  assert.deepEqual(entry.tools, ["plugin__esm-plugin__ping"]);
});

// --- CLI surface -------------------------------------------------------------

test("plugin list reports what each fixture adds, and surfaces the broken one", async (t) => {
  const root = stage(t, ["sample-plugin", "broken-plugin"]);
  const result = await dispatchPlugin(root, ["list"]);

  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /sample-plugin/);
  assert.match(result.text, /broken-plugin/);
  assert.match(result.text, /2 tool\(s\)/, "the adds column counts real registrations");
  assert.match(result.text, /not loaded/);
  assert.match(result.text, /refuses to activate/, "a failing plugin shows its diagnostic");
});

test("plugin inspect loads the plugin and shows its real registrations", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const result = await dispatchPlugin(root, ["inspect", "sample-plugin"]);

  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /plugin__sample-plugin__remember/);
  assert.match(result.text, /\/sample/);
  assert.match(result.text, /notes/);
  assert.match(result.text, /beforeToolExecute/);
  assert.match(result.text, /permissions:.*tools/s);
});

test("plugin inspect on a broken plugin is not ok and names the cause", async (t) => {
  const root = stage(t, ["broken-plugin"]);
  const result = await dispatchPlugin(root, ["inspect", "broken-plugin"]);

  assert.equal(result.ok, false);
  assert.match(result.text, /failed to activate|refuses to activate/);
});

test("inspect and list on an unknown id name the known plugins", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const result = await dispatchPlugin(root, ["inspect", "nope"]);

  assert.equal(result.ok, false);
  assert.match(result.text, /no plugin named nope/);
  assert.match(result.text, /sample-plugin/, "the error lists what is actually installed");
});

test("enable and disable go through the CLI and change reported status", async (t) => {
  const root = stage(t, ["sample-plugin"]);

  const off = await dispatchPlugin(root, ["disable", "sample-plugin"]);
  assert.equal(off.ok, true);
  assert.equal(off.data.enabled, false);

  const listed = await dispatchPlugin(root, ["list"]);
  assert.match(listed.text, /disabled/);
  assert.match(listed.text, /\(not loaded\)/, "a disabled plugin is not executed");

  const on = await dispatchPlugin(root, ["enable", "sample-plugin"]);
  assert.equal(on.ok, true);
  assert.equal(on.data.enabled, true);
});

test("disable of an unknown id fails with the known set", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const result = await dispatchPlugin(root, ["disable", "ghost"]);

  assert.equal(result.ok, false);
  assert.match(result.text, /no plugin named ghost/);
});

test("plugin create scaffolds a plugin that discovery then accepts", async (t) => {
  const root = stage(t, []);
  const created = await dispatchPlugin(root, ["create", "newbie"]);

  assert.equal(created.ok, true, created.text);
  const dir = path.join(root, ".agentflow", "plugins", "newbie");
  assert.ok(fs.existsSync(path.join(dir, MANIFEST_FILE)));
  assert.ok(fs.existsSync(path.join(dir, "index.js")));

  // The scaffold must be valid, not merely present: a template that fails
  // validation on first run is a trap.
  const { plugins } = discoverPlugins({ workspaceRoot: root, currentVersion: VERSION });
  const spec = plugins.find((p) => p.id === "newbie");
  assert.ok(spec, "the scaffolded manifest parses");
  assert.equal(spec.status, "enabled");
  assert.deepEqual(spec.errors, []);

  // And it must actually load and register a working tool.
  const mgr = await managerFor(t, root);
  const entry = mgr.stats().loaded.find((p) => p.id === "newbie");
  assert.deepEqual(entry.tools, ["plugin__newbie__echo"]);
});

test("plugin create refuses to clobber an existing directory", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const result = await dispatchPlugin(root, ["create", "sample-plugin"]);

  assert.equal(result.ok, false);
  assert.match(result.text, /already exists/);
});

test("an unknown subcommand is rejected without touching the workspace", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const result = await dispatchPlugin(root, ["explode"]);

  assert.equal(result.ok, false);
  assert.match(result.text, /unknown plugin subcommand/);
  assert.equal(
    fs.existsSync(path.join(root, ".agentflow", "plugins.json")),
    false,
    "a usage error must not write plugin state"
  );
});

// --- runtime -----------------------------------------------------------------

test("a staged plugin enriches a real run and its tool reaches the transcript", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const mgr = await managerFor(t, root);

  const prompts = [];
  const systems = [];
  let n = 0;
  const complete = async (_c, modelId, prompt, opts = {}) => {
    prompts.push(prompt);
    systems.push(opts.system ?? "");
    n += 1;
    const out = n === 1
      ? toolCallJson({ toolCalls: [{ tool: "plugin__sample-plugin__remember", args: { note: "milk" } }] })
      : "done";
    return { model: modelId, text: out };
  };

  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({
        id: "planner",
        purpose: "p",
        instructions: "i",
        tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] },
      }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  mgr.registerToolsInto(rt);

  const result = await rt.run({ agentId: "planner", task: "remember the milk" });
  assert.equal(result.completed, true, `${result.state}: ${result.error?.message ?? ""}`);

  const joined = prompts.concat(systems).join("\n");
  assert.match(joined, /SAMPLE-PLUGIN-EXTRA/, "beforeAgentRun enrichment reaches the context packet");
  assert.match(joined, /SAMPLE-PLUGIN-CONTEXT/, "the registered context block reaches the packet too");
  assert.match(joined, /SAMPLE-PLUGIN-NOTE:milk/, "the plugin tool's output reaches the model");
});

test("a staged plugin can veto a run outright", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const mgr = await managerFor(t, root);

  const calls = [];
  const complete = async (_c, modelId) => {
    calls.push(1);
    return { model: modelId, text: "done" };
  };

  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({ id: "planner", purpose: "p", instructions: "i", tools: { scopes: [TOOL_SCOPE.READ] } }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });

  const result = await rt.run({ agentId: "planner", task: "SKIP-SAMPLE this one" });
  assert.equal(result.completed, false);
  assert.equal(calls.length, 0, "a vetoed run must never reach the model");
  assert.match(result.error?.message ?? "", /declined/);
});

test("a staged plugin can veto one of its own tools by name", async (t) => {
  const root = stage(t, ["sample-plugin"]);
  const mgr = await managerFor(t, root);

  const complete = async (_c, modelId, prompt) => {
    // Ask for the guarded tool on the first turn, then stop.
    return prompt.includes("plugin__sample-plugin__guarded")
      ? { model: modelId, text: "done" }
      : { model: modelId, text: toolCallJson({ toolCalls: [{ tool: "plugin__sample-plugin__guarded", args: {} }] }) };
  };

  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({
        id: "planner",
        purpose: "p",
        instructions: "i",
        tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] },
      }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  mgr.registerToolsInto(rt);

  const result = await rt.run({ agentId: "planner", task: "use the guarded tool" });
  assert.equal(result.state, "failed");
  assert.equal(result.error.code, "plugin_denied", "a plugin refusal is a distinct denial");
  assert.match(result.error.message, /guards that tool/);
});

test("a broken fixture leaves a runtime fully functional", async (t) => {
  const root = stage(t, ["broken-plugin", "sample-plugin"]);
  const mgr = await managerFor(t, root);

  const complete = async (_c, modelId) => ({ model: modelId, text: "done" });
  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({ id: "planner", purpose: "p", instructions: "i", tools: { scopes: [TOOL_SCOPE.READ] } }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });

  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.completed, true, `${result.state}: ${result.error?.message ?? ""}`);
});

// --- chat provider dispatch --------------------------------------------------
//
// Regression: the chat engine installed the dispatch wrapper by reading
// `.stream`, but the wrapper exposes `streamComplete`. The assignment produced
// `undefined` without throwing, so nothing failed until a user tried to stream
// a reply with any plugin provider installed.

test("registering a plugin provider leaves chat streaming intact", async (t) => {
  const root = stage(t, ["provider-plugin"]);
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-fixture-ses-"));

  const calls = [];
  const builtinStream = async (_cfg, modelId, messages, opts = {}) => {
    calls.push(modelId);
    opts.onToken?.("builtin");
    return { model: modelId, text: "builtin", streamed: true };
  };

  const chat = new ChatSession({
    sessions: new SessionStore({ dir: sessionDir }),
    config: {},
    modelId: "a/one",
    stream: builtinStream,
    workspaceRoot: root,
  });
  await chat.init({ forceNew: true });

  assert.ok(chat.pluginManager, "the plugin manager should have initialised");
  assert.ok(
    chat.pluginManager.providers.size > 0,
    "the provider fixture must actually be registered, or this proves nothing"
  );
  assert.equal(typeof chat.stream, "function", "streaming must survive provider registration");

  // Builtin models keep their original route.
  const builtin = await chat.stream({}, "a/one", [{ role: "user", content: "hi" }], {});
  assert.equal(builtin.text, "builtin");
  assert.deepEqual(calls, ["a/one"], "the builtin stream is called, unchanged");

  // The plugin model reaches the plugin's own streaming implementation.
  const tokens = [];
  const plugin = await chat.stream({}, "plugin__provider-plugin__local/llama3", [{ role: "user", content: "hi" }], {
    onToken: (c) => tokens.push(c),
  });
  assert.equal(plugin.text, "FROM-PLUGIN-PROVIDER");
  assert.equal(tokens.join(""), "FROM-PLUGIN-PROVIDER", "plugin tokens flow through onToken");
  assert.deepEqual(calls, ["a/one"], "the builtin stream is not used for a plugin model");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});
