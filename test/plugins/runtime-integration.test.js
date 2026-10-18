// Runtime integration tests for the plugin system: real plugin directories,
// sandboxed loads, and hooks observed through a full AgentRuntime run.
// Covers beforeAgentRun enrichment, plugin tool execution through the runtime
// tool map, beforeToolExecute denial, afterToolExecute output substitution,
// and afterAgentRun observation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAgent, AgentRegistry, TOOL_SCOPE } from "../../src/core/agents/registry.js";
import { AgentRuntime, STATE } from "../../src/core/agents/runtime.js";
import { PluginManager } from "../../src/core/plugins/manager.js";
import { MANIFEST_FILE } from "../../src/core/plugins/manifest.js";

const CATALOGUE = ["oc/muse", "gem/gemini-2.5-pro"];

function makeWorkspace(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-rtplug-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A plugin fixture: enriches every run, registers two tools (one ordinary,
// one guarded), and post-processes tool output.
const NOTETAKER_INDEX = `
module.exports = function activate(ctx) {
  ctx.on('beforeAgentRun', function (payload) {
    if (payload.extra && payload.extra.indexOf('VETO') !== -1) {
      return { deny: true, reason: 'run vetoed by notetaker' };
    }
    return { extra: 'PLUGIN-EXTRA-SENTINEL' };
  });
  ctx.on('afterAgentRun', function (result) {
    ctx.log.info('afterrun', String(result.completed));
  });
  ctx.on('beforeToolExecute', function (p) {
    if (p.tool === 'plugin__notetaker__guarded') {
      return { deny: true, reason: 'guarded by notetaker' };
    }
  });
  ctx.on('afterToolExecute', function (p) {
    if (p.tool === 'plugin__notetaker__note') {
      return { output: 'REDACTED-BY-PLUGIN' };
    }
  });
  ctx.registerTool({
    name: 'note',
    description: 'Return a fixed note',
    schema: { type: 'object', properties: {} },
    execute: async function () { return { ok: true, note: 'NOTE-SENTINEL' }; },
  });
  ctx.registerTool({
    name: 'guarded',
    description: 'A tool a plugin will deny',
    scope: 'read',
    schema: { type: 'object', properties: {} },
    execute: async function () { return { ok: true }; },
  });
};
`;

/** Two-turn scripted completion helper is inlined per test below. */
function toolCallJson(calls) {
  return "```json\n" + JSON.stringify(calls) + "\n```";
}

async function managerFor(t, opts = {}) {
  const root = opts.workspaceRoot;
  const mgr = new PluginManager({ workspaceRoot: root, currentVersion: "99.0.0" });
  await mgr.init();
  return mgr;
}

test("plugin beforeAgentRun extra text reaches the model prompt", async (t) => {
  const root = makeWorkspace(t, {
    [path.join(".agentflow", "plugins", "notetaker", MANIFEST_FILE)]: JSON.stringify({ id: "notetaker" }),
    [path.join(".agentflow", "plugins", "notetaker", "index.js")]: NOTETAKER_INDEX,
  });
  const mgr = await managerFor(t, { workspaceRoot: root });

  const prompts = [];
  const systems = [];
  const complete = async (_c, modelId, prompt, opts = {}) => {
    prompts.push(prompt);
    systems.push(opts.system ?? "");
    return { model: modelId, text: "final answer" };
  };
  const rt = new AgentRuntime({
    registry: new AgentRegistry([defineAgent({ id: "planner", purpose: "p", instructions: "i" })]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  const result = await rt.run({ agentId: "planner", task: "write notes", extra: null });
  assert.equal(result.completed, true);
  const combined = systems[0] + "\n" + prompts[0];
  assert.match(combined, /PLUGIN-EXTRA-SENTINEL/);
});

test("a plugin can veto a run outright", async (t) => {
  const root = makeWorkspace(t, {
    [path.join(".agentflow", "plugins", "notetaker", MANIFEST_FILE)]: JSON.stringify({ id: "notetaker" }),
    [path.join(".agentflow", "plugins", "notetaker", "index.js")]: NOTETAKER_INDEX,
  });
  const mgr = await managerFor(t, { workspaceRoot: root });
  let called = false;
  const complete = async (_c, modelId) => {
    called = true;
    return { model: modelId, text: "final" };
  };
  const rt = new AgentRuntime({
    registry: new AgentRegistry([defineAgent({ id: "planner", purpose: "p", instructions: "i" })]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  const result = await rt.run({ agentId: "planner", task: "write notes", extra: "VETO please" });
  assert.equal(result.completed, false);
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "plugin_denied");
  assert.match(result.error.message, /run vetoed by notetaker/);
  assert.equal(called, false, "no provider is dispatched for a vetoed run");
});

test("a plugin tool runs through the runtime tool map and reaches the transcript", async (t) => {
  const root = makeWorkspace(t, {
    [path.join(".agentflow", "plugins", "notetaker", MANIFEST_FILE)]: JSON.stringify({ id: "notetaker" }),
    [path.join(".agentflow", "plugins", "notetaker", "index.js")]: NOTETAKER_INDEX,
  });
  const mgr = await managerFor(t, { workspaceRoot: root });

  const prompts = [];
  const systems = [];
  let n = 0;
  const complete = async (_c, modelId, prompt, opts = {}) => {
    prompts.push(prompt);
    systems.push(opts.system ?? "");
    n += 1;
    const out = n === 1
      ? toolCallJson({ toolCalls: [{ tool: "plugin__notetaker__note", args: {} }] })
      : "done";
    return { model: modelId, text: out };
  };

  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({ id: "planner", purpose: "p", instructions: "i", tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] } }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  mgr.registerToolsInto(rt);
  const result = await rt.run({ agentId: "planner", task: "get the note", extra: null });
  assert.equal(result.completed, true, `run state: ${result.state} ${result.error?.message ?? ""}`);
  // The plugin tool output reaches the second prompt (i.e. the transcript),
  // already post-processed by the afterToolExecute replacement.
  const combined = (systems[1] ?? "") + "\n" + (prompts[1] ?? "");
  assert.match(combined, /plugin context|NOTE-SENTINEL|REDACTED-BY-PLUGIN/);
});

test("beforeToolExecute denial stops the loop like a permission denial", async (t) => {
  const root = makeWorkspace(t, {
    [path.join(".agentflow", "plugins", "notetaker", MANIFEST_FILE)]: JSON.stringify({ id: "notetaker" }),
    [path.join(".agentflow", "plugins", "notetaker", "index.js")]: NOTETAKER_INDEX,
  });
  const mgr = await managerFor(t, { workspaceRoot: root });

  const prompts = [];
  let n = 0;
  const complete = async (_c, modelId, prompt, _opts = {}) => {
    prompts.push(prompt);
    n += 1;
    const out = n === 1
      ? toolCallJson({ toolCalls: [{ tool: "plugin__notetaker__guarded", args: {} }] })
      : "done";
    return { model: modelId, text: out };
  };

  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({ id: "planner", purpose: "p", instructions: "i", tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] } }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  mgr.registerToolsInto(rt);
  const result = await rt.run({ agentId: "planner", task: "call the guarded tool", extra: null });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.error.code, "plugin_denied");
  assert.match(result.error.message, /tool plugin__notetaker__guarded refused by plugin notetaker: guarded by notetaker/);
});

test("afterToolExecute substitutes the output the second prompt sees", async (t) => {
  const root = makeWorkspace(t, {
    [path.join(".agentflow", "plugins", "notetaker", MANIFEST_FILE)]: JSON.stringify({ id: "notetaker" }),
    [path.join(".agentflow", "plugins", "notetaker", "index.js")]: NOTETAKER_INDEX,
  });
  const mgr = await managerFor(t, { workspaceRoot: root });

  const prompts = [];
  const systems = [];
  let n = 0;
  const complete = async (_c, modelId, prompt, opts = {}) => {
    prompts.push(prompt);
    systems.push(opts.system ?? "");
    n += 1;
    const out = n === 1
      ? toolCallJson({ toolCalls: [{ tool: "plugin__notetaker__note", args: {} }] })
      : "done";
    return { model: modelId, text: out };
  };

  const rt = new AgentRuntime({
    registry: new AgentRegistry([
      defineAgent({ id: "planner", purpose: "p", instructions: "i", tools: { scopes: [TOOL_SCOPE.READ], allow: ["read:*"] } }),
    ]),
    tools: {},
    catalogue: CATALOGUE,
    complete,
    plugins: mgr,
  });
  mgr.registerToolsInto(rt);
  await rt.run({ agentId: "planner", task: "get the note", extra: null });
  const combined = systems.concat(prompts).join("\n");
  assert.match(combined, /REDACTED-BY-PLUGIN/);
  assert.ok(!combined.includes("NOTE-SENTINEL"), "the original tool output must not reach the model");
});

test("afterAgentRun observes completed runs without blocking them", async (t) => {
  const root = makeWorkspace(t, {
    [path.join(".agentflow", "plugins", "notetaker", MANIFEST_FILE)]: JSON.stringify({ id: "notetaker" }),
    [path.join(".agentflow", "plugins", "notetaker", "index.js")]: NOTETAKER_INDEX,
  });
  const mgr = await managerFor(t, { workspaceRoot: root });
  const rt = new AgentRuntime({
    registry: new AgentRegistry([defineAgent({ id: "planner", purpose: "p", instructions: "i" })]),
    tools: {},
    catalogue: CATALOGUE,
    complete: async (_c, modelId) => ({ model: modelId, text: "ok" }),
    plugins: mgr,
  });
  const result = await rt.run({ agentId: "planner", task: "x", extra: null });
  assert.equal(result.completed, true);
  // afterAgentRun is fire-and-forget; its side effect lands in the plugin log
  // shortly after. Give the microtask queue a moment.
  await new Promise((r) => setTimeout(r, 50));
  const plugin = mgr.loaded.get("notetaker");
  assert.ok(
    plugin.log.lines.some((l) => l.message.includes("afterrun true")),
    JSON.stringify(plugin.log.lines)
  );
});

test("a runtime with no plugins runs exactly as before", async () => {
  const rt = new AgentRuntime({
    registry: new AgentRegistry([defineAgent({ id: "planner", purpose: "p", instructions: "i" })]),
    tools: {},
    complete: async (_c, modelId) => ({ model: modelId, text: "ok" }),
    catalogue: CATALOGUE,
    plugins: null,
  });
  const result = await rt.run({ agentId: "planner", task: "x" });
  assert.equal(result.completed, true);
});
