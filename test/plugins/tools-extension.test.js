// Unit tests for the plugin tool extension point: validation, namespacing,
// collision refusal, per-plugin caps, lookup and removal.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PluginToolRegistry,
  validateToolSchema,
  MAX_TOOLS_PER_PLUGIN,
} from "../../src/core/plugins/tools-extension.js";

const goodDef = {
  name: "echo",
  description: "Echo the input back",
  schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args) => args.text ?? "",
};

test("registerTool validates definition fields", () => {
  const reg = new PluginToolRegistry();
  const pid = "tools";
  assert.match(reg.register(pid, null).error, /must be an object/);
  assert.match(reg.register(pid, { ...goodDef, name: "" }).error, /name must match/);
  assert.match(reg.register(pid, { ...goodDef, name: "has space" }).error, /name must match/);
  assert.match(reg.register(pid, { ...goodDef, description: "" }).error, /description is required/);
  assert.match(reg.register(pid, /** @type {any} */ ({ ...goodDef, execute: "nope" })).error, /execute must be a function/);
  assert.equal(reg.size, 0, "nothing registered after all the refusals");
});

test("successful registration namespaces the tool and keeps the execute", () => {
  const reg = new PluginToolRegistry();
  const res = reg.register("tools", goodDef);
  assert.equal(res.ok, true);
  assert.equal(res.fullName, "plugin__tools__echo");
  const entry = reg.get("plugin__tools__echo");
  assert.equal(entry.pluginId, "tools");
  assert.equal(typeof entry.def.execute, "function");
  assert.equal(entry.def.name, "plugin__tools__echo");
});

test("duplicate namespaced registration is refused, not overwritten", () => {
  const reg = new PluginToolRegistry();
  assert.equal(reg.register("a", goodDef).ok, true);
  const dupe = reg.register("a", goodDef);
  assert.equal(dupe.ok, false);
  assert.match(dupe.error, /already registered/);

  // Two plugins may legitimately own differently-named tools with the same
  // local name: namespacing keeps both.
  assert.equal(reg.register("b", goodDef).ok, true);
});

test("schema validation catches malformed JSON Schema shapes", () => {
  const reg = new PluginToolRegistry();
  const bad = reg.register("s", { ...goodDef, schema: { properties: ["a"] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /properties: must be a JSON object/);

  const bad2 = reg.register("s", { ...goodDef, schema: { required: 3 } });
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /required: must be an array/);
});

test("validateToolSchema checks nested objects and depth bounds", () => {
  const nested = { type: "object", properties: { a: { type: "object", properties: { b: { type: "string" } } } } };
  assert.deepEqual(validateToolSchema(nested), []);

  let deep = { type: "object", properties: {} };
  let cursor = deep;
  for (let i = 0; i < 12; i++) {
    const next = { type: "object", properties: { inner: cursor } };
    cursor = next;
  }
  const errs = validateToolSchema(cursor);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /8 levels/);
});

test("missing schema defaults to a permissive object schema", () => {
  const reg = new PluginToolRegistry();
  const res = reg.register("q", { name: "x", description: "d", execute() {} });
  assert.equal(res.ok, true);
  assert.deepEqual(reg.get("plugin__q__x").def.schema, { type: "object" });
});

test("per-plugin tool cap prevents runaway registrations", () => {
  const reg = new PluginToolRegistry();
  for (let i = 0; i < MAX_TOOLS_PER_PLUGIN; i++) {
    assert.equal(
      reg.register("many", { name: `t${i}`, description: "d", execute() {} }).ok,
      true
    );
  }
  const over = reg.register("many", { name: "overflow", description: "d", execute() {} });
  assert.equal(over.ok, false);
  assert.match(over.error, /-tool cap/);
  // A different plugin is unaffected by another plugin's cap.
  assert.equal(reg.register("other", { name: "fine", description: "d", execute() {} }).ok, true);
});

test("forPlugin and entries give deterministic, sorted listings", () => {
  const reg = new PluginToolRegistry();
  reg.register("z", { name: "m", description: "d", execute() {} });
  reg.register("z", { name: "a", description: "d", execute() {} });
  reg.register("a", { name: "x", description: "d", execute() {} });
  assert.deepEqual(reg.forPlugin("z").map((e) => e.fullName), ["plugin__z__a", "plugin__z__m"]);
  assert.deepEqual(
    reg.entries().map((e) => e.fullName),
    ["plugin__a__x", "plugin__z__a", "plugin__z__m"]
  );
  assert.equal(reg.size, 3);
});

test("removePlugin clears every tool that plugin owned and returns the count", () => {
  const reg = new PluginToolRegistry();
  reg.register("gone", { name: "one", description: "d", execute() {} });
  reg.register("gone", { name: "two", description: "d", execute() {} });
  reg.register("stay", { name: "keep", description: "d", execute() {} });
  assert.equal(reg.removePlugin("gone"), 2);
  assert.equal(reg.get("plugin__gone__one"), undefined);
  assert.equal(reg.size, 1);
  assert.deepEqual(reg.forPlugin("gone"), []);
  assert.equal(reg.removePlugin("gone"), 0);
});
