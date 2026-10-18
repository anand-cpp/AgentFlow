// Permission gating tests.
//
// Manifest permissions are now active registration gates: a plugin may only
// register a tool, provider, command, context provider, or hook when its
// manifest explicitly grants that domain (`true`). Everything is fail-isolated
// -- a refused registration is recorded as a per-plugin problem and never
// crashes the loader or the session.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PluginManager } from "../../src/core/plugins/manager.js";
import { VERSION } from "../../src/core/version.js";

const PLUGIN = (id, perms, entry) => ({
  [path.join(".agentflow", "plugins", id, "agentflow.plugin.json")]: JSON.stringify({
    id,
    version: "1.0.0",
    ...(perms ? { permissions: perms } : {}),
  }),
  [path.join(".agentflow", "plugins", id, "index.js")]: entry,
});

function stage(t, id, perms, entry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-perm-"));
  for (const [rel, content] of Object.entries(PLUGIN(id, perms, entry))) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content, "utf8");
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function load(t, id, perms, entry) {
  const root = stage(t, id, perms, entry);
  const mgr = new PluginManager({ workspaceRoot: root, currentVersion: VERSION });
  await mgr.init();
  return { mgr, root };
}

const ACTIVATE = (registrations) =>
  `module.exports = function activate(ctx) {\n${registrations}\n};\n`;

test("registerTool is granted when permissions.tools is true", async (t) => {
  const { mgr } = await load(t, "allowed", { tools: true }, ACTIVATE(`ctx.registerTool({
    name: "echo",
    description: "echo",
    schema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  });`));
  assert.ok(mgr.loaded.has("allowed"), "plugin should load");
  assert.deepEqual(
    mgr.tools.forPlugin("allowed").map((t) => t.fullName),
    ["plugin__allowed__echo"]
  );
});

test("registerTool is refused when permissions.tools is false", async (t) => {
  const { mgr } = await load(t, "no-tools", { tools: false }, ACTIVATE(`ctx.registerTool({
    name: "echo",
    description: "echo",
    schema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  });`));
  assert.ok(mgr.loaded.has("no-tools"), "plugin still loads despite refusal");
  assert.deepEqual(mgr.tools.forPlugin("no-tools"), []);
  assert.ok(
    mgr.problems.get("no-tools").some((l) =>
      l.includes("without manifest permission 'tools'")
    ),
    JSON.stringify(mgr.problems.get("no-tools"))
  );
});

test("registerTool is refused when tools permission is missing entirely", async (t) => {
  const { mgr } = await load(t, "no-perms", {}, ACTIVATE(`ctx.registerTool({
    name: "echo",
    description: "echo",
    schema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  });`));
  assert.deepEqual(mgr.tools.forPlugin("no-perms"), []);
  assert.ok(
    mgr.problems.get("no-perms").some((l) => l.includes("without manifest permission 'tools'")),
    JSON.stringify(mgr.problems.get("no-perms"))
  );
});

test("registerProvider is granted only with permissions.providers", async (t) => {
  const { mgr } = await load(t, "prov", { providers: true }, ACTIVATE(`ctx.registerProvider({
    id: "localllm",
    name: "Local",
    models: ["llama3"],
    complete: async () => ({ text: "hi" }),
  });`));
  assert.deepEqual(
    mgr.providers.byPluginProviders("prov").map((x) => x.providerId),
    ["plugin__prov__localllm"]
  );
});

test("registerProvider is refused without permissions.providers", async (t) => {
  const { mgr } = await load(t, "no-prov", { tools: true }, ACTIVATE(`ctx.registerProvider({
    id: "localllm",
    name: "Local",
    models: ["llama3"],
    complete: async () => ({ text: "hi" }),
  });`));
  assert.deepEqual(mgr.providers.byPluginProviders("no-prov"), []);
  assert.ok(
    mgr.problems.get("no-prov").some((l) => l.includes("without manifest permission 'providers'")),
    JSON.stringify(mgr.problems.get("no-prov"))
  );
});

test("registerSlashCommand is granted only with permissions.commands", async (t) => {
  const { mgr } = await load(t, "cmds", { commands: true }, ACTIVATE(`ctx.registerSlashCommand({
    name: "hi",
    description: "say hi",
    handler: async () => "hi",
  });`));
  assert.deepEqual(
    (mgr.commands.commandsForPlugin("cmds") ?? []).map((c) => c.def.name),
    ["hi"]
  );
});

