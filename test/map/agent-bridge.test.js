// Agent bridge tests: tool registration into the runtime tool map, warm
// caching with cooldown, context injection from chat's run path, and strict
// best-effort degradation. Fixture repos keep everything on disk-real.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RepoMapAgentBridge, createRepoMapBridge } from "../../src/core/map/agent-bridge.js";
import { buildMap } from "../../src/core/map/build.js";
import { TOOL_SCOPE } from "../../src/core/agents/registry.js";

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-bridge-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the bridge registers a READ-scope repo-map tool on a runtime", (t) => {
  const root = repo(t, { "src/a.js": "export const a = 1;\n" });
  const bridge = new RepoMapAgentBridge({ root });
  const tools = new Map();
  assert.equal(bridge.registerTools({ tools }), 1);
  const tool = tools.get("repo-map");
  assert.ok(tool);
  assert.equal(tool.scope, TOOL_SCOPE.READ);
  assert.equal(tool.name, "repo-map");
  assert.equal(typeof tool.execute, "function");
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["query", "focus", "maxTokens"]);
});

test("repo-map execute returns ranked structure and honours the query", async (t) => {
  const root = repo(t, {
    "src/util.js": "export function util() { return 1; }\n",
    "src/mid.js": 'import { util } from "./util.js";\nexport function mid() { return util(); }\n',
  });
  buildMap(root);
  const bridge = new RepoMapAgentBridge({ root });
  const tool = bridge.toolDefinition();
  const out = await tool.execute({ query: "mid" });
  assert.ok(out.text.includes("src/mid.js"), "the queried file is in the map text");
  assert.ok(out.text.includes("## Repository map"));
  const unavailable = new RepoMapAgentBridge({ root: path.join(root, "nowhere") }).toolDefinition();
  const none = await unavailable.execute({});
  assert.ok(none.text.includes("unavailable"), "a missing cache degrades to a note");
});

test("ensureWarm refreshes a stale cache and cools down repeats", async (t) => {
  const root = repo(t, { "src/a.js": "export const a = 1;\n" });
  let clock = 1_000_000;
  const bridge = new RepoMapAgentBridge({ root, now: () => clock });

  const first = await bridge.ensureWarm();
  assert.ok(first.files.length === 1, "first warm builds the cache");

  // Cooldown: a repeat inside the window does not rescan.
  fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 2;\n");
  const second = await bridge.ensureWarm();
  assert.equal(second, first, "cooldown returns the cached snapshot");

  clock += 3_000;
  const third = await bridge.ensureWarm();
  assert.ok(third.files.some((f) => f.rel === "src/b.js"), "after cooldown the new file appears");
});

test("ensureWarm never throws on an unreadable root", async () => {
  const bridge = new RepoMapAgentBridge({ root: "Z:/definitely/not/real/path" });
  const snap = await bridge.ensureWarm();
  assert.ok(snap === null || Array.isArray(snap.files), "degrades instead of throwing");
});

test("extraFor returns the budgeted section or null", (t) => {
  const root = repo(t, { "src/a.js": "export function alpha() {}\n" });
  buildMap(root);
  const bridge = new RepoMapAgentBridge({ root });
  const text = bridge.extraFor({ query: "alpha" });
  assert.ok(text.startsWith("## Repository map"));
  assert.ok(text.includes("alpha"));

  const tiny = bridge.extraFor({ maxTokens: 24 });
  assert.ok(tiny.length > 0, "even a tiny budget yields the header");

  const off = new RepoMapAgentBridge({ root, config: { mapEnabled: false } });
  assert.equal(off.extraFor({}), null, "disabled bridge injects nothing");
  assert.equal(off.registerTools({ tools: new Map() }), 1, "explicit registration stays possible");
});

test("createRepoMapBridge respects the config gate", (t) => {
  const root = repo(t, { "src/a.js": "x" });
  assert.ok(createRepoMapBridge(root, {}) instanceof RepoMapAgentBridge);
  assert.equal(createRepoMapBridge(root, { mapEnabled: false }), null, "flat key gate");
  assert.equal(createRepoMapBridge(root, { map: { enabled: false } }), null, "map.enabled gate");
  assert.equal(
    createRepoMapBridge(root, { mapEnabled: true, map: { enabled: false } }),
    null,
    "either style can veto",
  );
});

test("the injected extra renders in the agent context", async () => {
  const { buildAgentContext, renderContext } = await import("../../src/core/agents/context.js");
  const agent = { bounds: { maxContextChars: 10_000 } };
  const extra = "## Repository map\n\n- src/a.js — a";
  const ctx = buildAgentContext({ agent, task: "do a thing", extra });
  const rendered = renderContext(ctx);
  assert.ok(rendered.includes("do a thing"));
  assert.ok(rendered.includes("## Repository map"), "the map section rides in the prompt");
  // Object extras keep their old shape and never render inline.
  const objCtx = buildAgentContext({ agent, task: "x", extra: { note: 1 } });
  assert.ok(!renderContext(objCtx).includes("[object"), "object extra does not render");
});
