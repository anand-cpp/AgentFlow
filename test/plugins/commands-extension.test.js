// Unit tests for the plugin slash-command extension point: registration
// validation, builtin-name protection, caps, listing, and fail-isolated
// execution with timeout.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PluginCommandRegistry,
  runPluginCommand,
  validateCommandDef,
  MAX_COMMANDS_PER_PLUGIN,
} from "../../src/core/plugins/commands-extension.js";

const BUILTINS = ["help", "quit", "model", "session", "sessions", "new", "mcp", "map", "git", "lsp", "tribunal"];
const goodDef = { name: "todos", description: "List todos", handler: (arg) => `todos: ${arg}` };

test("validateCommandDef catches malformed definitions and collisions", () => {
  const taken = new Set(["map"]);
  assert.match(validateCommandDef(null, taken)[0], /must be an object/);
  assert.match(validateCommandDef({ ...goodDef, name: "takes args" }, taken)[0], /name must match/);
  assert.match(validateCommandDef({ ...goodDef, name: "map" }, taken)[0], /already taken/);
  assert.match(validateCommandDef({ ...goodDef, description: "" }, taken)[0], /description is required/);
  assert.match(validateCommandDef({ ...goodDef, handler: null }, taken)[0], /handler must be a function/);
  assert.deepEqual(validateCommandDef(goodDef, taken), []);
});

test("register and dispatch a plugin command end to end", async () => {
  const reg = new PluginCommandRegistry();
  assert.equal(reg.register("plug", goodDef, { builtinNames: BUILTINS }).ok, true);
  assert.equal(reg.has("todos"), true);
  assert.equal(reg.has("TODOS"), true, "name lookup lowercases");

  const res = await runPluginCommand(reg, "todos", "today", { fake: "session" });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "plugin");
  assert.equal(res.text, "todos: today");
  assert.equal(res.data, undefined);
});

test("builtin names are protected from takeover", () => {
  const reg = new PluginCommandRegistry();
  const res = reg.register("plug", { name: "quit", description: "evil", handler() {} }, { builtinNames: BUILTINS });
  assert.equal(res.ok, false);
  assert.match(res.error, /already taken/);
  assert.equal(reg.size, 0);
});

test("registration order decides collisions between plugins", () => {
  const reg = new PluginCommandRegistry();
  assert.equal(reg.register("first", goodDef).ok, true);
  const second = reg.register("second", goodDef);
  assert.equal(second.ok, false);
  assert.match(second.error, /registered earlier/);
  // The winner stays the first plugin.
  assert.equal(reg.get("todos").pluginId, "first");
});

test("command cap per plugin", () => {
  const reg = new PluginCommandRegistry();
  for (let i = 0; i < MAX_COMMANDS_PER_PLUGIN; i++) {
    assert.equal(
      reg.register("c", { ...goodDef, name: `cmd${i}` }).ok,
      true
    );
  }
  const over = reg.register("c", { ...goodDef, name: "over" });
  assert.equal(over.ok, false);
  assert.match(over.error, /-command cap/);
  assert.equal(reg.register("other", goodDef).ok, true, "other plugins unaffected");
});

test("unknown plugin command renders a clean message", async () => {
  const reg = new PluginCommandRegistry();
  const res = await runPluginCommand(reg, "dne", "", null);
  assert.equal(res.ok, false);
  assert.equal(res.text, "unknown command: /dne");
});

test("handler result shapes: string, {text}, {text, data}, numbers", async () => {
  const reg = new PluginCommandRegistry();
  reg.register("p", { name: "s", description: "d", handler: () => "plain" });
  reg.register("p", {
    name: "rich",
    description: "d",
    handler: () => ({ text: "rich text", data: { nested: true } }),
  });
  reg.register("p", { name: "n", description: "d", handler: () => 42 });
  reg.register("p", { name: "u", description: "d", handler: () => undefined });

  assert.equal((await runPluginCommand(reg, "s", "", null)).text, "plain");
  const rich = await runPluginCommand(reg, "rich", "", null);
  assert.equal(rich.text, "rich text");
  assert.deepEqual(rich.data, { nested: true });
  assert.equal((await runPluginCommand(reg, "n", "", null)).text, "42");
  assert.equal((await runPluginCommand(reg, "u", "", null)).text, "");
});

test("throwing and timing-out handlers never crash the caller", async () => {
  const reg = new PluginCommandRegistry({ timeoutMs: 40 });
  reg.register("p", {
    name: "throwy",
    description: "d",
    handler: () => {
      throw new Error("kaboom");
    },
  });
  reg.register("p", { name: "hangy", description: "d", handler: () => new Promise(() => {}) });
  reg.register("p", { name: "ok", description: "d", handler: () => "still alive" });

  const threw = await runPluginCommand(reg, "throwy", "", null);
  assert.equal(threw.ok, false);
  assert.match(threw.text, /\/throwy: kaboom/);

  const hung = await runPluginCommand(reg, "hangy", "", null);
  assert.equal(hung.ok, false);
  assert.match(hung.text, /timed out/);

  const ok = await runPluginCommand(reg, "ok", "", null);
  assert.equal(ok.text, "still alive");
});

test("registry listing is sorted and removal is per-plugin", () => {
  const reg = new PluginCommandRegistry();
  reg.register("b", { name: "zebra", description: "d", handler() {} });
  reg.register("a", { name: "aardvark", description: "d", handler() {} });
  const list = reg.list();
  assert.deepEqual(list.map((c) => c.name), ["aardvark", "zebra"]);
  assert.deepEqual(
    list.map((c) => c.pluginId),
    ["a", "b"]
  );

  assert.equal(reg.removePlugin("b"), 1);
  assert.equal(reg.has("zebra"), false);
  assert.equal(reg.removePlugin("b"), 0);
  assert.deepEqual(reg.commandsForPlugin("ghost"), []);
});
