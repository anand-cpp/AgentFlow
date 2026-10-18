// Unit tests for the plugin provider extension point: definition validation,
// namespaced provider ids and model ids, registration caps, dispatch through
// the wrapper for plugin routes and pass-through for builtin ones, timeout,
// and stream path behaviour.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PluginProviderRegistry,
  installPluginProviderDispatch,
  pluginProviderId,
  isPluginProvider,
  validateProviderDef,
  MAX_PROVIDERS_PER_PLUGIN,
} from "../../src/core/plugins/providers-extension.js";

const goodDef = {
  id: "localllm",
  name: "Local LLM",
  models: ["llama3", "mistral"],
  complete: async () => ({ text: "hi from local" }),
};

test("validateProviderDef catches every malformed definition", () => {
  const errs1 = validateProviderDef(null);
  assert.equal(errs1.length, 1);
  assert.match(errs1[0], /must be an object/);

  const errs2 = validateProviderDef({ ...goodDef, id: "bad id" });
  assert.equal(errs2.length, 1);
  assert.match(errs2[0], /id must match/);

  assert.match(validateProviderDef({ ...goodDef, models: [] })[0], /non-empty array/);
  assert.match(validateProviderDef({ ...goodDef, models: ["bad model!!"] })[0], /model name/);

  assert.match(validateProviderDef({ ...goodDef, complete: null })[0], /complete must be a function/);
  assert.equal(validateProviderDef(goodDef).length, 0);
});

test("registration namespaces provider and model ids", () => {
  const reg = new PluginProviderRegistry();
  const res = reg.register("localplug", goodDef);
  assert.equal(res.ok, true);
  assert.equal(res.providerId, "plugin__localplug__localllm");
  assert.deepEqual(reg.modelIds(), [
    "plugin__localplug__localllm/llama3",
    "plugin__localplug__localllm/mistral",
  ]);
});

test("plugin providers cannot shadow builtins or re-register", () => {
  const reg = new PluginProviderRegistry();
  assert.equal(reg.register("p", goodDef).ok, true);
  const dupe = reg.register("p", goodDef);
  assert.equal(dupe.ok, false);
  assert.match(dupe.error, /already registered/);

  // Namespacing means a plugin id like "anthropic" cannot collide with the
  // real anthropic provider: it becomes plugin__<plugin>__anthropic.
  assert.equal(reg.register("ownplug", { ...goodDef, id: "anthropic" }).ok, true);
  assert.ok(isPluginProvider("plugin__ownplug__anthropic"));
  assert.equal(isPluginProvider("anthropic"), false);
  assert.equal(pluginProviderId("a", "b"), "plugin__a__b");
});

test("provider registration cap per plugin", () => {
  const reg = new PluginProviderRegistry();
  for (let i = 0; i < MAX_PROVIDERS_PER_PLUGIN; i++) {
    assert.equal(reg.register("many", { ...goodDef, id: `p${i}` }).ok, true);
  }
  const over = reg.register("many", { ...goodDef, id: "overflow" });
  assert.equal(over.ok, false);
  assert.match(over.error, /-provider cap/);
});

test("dispatch routes plugin model ids to the plugin complete", async () => {
  const reg = new PluginProviderRegistry();
  reg.register("p", { ...goodDef, complete: async () => ({ text: " answer ", finishReason: "done" }) });
  const base = {
    complete: async () => {
      throw new Error("base must not be called");
    },
    streamComplete: async () => {
      throw new Error("base stream must not be called");
    },
  };
  const wrapped = installPluginProviderDispatch({ base, registry: reg });
  const res = await wrapped.complete({}, "plugin__p__localllm/llama3", "hello", {});
  assert.equal(res.text, "answer", "text is trimmed like gateway.complete");
  assert.equal(res.model, "plugin__p__localllm/llama3");
  assert.equal(res.finishReason, "done");
  assert.equal(res.provider, "plugin__p__localllm");
});

test("dispatch passes builtin providers through untouched", async () => {
  const reg = new PluginProviderRegistry();
  reg.register("p", goodDef);
  let baseCalls = 0;
  const base = {
    complete: async () => {
      baseCalls += 1;
      return { text: "builtin", model: "gpt-4o", raw: {}, finishReason: "stop", usage: null };
    },
    streamComplete: async () => "builtin stream",
  };
  const wrapped = installPluginProviderDispatch({ base, registry: reg });
  const res = await wrapped.complete({}, "gpt-4o", "hi", {});
  assert.equal(res.text, "builtin");
  assert.equal(baseCalls, 1);
  assert.equal(await wrapped.streamComplete({}, "gpt-4o", [{ role: "user", content: "hi" }]), "builtin stream");
});

test("dispatch wires the {system, messages} contract and stream emits once", async () => {
  const reg = new PluginProviderRegistry();
  /** @type {any} Assigned inside the provider callback, so annotate it. */
  let seen;
  reg.register("p", {
    ...goodDef,
    complete: async (modelId, wire) => {
      seen = wire;
      return { text: "one shot" };
    },
  });
  const base = { complete: async () => { throw new Error("no"); }, streamComplete: async () => { throw new Error("no"); } };
  const wrapped = installPluginProviderDispatch({ base, registry: reg });
  const tokens = [];
  const res = await wrapped.streamComplete({}, "plugin__p__localllm/mistral", [
    { role: "system", content: "be brief" },
    { role: "user", content: "question" },
  ], { onToken: (t) => tokens.push(t) });
  assert.deepEqual(seen.system, "be brief");
  assert.deepEqual(seen.messages, [{ role: "user", content: "question" }]);
  assert.deepEqual(tokens, ["one shot"]);
  // The stream path returns the gateway completion shape, because that is the
  // contract the chat engine reads (`.text`). Returning the bare string made
  // plugin-provider replies come back empty even though the tokens were right.
  assert.equal(res.text, "one shot");
  assert.equal(res.model, "plugin__p__localllm/mistral");
  assert.equal(res.streamed, true);
});

test("plugin provider failure is wrapped with the plugin prefix and code", async () => {
  const reg = new PluginProviderRegistry();
  reg.register("p", {
    ...goodDef,
    complete: async () => {
      const e = new Error("429 too many requests");
      throw e;
    },
  });
  const base = { complete: async () => { throw new Error("no"); }, streamComplete: async () => "x" };
  const wrapped = installPluginProviderDispatch({ base, registry: reg });
  await assert.rejects(
    () => wrapped.complete({}, "plugin__p__localllm/llama3", "hi", {}),
    /plugin provider plugin__p__localllm: 429/
  );
});

test("plugin provider timeout abandons slow completions", async () => {
  const reg = new PluginProviderRegistry({ timeoutMs: 40 });
  reg.register("p", { ...goodDef, complete: () => new Promise(() => {}) });
  const base = { complete: async () => "x", streamComplete: async () => "x" };
  const wrapped = installPluginProviderDispatch({ base, registry: reg });
  await assert.rejects(() => wrapped.complete({}, "plugin__p__localllm/llama3", "hi", {}), /timed out/);
});

test("registry removePlugin and lookup helpers", () => {
  const reg = new PluginProviderRegistry();
  reg.register("a", goodDef);
  assert.equal(reg.has("plugin__a__localllm"), true);
  assert.equal(reg.removePlugin("a"), 1);
  assert.equal(reg.has("plugin__a__localllm"), false);
  assert.equal(reg.removePlugin("a"), 0);
  assert.deepEqual(reg.byPluginProviders("ghost"), []);
  assert.equal(reg.size, 0);
});
