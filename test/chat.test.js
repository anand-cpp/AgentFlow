// Interactive chat tests.
//
// Two layers are covered deliberately:
//
//   * ChatSession (src/core/chat.js) -- the engine, driven directly with a mock
//     stream and a real SessionStore on a scratch directory. This is where
//     streaming, persistence, failover and the slash commands are proven.
//
//   * the `aflow chat` command (src/commands/chat.js) -- the readline loop,
//     driven by a piped Readable and a captured Writable. This is where
//     "does `printf ... | aflow chat` actually work" is proven, because the
//     line-delivery bug this guards against (dropping a fast second line) only
//     exists at the loop layer.
//
// No test reaches the network: every stream is injected.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { ChatSession, parseSlash, canonicalCommand, SLASH_HELP } from "../src/core/chat.js";
import { SessionStore } from "../src/core/sessions.js";
import { UsageLedger } from "../src/core/usage-ledger.js";
import { chatCommand } from "../src/commands/chat.js";

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A completion stream that emits `reply` character by character, then resolves. */
function mockStream(reply = "ok") {
  const calls = [];
  /**
   * @param {object} config
   * @param {string} modelId
   * @param {Array<{ role: string, content: string }>} messages
   * @param {{ onToken?: ((chunk: string) => void) | null }} [opts]
   */
  const stream = async (config, modelId, messages, { onToken } = {}) => {
    calls.push({ modelId, messages });
    for (const ch of reply) onToken?.(ch);
    return { model: modelId, text: reply, streamed: true, usage: { total_tokens: reply.length } };
  };
  stream.calls = calls;
  return stream;
}

function stubOut() {
  const rendered = [];
  return {
    json: false,
    quiet: false,
    verbose: false,
    rendered,
    last() {
      return rendered[rendered.length - 1];
    },
    async init(result, renderText) {
      rendered.push({ result, text: typeof renderText === "function" ? renderText(result) : null });
    },
    info(message) {
      rendered.push({ info: message });
    },
    status(message) {
      rendered.push({ status: message });
    },
    error(message) {
      rendered.push({ error: message });
    },
    warn(message) {
      rendered.push({ warn: message });
    },
    detail(message) {
      rendered.push({ detail: message });
    },
  };
}

function stubJson() {
  const out = stubOut();
  out.json = true;
  return out;
}

// ---------------------------------------------------------------------------
// pure parsing
// ---------------------------------------------------------------------------

test("parseSlash recognises commands and passes messages through", () => {
  assert.equal(parseSlash("hello world"), null);
  assert.equal(parseSlash("   "), null);
  assert.equal(parseSlash("not/ a command"), null);

  assert.deepEqual(parseSlash("/help"), { name: "help", arg: "", raw: "/help" });
  // The split is on the first whitespace, so the argument keeps its own spaces.
  assert.deepEqual(parseSlash("/model   a/b c"), { name: "model", arg: "a/b c", raw: "/model   a/b c" });
  assert.equal(parseSlash("/MODEL").name, "model", "names are case-folded");
});

test("canonicalCommand folds aliases", () => {
  assert.equal(canonicalCommand("exit"), "quit");
  assert.equal(canonicalCommand("q"), "quit");
  assert.equal(canonicalCommand("help"), "help");
});

// ---------------------------------------------------------------------------
// engine: lifecycle and persistence
// ---------------------------------------------------------------------------

test("init creates a session and send streams, then persists the exchange", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const tokens = [];
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("Hello") });
  await chat.init({ forceNew: true });

  const info = chat.getInfo();
  assert.match(info.sessionId, /^ses_/);
  assert.equal(info.fresh, true);

  const result = await chat.send("hi", { onToken: (t) => tokens.push(t) });
  assert.equal(result.ok, true);
  assert.equal(result.text, "Hello");
  assert.equal(tokens.join(""), "Hello", "tokens arrive through onToken");

  assert.deepEqual(chat.getHistory(), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello" },
  ]);

  const persisted = sessions.read(info.sessionId);
  const conversation = persisted.entries.filter((e) => e.kind === "conversation");
  assert.equal(conversation.length, 2);
  assert.equal(conversation[0].role, "user");
  assert.equal(conversation[1].role, "assistant");
});

test("init resumes the current session and replays its history", async () => {
  const dir = scratch("aflow-chat-");
  const sessions = new SessionStore({ dir });

  const first = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("ok"), projectRoot: process.cwd() });
  await first.init({ forceNew: true });
  await first.send("remember me");
  const id = first.getInfo().sessionId;

  const second = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("ok"), projectRoot: process.cwd() });
  await second.init();

  assert.equal(second.getInfo().sessionId, id);
  assert.equal(second.getInfo().fresh, false, "a resumed session is not fresh");
  assert.deepEqual(
    second.getHistory().map((m) => m.content),
    ["remember me", "ok"],
  );
});

