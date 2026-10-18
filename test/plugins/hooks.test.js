// Unit tests for the plugin hook registry: subscription validation, serial
// execution order, error isolation between subscribers, timeouts, and
// per-plugin removal on unload.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PluginHookRegistry,
  UnknownHookError,
  HOOK_NAMES,
  DEFAULT_HOOK_TIMEOUT_MS,
} from "../../src/core/plugins/hooks.js";

test("all six lifecycle hooks are documented and supported", () => {
  assert.deepEqual(HOOK_NAMES, [
    "onInit",
    "beforeAgentRun",
    "afterAgentRun",
    "beforeToolExecute",
    "afterToolExecute",
    "onShutdown",
  ]);
  assert.ok(DEFAULT_HOOK_TIMEOUT_MS >= 1000);
});

test("add validates hook names and subscriber types", () => {
  const reg = new PluginHookRegistry();
  assert.equal(reg.add("p", "bogus", () => {}).ok, false);
  assert.match(reg.add("p", "bogus", () => {}).error, /unknown hook/);
  assert.equal(reg.add("p", "onInit", /** @type {any} */ ("notafunction")).ok, false);
  assert.equal(reg.add("p", "onInit", () => {}).ok, true);
  assert.equal(reg.count("onInit"), 1);
});

test("invoke runs subscribers serially in registration order", async () => {
  const reg = new PluginHookRegistry();
  const order = [];
  reg.add("a", "afterAgentRun", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a-end");
  });
  reg.add("b", "afterAgentRun", () => {
    order.push("b");
  });
  const res = await reg.invoke("afterAgentRun", {});
  assert.equal(res.ok, true);
  assert.deepEqual(order, ["a-start", "a-end", "b"], "b must not start before a finishes");
});

test("a throwing subscriber is captured and the chain continues", async () => {
  const reg = new PluginHookRegistry();
  const seen = [];
  reg.add("bad", "afterAgentRun", () => {
    throw new Error("boom");
  });
  reg.add("good", "afterAgentRun", () => {
    seen.push("good");
  });
  const res = await reg.invoke("afterAgentRun", {});
  assert.equal(res.ok, false);
  assert.deepEqual(seen, ["good"], "chain continues past the throw");
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].pluginId, "bad");
  assert.match(res.errors[0].message, /boom/);
  assert.equal(res.values.length, 0);
});

test("a rejecting async subscriber is captured the same way", async () => {
  const reg = new PluginHookRegistry();
  reg.add("rej", "beforeToolExecute", async () => Promise.reject(new Error("async boom")));
  const res = await reg.invoke("beforeToolExecute", {});
  assert.equal(res.ok, false);
  assert.match(res.errors[0].message, /async boom/);
});

test("values are collected in order; observers that return nothing are omitted", async () => {
  const reg = new PluginHookRegistry();
  reg.add("p1", "beforeAgentRun", () => ({ extra: "one" }));
  reg.add("p2", "beforeAgentRun", () => undefined);
  reg.add("p3", "beforeAgentRun", () => ({ extra: "three" }));
  const res = await reg.invoke("beforeAgentRun", {});
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.values.map((v) => `${v.pluginId}=${JSON.stringify(v.value)}`),
    ["p1={\"extra\":\"one\"}", "p3={\"extra\":\"three\"}"]
  );
});

test("hanging subscribers time out and the chain proceeds", async () => {
  const reg = new PluginHookRegistry({ timeoutMs: 40 });
  reg.add("hang", "onInit", () => new Promise(() => {}));
  reg.add("fast", "onInit", () => "ok");
  const res = await reg.invoke("onInit", {});
  assert.deepEqual(res.timedOut, ["hang"]);
  assert.deepEqual(
    res.values.map((v) => v.pluginId),
    ["fast"]
  );
  assert.equal(res.ok, true);
});

test("invoke with no subscribers is a trivially ok no-op", async () => {
  const reg = new PluginHookRegistry();
  const res = await reg.invoke("onShutdown", {});
  assert.deepEqual(res, { ok: true, values: [], errors: [], timedOut: [] });
});

test("invoke with an unknown hook name throws — it is a host bug, not plugin", async () => {
  const reg = new PluginHookRegistry();
  await assert.rejects(() => reg.invoke("dne", {}), UnknownHookError);
});

test("removePlugin drops all subscriptions for that plugin only", async () => {
  const reg = new PluginHookRegistry();
  reg.add("a", "onInit", () => {});
  reg.add("a", "onShutdown", () => {});
  reg.add("b", "onInit", () => {});
  const removed = reg.removePlugin("a");
  assert.equal(removed, 2);
  assert.equal(reg.count("onInit"), 1);
  assert.equal(reg.count("onShutdown"), 0);
  assert.deepEqual(reg.pluginIdsFor("onInit"), ["b"]);
  assert.equal(reg.removePlugin("ghost"), 0);
});

test("count() across all hooks and empty pluginsFor are safe", () => {
  const reg = new PluginHookRegistry();
  assert.equal(reg.count(), 0);
  reg.add("a", "beforeAgentRun", () => {});
  assert.equal(reg.count(), 1);
  assert.deepEqual(reg.pluginIdsFor("onShutdown"), []);
});

test("payload is passed through to every subscriber", async () => {
  const reg = new PluginHookRegistry();
  const seen = [];
  reg.add("o1", "afterToolExecute", (p) => {
    seen.push({ pluginId: "o1", ...p });
  });
  const res = await reg.invoke("afterToolExecute", { tool: "read", outcome: "ok" });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [{ pluginId: "o1", tool: "read", outcome: "ok" }]);
});