test("registerSlashCommand is refused without permissions.commands", async (t) => {
  const { mgr } = await load(t, "no-cmds", { tools: true }, ACTIVATE(`ctx.registerSlashCommand({
    name: "hi",
    description: "say hi",
    handler: async () => "hi",
  });`));
  assert.deepEqual((mgr.commands.commandsForPlugin("no-cmds") ?? []), []);
  assert.ok(
    mgr.problems.get("no-cmds").some((l) => l.includes("without manifest permission 'commands'")),
    JSON.stringify(mgr.problems.get("no-cmds"))
  );
});

test("registerContextProvider is granted only with permissions.context", async (t) => {
  const { mgr } = await load(t, "ctxs", { context: true }, ACTIVATE(`ctx.registerContextProvider({
    name: "notes",
    description: "notes",
    getContext: async () => "notes",
  });`));
  assert.deepEqual(
    mgr.contexts.providersForPlugin("ctxs").map((c) => c.def.name),
    ["plugin__ctxs__notes"]
  );
});

test("registerContextProvider is refused without permissions.context", async (t) => {
  const { mgr } = await load(t, "no-ctx", { tools: true }, ACTIVATE(`ctx.registerContextProvider({
    name: "notes",
    description: "notes",
    getContext: async () => "notes",
  });`));
  assert.deepEqual(mgr.contexts.providersForPlugin("no-ctx"), []);
  assert.ok(
    mgr.problems.get("no-ctx").some((l) => l.includes("without manifest permission 'context'")),
    JSON.stringify(mgr.problems.get("no-ctx"))
  );
});

test("ctx.on hooks are granted only with permissions.hooks", async (t) => {
  const { mgr } = await load(t, "hooks", { hooks: true }, ACTIVATE(`ctx.on("beforeAgentRun", () => ({ extra: "x" }));`));
  assert.ok(mgr.loaded.has("hooks"));
  assert.deepEqual(mgr.hooks.hookNamesFor("hooks"), ["beforeAgentRun"]);
});

test("ctx.on hooks are refused without permissions.hooks", async (t) => {
  const { mgr } = await load(t, "no-hooks", { tools: true }, ACTIVATE(`ctx.on("beforeAgentRun", () => ({ extra: "x" }));`));
  assert.deepEqual(mgr.hooks.hookNamesFor("no-hooks"), []);
  assert.ok(
    mgr.problems.get("no-hooks").some((l) => l.includes("without manifest permission 'hooks'")),
    JSON.stringify(mgr.problems.get("no-hooks"))
  );
});

test("one granted domain does not imply another", async (t) => {
  // tools granted, providers not: tool registers, provider refused.
  const { mgr } = await load(t, "split", { tools: true }, ACTIVATE(`
    ctx.registerTool({
      name: "echo",
      description: "echo",
      schema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    ctx.registerProvider({
      id: "localllm",
      name: "Local",
      models: ["llama3"],
      complete: async () => ({ text: "hi" }),
    });
  `));
  assert.deepEqual(
    mgr.tools.forPlugin("split").map((t) => t.fullName),
    ["plugin__split__echo"]
  );
  assert.deepEqual(mgr.providers.byPluginProviders("split"), []);
  assert.ok(
    mgr.problems.get("split").some((l) => l.includes("without manifest permission 'providers'")),
    JSON.stringify(mgr.problems.get("split"))
  );
});

test("a plugin that declares every domain registers everything", async (t) => {
  const { mgr } = await load(t, "all", {
    tools: true,
    providers: true,
    hooks: true,
    commands: true,
    context: true,
  }, ACTIVATE(`
    ctx.registerTool({
      name: "echo",
      description: "echo",
      schema: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    });
    ctx.registerProvider({
      id: "localllm",
      name: "Local",
      models: ["llama3"],
      complete: async () => ({ text: "hi" }),
    });
    ctx.registerSlashCommand({
      name: "hi",
      description: "say hi",
      handler: async () => "hi",
    });
    ctx.registerContextProvider({
      name: "notes",
      description: "notes",
      getContext: async () => "notes",
    });
    ctx.on("beforeAgentRun", () => ({ extra: "x" }));
  `));
  assert.deepEqual(mgr.tools.forPlugin("all").map((t) => t.fullName), ["plugin__all__echo"]);
  assert.deepEqual(mgr.providers.byPluginProviders("all").map((x) => x.providerId), ["plugin__all__localllm"]);
  assert.deepEqual((mgr.commands.commandsForPlugin("all") ?? []).map((c) => c.def.name), ["hi"]);
  assert.deepEqual(mgr.contexts.providersForPlugin("all").map((c) => c.def.name), ["plugin__all__notes"]);
  assert.deepEqual(mgr.hooks.hookNamesFor("all"), ["beforeAgentRun"]);
  assert.ok(!mgr.problems.has("all"), "no refusals recorded when all permissions granted");
});