test("--new forces a fresh session even when a current one exists", async () => {
  const dir = scratch("aflow-chat-");
  const sessions = new SessionStore({ dir });
  const first = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await first.init({ forceNew: true });
  const id = first.getInfo().sessionId;

  const second = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await second.init({ forceNew: true });
  assert.notEqual(second.getInfo().sessionId, id);
});

// ---------------------------------------------------------------------------
// engine: failover
// ---------------------------------------------------------------------------

test("send falls over to the next candidate and records the transition", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const tried = [];
  const stream = async (config, modelId) => {
    tried.push(modelId);
    if (modelId === "dead/one") {
      throw Object.assign(new Error("429 rate limited"), { status: 429 });
    }
    return { model: modelId, text: "recovered", streamed: true };
  };

  const chat = new ChatSession({ sessions, config: {}, modelId: "dead/one", stream, catalogue: ["live/two"] });
  await chat.init({ forceNew: true });

  const result = await chat.send("ping");
  assert.equal(result.ok, true);
  assert.equal(result.model, "live/two");
  assert.equal(chat.getInfo().fallback, true);
  assert.deepEqual(tried, ["dead/one", "live/two"]);

  const persisted = sessions.read(chat.getInfo().sessionId);
  const transition = persisted.entries.find((e) => e.kind === "provider_transition");
  assert.ok(transition, "a provider transition is recorded");
  assert.equal(transition.from, "dead/one");
  assert.equal(transition.to, "live/two");
});

test("a failed user turn stays in the session and surfaces an error", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const stream = async () => {
    throw Object.assign(new Error("no credentials"), { status: 401 });
  };
  const chat = new ChatSession({ sessions, config: {}, modelId: "dead/one", stream });
  await chat.init({ forceNew: true });

  const result = await chat.send("are you there?");
  assert.equal(result.ok, false);
  assert.equal(result.allFailed, true);

  // The whole point of --resume is that nothing the user typed is lost to a bad
  // provider, so the user turn must already be on disk.
  const persisted = sessions.read(chat.getInfo().sessionId);
  const userTurns = persisted.entries.filter((e) => e.kind === "conversation" && e.role === "user");
  assert.equal(userTurns.length, 1);
  assert.equal(userTurns[0].content, "are you there?");
});

// ---------------------------------------------------------------------------
// engine: free-first ordering
// ---------------------------------------------------------------------------

test("chat tries free candidates first when no model was chosen explicitly", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const stream = mockStream("free answer");
  const chat = new ChatSession({
    sessions,
    config: { preferFree: true, modelHints: { "acme/paid": { costClass: "paid" } } },
    catalogue: ["acme/paid", "openrouter/free:free", "groq/fast"],
    stream,
  });
  await chat.init({ forceNew: true });

  const result = await chat.send("ping");
  assert.equal(result.ok, true);
  assert.deepEqual(stream.calls.map((c) => c.modelId), ["openrouter/free:free"]);
});

test("an explicitly chosen model is not displaced by a cheaper one", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const stream = mockStream("explicit answer");
  const chat = new ChatSession({
    sessions,
    config: { preferFree: true, modelHints: { "acme/paid": { costClass: "paid" } } },
    modelId: "acme/paid",
    catalogue: ["openrouter/free:free", "acme/paid"],
    stream,
  });
  await chat.init({ forceNew: true });

  await chat.send("ping");
  assert.deepEqual(stream.calls.map((c) => c.modelId), ["acme/paid"]);
});

test("chat preserves catalogue order when free-first is disabled", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const stream = mockStream("catalogue answer");
  const chat = new ChatSession({
    sessions,
    config: { preferFree: false, allowPaidFallback: true, modelHints: { "acme/paid": { costClass: "paid" } } },
    catalogue: ["acme/paid", "openrouter/free:free"],
    stream,
  });
  await chat.init({ forceNew: true });

  await chat.send("ping");
  assert.deepEqual(stream.calls.map((c) => c.modelId), ["acme/paid"]);
});

test("paid fallback is disabled by default and refuses with an actionable error", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const stream = mockStream("should not run");
  const chat = new ChatSession({
    sessions,
    config: { preferFree: true, modelHints: { "acme/paid": { costClass: "paid" } } },
    catalogue: ["acme/paid"],
    stream,
  });
  await chat.init({ forceNew: true });

  const result = await chat.send("ping");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_model");
  assert.match(result.error.message, /paid fallback is disabled/);
  assert.deepEqual(stream.calls, [], "no paid request may be dispatched");
});

