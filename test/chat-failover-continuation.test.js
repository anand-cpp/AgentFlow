// End-to-end chat failover: a mid-turn provider failure, the preserved user
// turn, and a transcript that shows both attempts.
//
// This is the pipeline `aflow chat` promises: when the primary model dies
// mid-response the next candidate answers, the user never retypes, and nothing
// typed is lost. It exercises ChatSession.send() against real stores with a
// controllable stream, unlike the unit tests around it which drive single
// seams.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChatSession } from "../src/core/chat.js";
import { defineAgent, AgentRegistry } from "../src/core/agents/registry.js";
import { SessionStore } from "../src/core/sessions.js";
import { BlackboardStore } from "../src/core/blackboard.js";

const PRIMARY = "oca/model-a";
const FALLBACK = "gemb/model-b";

function agent() {
  return defineAgent({
    id: "failoverchat",
    purpose: "chat under failover",
    instructions: "You are a test assistant.",
    failure: { maxRetries: 0 },
  });
}

/**
 * A ChatSession whose primary model always dies and whose second candidate
 * always answers. Records every stream call so a test can prove both attempts
 * were made.
 */
async function failingChat({ modelId = PRIMARY } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-chat-failover-"));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sessions = new SessionStore({ dir: path.join(dir, "sessions"), now: () => 1000 });
  const blackboard = new BlackboardStore({ dir: path.join(dir, "bb"), projectRoot: dir, now: () => 1000 });
  blackboard.create({ goal: "failover", objective: "survive a dead provider" });

  const calls = [];
  const stream = async (_cfg, mid) => {
    calls.push(mid);
    if (mid === PRIMARY) {
      throw Object.assign(new Error("429 rate limited"), { status: 429, code: "rate_limited" });
    }
    return { model: mid, text: "fallback answer" };
  };

  const session = new ChatSession({
    sessions,
    blackboard,
    registry: new AgentRegistry([agent()]),
    agentId: "failoverchat",
    modelId,
    catalogue: [PRIMARY, FALLBACK],
    stream,
    workspaceRoot: dir,
    projectRoot: dir,
    now: () => 1000,
  });
  await session.init({ forceNew: true });
  return { session, sessions, blackboard, dir, calls };
}

test("the second candidate answers when the primary provider dies mid-turn", async () => {
  const { session, calls } = await failingChat();

  const result = await session.send("hello there");

  assert.equal(result.ok, true, "the turn still succeeds through failover");
  assert.equal(result.model, FALLBACK, "the fallback candidate answered");
  assert.equal(result.text, "fallback answer");
  assert.equal(result.info.fallback, true, "the result is flagged as a fallback");

  assert.equal(calls.length, 2, "both candidates were attempted");
  assert.equal(calls[0], PRIMARY, "the primary is tried first");
  assert.equal(calls[1], FALLBACK, "the runner-up is tried second");
});

test("the user's message survives a provider that never answered", async () => {
  const { session } = await failingChat();

  await session.send("do not lose me");

  const history = session.getHistory();
  assert.equal(history[0].role, "user");
  assert.equal(history[0].content, "do not lose me", "the user turn was recorded before dispatch");
  const last = history[history.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.content, "fallback answer");
});

test("the session transcript records both attempts and the provider transition", async () => {
  const { session, sessions } = await failingChat();
  const id = session.session.id;

  await session.send("please record everything");

  const stored = sessions.read(id);
  const kinds = stored.entries.map((e) => e.kind);

  // The user turn and the assistant answer both land in the conversation record.
  assert.ok(kinds.includes("conversation"), "conversation entries exist");

  const conversations = stored.entries.filter((e) => e.kind === "conversation");
  assert.equal(conversations[0].role, "user");
  assert.equal(conversations[0].content, "please record everything");
  assert.equal(conversations[conversations.length - 1].role, "assistant");
  assert.equal(conversations[conversations.length - 1].content, "fallback answer");

  // The failover itself is recorded as a provider transition, so `--resume`
  // and the session inspector can both see that the model changed.
  const transition = stored.entries.find((e) => e.kind === "provider_transition");
  assert.ok(transition, "the provider transition is recorded");
  assert.equal(transition.from, PRIMARY);
  assert.equal(transition.to, FALLBACK);
  assert.equal(transition.reason, "failover");
});
