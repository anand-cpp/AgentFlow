// Mode manager tests — validates ModeRegistry selection, transitions, and persistence.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ModeRegistry, VALID_MODES } from "../../../src/core/modes/index.js";

// Minimal event log stub
class EventLogStub {
  constructor() {
    this.events = [];
  }
  emit(type, data, level) {
    this.events.push({ type, data, level });
  }
}

// Minimal session store stub
class SessionStoreStub {
  constructor() {
    this.sessions = new Map();
  }
  read(id) {
    return this.sessions.get(id);
  }
  update(id, patch) {
    const s = this.sessions.get(id);
    if (s) Object.assign(s, patch);
  }
}

test("mode-manager: VALID_MODES contains all four modes", () => {
  assert.ok(VALID_MODES.has("plan"));
  assert.ok(VALID_MODES.has("build"));
  assert.ok(VALID_MODES.has("orchestrate"));
  assert.ok(VALID_MODES.has("auto"));
  assert.strictEqual(VALID_MODES.size, 4);
});

test("mode-manager: initialize sets default mode", () => {
  const reg = new ModeRegistry();
  const state = reg.initialize();
  assert.strictEqual(state.mode, "plan");
  assert.strictEqual(reg.getMode(), "plan");
});

test("mode-manager: initialize with explicit mode", () => {
  const reg = new ModeRegistry();
  const state = reg.initialize({ mode: "build" });
  assert.strictEqual(state.mode, "build");
  assert.strictEqual(reg.getMode(), "build");
});

test("mode-manager: switchTo changes mode and records previous", async () => {
  const reg = new ModeRegistry();
  reg.initialize({ mode: "plan" });

  const result = await reg.switchTo("build");
  assert.ok(result.ok);
  assert.strictEqual(result.previousMode, "plan");
  assert.strictEqual(result.newMode, "build");
  assert.strictEqual(reg.getMode(), "build");
  assert.strictEqual(reg.getState().previousMode, "plan");
});

test("mode-manager: switchTo same mode returns switched false", async () => {
  const reg = new ModeRegistry();
  reg.initialize({ mode: "plan" });

  const result = await reg.switchTo("plan");
  assert.ok(result.ok);
  assert.strictEqual(result.switched, false);
  assert.strictEqual(reg.getMode(), "plan");
});

test("mode-manager: switchTo unknown mode returns error", async () => {
  const reg = new ModeRegistry();
  reg.initialize({ mode: "plan" });

  const result = await reg.switchTo("invalid");
  assert.ok(!result.ok);
  assert.ok(result.error.includes("unknown mode"));
  assert.strictEqual(reg.getMode(), "plan");
});

test("mode-manager: isEscalation detects privilege escalation", () => {
  const reg = new ModeRegistry();
  reg.initialize({ mode: "plan" });

  assert.ok(reg.isEscalation("build"));
  assert.ok(reg.isEscalation("auto"));
  assert.ok(!reg.isEscalation("plan"));
  assert.ok(!reg.isEscalation("invalid"));
});

test("mode-manager: cycle advances through modes", async () => {
  const reg = new ModeRegistry();
  reg.initialize({ mode: "plan" });

  let result = await reg.cycle();
  assert.ok(result.ok);
  assert.strictEqual(reg.getMode(), "build");

  result = await reg.cycle();
  assert.ok(result.ok);
  assert.strictEqual(reg.getMode(), "orchestrate");

  result = await reg.cycle();
  assert.ok(result.ok);
  assert.strictEqual(reg.getMode(), "auto");

  result = await reg.cycle();
  assert.ok(result.ok);
  assert.strictEqual(reg.getMode(), "plan");
});

test("mode-manager: policy reflects current mode", async () => {
  const reg = new ModeRegistry();
  reg.initialize({ mode: "plan" });

  assert.strictEqual(reg.getPolicy().mode, "plan");
  assert.ok(!reg.getPolicy().canWrite);

  await reg.switchTo("build");
  assert.strictEqual(reg.getPolicy().mode, "build");
  assert.ok(reg.getPolicy().canWrite);
});

test("mode-manager: event log records mode switches", async () => {
  const eventLog = new EventLogStub();
  const reg = new ModeRegistry({ eventLog });
  reg.initialize({ mode: "plan", sessionId: "s1" });

  await reg.switchTo("build");

  const switchEvents = eventLog.events.filter((e) => e.type === "mode.switched");
  assert.strictEqual(switchEvents.length, 1);
  assert.strictEqual(switchEvents[0].data.from, "plan");
  assert.strictEqual(switchEvents[0].data.to, "build");
  assert.strictEqual(switchEvents[0].data.sessionId, "s1");
});

test("mode-manager: session store restores mode", () => {
  const sessionStore = new SessionStoreStub();
  sessionStore.sessions.set("s1", { mode: "build", previousMode: "plan", switchCount: 2 });

  const reg = new ModeRegistry({ sessionStore });
  const state = reg.initialize({ sessionId: "s1" });

  assert.strictEqual(state.mode, "build");
  assert.strictEqual(state.previousMode, "plan");
  assert.strictEqual(state.switchCount, 2);
});

test("mode-manager: session store ignores invalid mode", () => {
  const sessionStore = new SessionStoreStub();
  sessionStore.sessions.set("s1", { mode: "invalid" });

  const reg = new ModeRegistry({ sessionStore });
  const state = reg.initialize({ sessionId: "s1" });

  assert.strictEqual(state.mode, "plan");
});