test("paid fallback runs only when explicitly enabled", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const stream = mockStream("paid answer");
  const chat = new ChatSession({
    sessions,
    config: { preferFree: true, allowPaidFallback: true, modelHints: { "acme/paid": { costClass: "paid" } } },
    catalogue: ["acme/paid"],
    stream,
  });
  await chat.init({ forceNew: true });

  const result = await chat.send("ping");
  assert.equal(result.ok, true);
  assert.deepEqual(stream.calls.map((c) => c.modelId), ["acme/paid"]);
});

test("each turn persists one usage entry with observed tokens", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("Hello") });
  await chat.init({ forceNew: true });

  const first = await chat.send("hi");
  const second = await chat.send("again");
  assert.equal(first.usageSummary.requests, 1);
  assert.equal(second.usageSummary.requests, 2);

  const persisted = sessions.read(chat.getInfo().sessionId);
  const usage = persisted.entries.filter((e) => e.kind === "usage");
  assert.equal(usage.length, 2, "one batch per turn, not one entry per request");
  assert.equal(usage[0].requests.length, 1);
  assert.equal(usage[0].requests[0].outcome, "ok");
  assert.equal(usage[0].requests[0].dispatched, true);
  assert.deepEqual(usage[0].requests[0].tokens, { prompt: null, completion: null, total: 5 });
  assert.equal(usage[0].requests[0].usageSource, "provider");
  assert.equal(usage[1].requests.length, 1);
});

test("usage persistence continues after bounded ledger evicts old records", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  // A tiny ledger so eviction happens quickly: after 3 records, the oldest is dropped.
  const usage = new UsageLedger({ now: () => 1_000, maxRecords: 3 });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("Hello"), usage });
  await chat.init({ forceNew: true });

  // Send 5 turns -- enough to evict the first 2 usage records from the ledger.
  for (let i = 0; i < 5; i++) await chat.send(`turn ${i}`);

  const persisted = sessions.read(chat.getInfo().sessionId);
  const usageEntries = persisted.entries.filter((e) => e.kind === "usage");
  // Every turn should have persisted its usage, even after eviction.
  assert.equal(usageEntries.length, 5, "one usage entry per turn despite ledger eviction");
  const totalRequests = usageEntries.reduce((sum, e) => sum + e.requests.length, 0);
  assert.equal(totalRequests, 5, "all 5 usage requests persisted, none lost to eviction");
});

// ---------------------------------------------------------------------------
// engine: slash commands
// ---------------------------------------------------------------------------

test("/help returns the command list and /exit is an alias for /quit", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await chat.init({ forceNew: true });

  const help = await chat.command(parseSlash("/help"));
  assert.equal(help.text, SLASH_HELP);

  const quit = await chat.command(parseSlash("/exit"));
  assert.equal(quit.exit, true);
});

test("/model shows the current model and switches it", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await chat.init({ forceNew: true });

  const shown = await chat.command(parseSlash("/model"));
  assert.match(shown.text, /a\/one/);

  const switched = await chat.command(parseSlash("/model b/two"));
  assert.match(switched.text, /b\/two/);
  assert.equal(chat.modelId, "b/two");
  assert.equal(chat.currentProvider, "b");
});

test("/new starts a new session; /clear empties the prompt but keeps the session", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("ok") });
  await chat.init({ forceNew: true });
  await chat.send("one");
  const idBefore = chat.getInfo().sessionId;

  const cleared = await chat.command(parseSlash("/clear"));
  assert.match(cleared.text, /cleared/);
  assert.equal(chat.getHistory().length, 0);
  assert.equal(chat.getInfo().sessionId, idBefore, "/clear keeps the session");

  const fresh = await chat.command(parseSlash("/new"));
  assert.equal(fresh.kind, "new");
  assert.notEqual(chat.getInfo().sessionId, idBefore);
  assert.equal(chat.getHistory().length, 0);
});

test("/status reports model, provider and circuit state", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await chat.init({ forceNew: true });

  const status = await chat.command(parseSlash("/status"));
  assert.equal(status.kind, "status");
  assert.match(status.text, /a\/one/);
  assert.equal(status.data.model, "a/one");
  assert.equal(status.data.provider, "a");
});

test("/add, /context and /drop manage the context files", async () => {
  const root = scratch("aflow-chat-ws-");
  fs.writeFileSync(path.join(root, "note.txt"), "hello file");
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({
    sessions,
    config: {},
    modelId: "a/one",
    stream: mockStream(),
    workspaceRoot: root,
    projectRoot: root,
  });
  await chat.init({ forceNew: true });

  const added = await chat.command(parseSlash("/add note.txt"));
  assert.match(added.text, /added note\.txt/);

  const ctx = await chat.command(parseSlash("/context"));
  assert.match(ctx.text, /note\.txt/);

  const dropped = await chat.command(parseSlash("/drop note.txt"));
  assert.match(dropped.text, /removed note\.txt/);
  assert.equal(chat.getInfo().contextFiles.length, 0);
});

