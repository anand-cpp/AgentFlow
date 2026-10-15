// Event log guarantees: ordering, level filtering, redaction of anything that
// looks like a credential, and a reader that survives a process killed
// mid-write.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventLog, nullLog, readEvents, summarize, formatEvent, LEVELS } from "../src/core/events.js";

const SECRET = "sk-live-abcdef1234567890";

function tmpfile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aflow-events-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "agentflow.jsonl");
}

test("events land on disk in emit order with an increasing sequence", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file });

  log.info("a");
  log.info("b");
  log.warn("c");

  const { events, skipped, missing } = readEvents({ file, limit: 0 });
  assert.equal(missing, false);
  assert.equal(skipped, 0);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ["a", "b", "c"]);
  assert.ok(events[0].seq < events[1].seq && events[1].seq < events[2].seq, "seq orders rapid events");
  assert.ok(events.every((e) => Number.isFinite(Date.parse(e.ts))));
});

test("credentials in a payload never reach the log file", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file });

  log.info("provider.request", {
    apiKey: SECRET,
    headers: { authorization: `Bearer ${SECRET}` },
    nested: { token: SECRET, keep: "visible" },
  });

  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(SECRET), "no secret value is written");
  assert.ok(raw.includes("visible"), "ordinary fields survive redaction");

  const [ev] = readEvents({ file }).events;
  assert.notEqual(ev.apiKey, SECRET);
  assert.notEqual(ev.nested.token, SECRET);
  assert.equal(ev.nested.keep, "visible");
});

test("a level floor drops quieter events instead of writing them", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file, level: "warn" });

  assert.equal(log.debug("d"), null);
  assert.equal(log.info("i"), null);
  assert.equal(log.warn("w")?.type, "w");
  assert.equal(log.error("e")?.type, "e");

  const { events } = readEvents({ file, limit: 0 });
  assert.deepEqual(events.map((e) => e.type), ["w", "e"]);
});

test("the reader tolerates a truncated final line and still returns the rest", (t) => {
  const file = tmpfile(t);
  fs.writeFileSync(file, '{"type":"a","level":"info","ts":"2026-01-01T00:00:00.000Z","seq":1}\n{"type":"b","le');

  const { events, skipped } = readEvents({ file, limit: 0 });
  assert.equal(events.length, 1, "the intact line is kept");
  assert.equal(events[0].type, "a");
  assert.equal(skipped, 1, "the partial line is counted, not thrown");
});

test("limit returns the tail, not the head", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file });
  for (let i = 0; i < 10; i += 1) log.info(`ev-${i}`);

  const { events } = readEvents({ file, limit: 3 });
  assert.deepEqual(events.map((e) => e.type), ["ev-7", "ev-8", "ev-9"]);
});

test("filters compose on level, type and time", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file });
  log.info("one", { at: 1 });
  log.error("two");
  log.error("two");

  assert.equal(readEvents({ file, type: "two" }).events.length, 2);
  assert.equal(readEvents({ file, level: "error" }).events.length, 2);
  assert.equal(
    readEvents({ file, since: "2999-01-01T00:00:00.000Z" }).events.length,
    0,
    "nothing is older than the future",
  );
});

test("summarize groups by type and level and reports the time span", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file });
  log.info("a");
  log.info("a");
  log.warn("b");

  const s = summarize(readEvents({ file, limit: 0 }).events);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byType, [["a", 2], ["b", 1]]);
  assert.deepEqual(s.byLevel, [["info", 2], ["warn", 1]]);
  assert.ok(s.oldest && s.newest && s.oldest <= s.newest);
});

test("formatEvent renders one readable line with the metadata intact", (t) => {
  const file = tmpfile(t);
  const log = new EventLog({ file });
  const ev = log.error("provider.fail", { code: 500 });

  const line = formatEvent(ev);
  assert.ok(line.includes("ERROR"));
  assert.ok(line.includes("provider.fail"));
  assert.ok(line.includes("500"), "the payload rides along");
  assert.ok(!line.includes('"seq"'), "seq is bookkeeping, not output");
});

test("nullLog discards without touching disk", () => {
  const log = nullLog();
  assert.equal(log.enabled, false);
  assert.equal(log.info("x"), null);
  assert.ok(LEVELS.includes("info"));
});
