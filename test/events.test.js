// Event log tests.
//
// The redaction test here is the important one: a log file outlives the process
// and gets pasted into bug reports, so a credential reaching disk is worse than
// one reaching a terminal.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog, EVENTS, readEvents, summarize, formatEvent, nullLog } from "../src/core/events.js";

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-events-"));
  return path.join(dir, "log.jsonl");
}

test("writes one JSON object per line", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  log.info(EVENTS.AGENT_START, { agent: "build" });
  log.info(EVENTS.AGENT_STOP, { agent: "build" });

  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, "agent.start");
  assert.equal(JSON.parse(lines[1]).type, "agent.stop");
});

test("credentials never reach disk", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  log.info(EVENTS.GATEWAY_ERROR, {
    apiKey: "sk-EXAMPLE0fixture0value-notreal",
    nested: { authorization: "Bearer abc123def456ghi789" },
    arr: [{ token: "tok_fixture_value_123456" }],
    keep: "visible",
  });

  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("EXAMPLE0fixture0value"), "api key must be masked on disk");
  assert.ok(!raw.includes("abc123def456ghi789"), "nested authorization must be masked");
  assert.ok(!raw.includes("tok_fixture_value_123456"), "token inside an array must be masked");
  assert.ok(raw.includes("visible"), "non-sensitive fields must survive");
});

test("level filters writes", () => {
  const file = tmpLog();
  const log = new EventLog({ file, level: "warn" });
  log.debug("x", {});
  log.info("y", {});
  log.warn("z", {});
  log.error("w", {});

  const { events } = readEvents({ file });
  assert.deepEqual(events.map((e) => e.level), ["warn", "error"]);
});

test("logging to an unwritable path disables itself instead of throwing", () => {
  // A logging failure must never break the operation being observed.
  const log = new EventLog({ file: path.join("\u0000invalid", "nope", "x.jsonl") });
  assert.doesNotThrow(() => log.info(EVENTS.AGENT_START, {}));
  assert.equal(log.enabled, false, "should stop trying after the first failure");
  assert.ok(log.errorCount > 0);
});

test("a throwing getter in the payload cannot crash logging", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  const hostile = {
    get boom() {
      throw new Error("nope");
    },
    safe: 1,
  };
  assert.doesNotThrow(() => log.info(EVENTS.AGENT_ERROR, hostile));
  // The event may be dropped or degraded, but the log file must still parse.
  const { events } = readEvents({ file });
  for (const ev of events) assert.equal(typeof ev.type, "string");
});

test("a malformed event type is dropped, not thrown", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  assert.equal(log.emit("", {}), null);
  assert.equal(log.emit(null, {}), null);
  assert.equal(log.emit(123, {}), null);
});

test("readEvents tolerates a truncated final line", () => {
  const file = tmpLog();
  fs.writeFileSync(file, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", level: "info", type: "a" })}\n{"ts":"2026`);
  const { events, skipped } = readEvents({ file });
  assert.equal(events.length, 1);
  assert.equal(skipped, 1, "the partial line is counted, not thrown");
});

test("readEvents reports a missing file rather than throwing", () => {
  const r = readEvents({ file: path.join(os.tmpdir(), "definitely-not-here-9f3a.jsonl") });
  assert.equal(r.missing, true);
  assert.deepEqual(r.events, []);
});

test("--limit returns the tail, not the head", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  for (let i = 0; i < 20; i++) log.info("n", { i });

  const { events } = readEvents({ file, limit: 3 });
  assert.equal(events.length, 3);
  assert.equal(events.at(-1).i, 19, "newest event must be last");
});

test("limit 0 means all events", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  for (let i = 0; i < 5; i++) log.info("n", { i });
  assert.equal(readEvents({ file, limit: 0 }).events.length, 5);
});

test("filters by level, type, and since", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  log.info("route.decision", { model: "a" });
  log.error("route.fallback", { from: "a", to: "b" });

  assert.equal(readEvents({ file, type: "route.decision" }).events.length, 1);
  assert.equal(readEvents({ file, level: "error" }).events.length, 1);
  assert.equal(readEvents({ file, since: "2999-01-01T00:00:00Z" }).events.length, 0);
  assert.equal(readEvents({ file, since: "2000-01-01T00:00:00Z" }).events.length, 2);
});

test("summarize counts by type and level, newest last", () => {
  const file = tmpLog();
  const log = new EventLog({ file });
  log.info("a", {});
  log.info("a", {});
  log.error("b", {});

  const s = summarize(readEvents({ file }).events);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byType[0], ["a", 2]);
  assert.equal(s.byLevel.find((l) => l[0] === "error")[1], 1);
  assert.ok(s.oldest <= s.newest);
});

test("formatEvent is greppable and carries no control characters", () => {
  const out = formatEvent({ ts: "2026-01-01T00:00:00.000Z", seq: 1, level: "info", type: "a", model: "m" });
  assert.match(out, /2026-01-01T00:00:00.000Z\s+INFO\s+a\s+\{"model":"m"\}/);
  assert.ok(!/[\r\n]/.test(out));
});

test("nullLog discards without touching the filesystem", () => {
  const log = nullLog();
  assert.equal(log.emit(EVENTS.AGENT_START, { a: 1 }), null);
  assert.equal(log.errorCount, 0);
});

test("event names are unique and stable", () => {
  const values = Object.values(EVENTS);
  assert.equal(new Set(values).size, values.length, "duplicate event name");
  // One namespace segment, then a snake_case verb. The verb is allowed more than
  // one word because most agent lifecycle events are genuinely compound
  // (`agent.context_loaded`, `agent.model_selected`) and flattening them to
  // `agent.contextloaded` would be less readable, not more consistent. What the
  // regex is here to catch is an unnamespaced or camelCase name, which would
  // break `aflow logs --type` queries.
  for (const v of values) assert.match(v, /^[a-z]+\.[a-z_]+$/, `${v} should be namespaced`);
});