test("/add refuses a path outside the workspace", async () => {
  const root = scratch("aflow-chat-ws-");
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({
    sessions,
    config: {},
    modelId: "a/one",
    stream: mockStream(),
    workspaceRoot: root,
    projectRoot: root,
  });
  await chat.init({ forceNew: true });

  const refused = await chat.command(parseSlash("/add ../../etc/passwd"));
  assert.match(refused.text, /refused/);
  assert.equal(chat.getInfo().contextFiles.length, 0);
});

test("unknown slash commands are reported, not dispatched", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await chat.init({ forceNew: true });

  const unknown = await chat.command(parseSlash("/frobnicate"));
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.text, /unknown command: \/frobnicate/);
});

test("/compact summarises older messages and shrinks the prompt", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const complete = async () => ({ text: "SUMMARY" });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream("x"), complete, recentKeep: 2 });
  await chat.init({ forceNew: true });
  for (let i = 0; i < 4; i++) await chat.send(`message ${i}`);

  const before = chat.getHistory().length;
  const compacted = await chat.command(parseSlash("/compact"));
  assert.equal(compacted.kind, "compact");
  assert.ok(compacted.data.removed > 0);
  assert.ok(chat.getHistory().length < before);
});

test("statusLine carries a tier the CLI can colour", async () => {
  const sessions = new SessionStore({ dir: scratch("aflow-chat-") });
  const chat = new ChatSession({ sessions, config: {}, modelId: "a/one", stream: mockStream() });
  await chat.init({ forceNew: true });

  const line = chat.statusLine();
  assert.match(line.text, /a\/one/);
  assert.ok(["healthy", "unknown", "fallback", "error"].includes(line.tier));
});

// ---------------------------------------------------------------------------
// command layer: the readline loop
// ---------------------------------------------------------------------------

test("the chat command runs a piped conversation and exits on /quit", async () => {
  let captured = "";
  const output = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });
  const input = Readable.from(["hello\n", "/quit\n"]);
  const out = stubOut();

  const code = await chatCommand.run({
    args: [],
    flags: { "state-dir": scratch("aflow-chat-"), "blackboard-dir": scratch("aflow-chat-bb-"), model: "a/one" },
    config: {},
    out,
    deps: { input, output, stream: mockStream("Hi there"), interactive: false, listModels: async () => [] },
  });

  assert.equal(code, 0);
  assert.match(captured, /Hi there/, "the assistant reply is written to stdout");
  // Both piped lines must be processed: the second (/quit) exits the loop. If
  // the loop dropped it, the process would still be waiting and this test would
  // hang rather than fail -- which is why it is worth keeping.
  assert.ok(!captured.includes("unknown command"), "no stray /quit was treated as a message");
});

test("the chat command's one-shot --json emits a JSON payload", async () => {
  const out = stubJson();
  const code = await chatCommand.run({
    args: ["hello"],
    flags: { "state-dir": scratch("aflow-chat-"), "blackboard-dir": scratch("aflow-chat-bb-"), model: "a/one" },
    config: {},
    out,
    deps: { stream: mockStream("Hi there"), listModels: async () => [] },
  });

  assert.equal(code, 0);
  const payload = out.last().result;
  assert.equal(payload.ok, true);
  assert.equal(payload.text, "Hi there");
  assert.match(payload.sessionId, /^ses_/);
});

test("the chat command answers usage mistakes without opening a provider", async () => {
  const a = stubOut();
  assert.equal(
    await chatCommand.run({ args: [], flags: { resume: "ses_x", new: true }, config: {}, out: a, deps: {} }),
    2,
    "--resume with --new is a usage error",
  );

  const b = stubOut();
  assert.equal(
    await chatCommand.run({ args: [], flags: { agent: "no-such-agent" }, config: {}, out: b, deps: {} }),
    2,
    "an unknown agent is a usage error",
  );
});

test("the chat command rejects an unknown --resume id", async () => {
  const out = stubOut();
  const code = await chatCommand.run({
    args: [],
    flags: {
      "state-dir": scratch("aflow-chat-"),
      "blackboard-dir": scratch("aflow-chat-bb-"),
      resume: "ses_20200101T000000000Z_zzzzzz",
    },
    config: {},
    out,
    deps: { stream: mockStream(), listModels: async () => [] },
  });
  assert.equal(code, 1);
  assert.ok(out.rendered.some((r) => r.error), "an error is reported");
});
