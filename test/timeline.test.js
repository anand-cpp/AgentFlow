// Session timeline (src/tui/timeline.js + timeline-dialog.js): pure ANSI
// rendering over FLAT session entries (SessionStore.append spreads the payload
// onto the entry, so a conversation entry is {seq,ts,kind,role,content}, not
// {seq,ts,kind,payload:{...}}).

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const t = await import("../src/tui/timeline.js");
const d = await import("../src/tui/timeline-dialog.js");
const ui = await import("../src/cli/ui.js");
ui.setColor(false);

const entry = (seq, kind, extra = {}) => ({
  seq,
  ts: `2026-10-16T11:57:${String(seq).padStart(2, "0")}.000Z`,
  kind,
  ...extra,
});

test("buildTimeline orders by seq and labels each kind from flat fields", () => {
  const tl = t.buildTimeline([
    entry(2, "note", { text: "second" }),
    entry(1, "conversation", { role: "user", content: "first message" }),
  ]);
  assert.equal(tl.count, 2);
  assert.equal(tl.nodes[0].seq, 1);
  assert.equal(tl.nodes[0].label, "first message");
  assert.equal(tl.nodes[1].label, "second");
  assert.equal(tl.active, 1, "default active is the last entry");
});

test("buildTimeline label extractor handles every known kind", () => {
  const tl = t.buildTimeline([
    entry(1, "conversation", { role: "assistant", content: "hi there" }),
    entry(2, "note", { text: "a note" }),
    entry(3, "tool_call", { tool: "read_file", args: {} }),
    entry(4, "tool_result", { tool: "read_file", outcome: "ok" }),
    entry(5, "tool_result", { tool: "shell", outcome: "error", error: { message: "boom" } }),
    entry(6, "agent", { agentId: "coder", state: "COMPLETED", toolCalls: 3 }),
    entry(7, "routing", { decision: "prefer-fast" }),
    entry(8, "tribunal_run", { tribunal_id: "trib_1", verdict: "VERIFIED" }),
    entry(9, "error", { message: "gateway 503" }),
    entry(10, "checkpoint", { summary: "saved point" }),
    entry(11, "blackboard_ref", { ref: "bb_9" }),
    entry(12, "context", { packetRef: "ses_1:2026" }),
    entry(13, "provider_transition", { from: "a/one", to: "b/two" }),
  ]);
  const by = (seq) => tl.nodes.find((n) => n.seq === seq).label;
  assert.equal(by(1), "hi there");
  assert.equal(by(2), "a note");
  assert.equal(by(3), "read_file");
  assert.equal(by(4), "read_file → ok");
  assert.equal(by(5), "shell → error");
  assert.equal(by(6), "COMPLETED · 3 tools");
  assert.equal(by(7), "prefer-fast");
  assert.equal(by(8), "tribunal VERIFIED");
  assert.equal(by(9), "gateway 503");
  assert.equal(by(10), "saved point");
  assert.equal(by(11), "bb_9");
  assert.equal(by(12), "ses_1:2026");
  assert.equal(by(13), "a/one → b/two");
});

test("buildTimeline tolerates empty, null, and malformed input", () => {
  assert.deepEqual(t.buildTimeline([]), { nodes: [], active: -1, count: 0 });
  assert.deepEqual(t.buildTimeline(null), { nodes: [], active: -1, count: 0 });
  const tl = t.buildTimeline([null, "x", entry(1, "note", { text: "ok" })]);
  assert.equal(tl.count, 1, "non-objects are dropped");
  assert.equal(tl.nodes[0].label, "ok");
});

test("renderTimelineNode marks the active row and colours nothing under NO_COLOR", () => {
  const tl = t.buildTimeline([entry(1, "conversation", { role: "user", content: "hello" })]);
  const active = t.renderTimelineNode(tl.nodes[0], true);
  const idle = t.renderTimelineNode(tl.nodes[0], false);
  assert.match(active, /›/, "active row carries the marker");
  assert.doesNotMatch(idle, /›/, "idle row does not");
  assert.ok(!active.includes("\u001b"), "colour disabled → no escapes");
  assert.match(active, /hello/);
});

test("renderTimelineNode renders an empty cell for a missing node", () => {
  const out = t.renderTimelineNode(null, false);
  assert.equal(ui.width(out), ui.width("(empty)"));
  assert.match(out, /empty/);
});

test("renderTimeline shows a header, all rows, and a hint when there are none", () => {
  const tl = t.buildTimeline([entry(1, "note", { text: "a" }), entry(2, "note", { text: "b" })]);
  const out = t.renderTimeline(tl, { width: 90 });
  const lines = out.split("\n");
  assert.match(lines[0], /TIMELINE/);
  assert.match(lines[0], /2 entries/);
  assert.match(out, /a/);
  assert.match(out, /b/);

  const empty = t.renderTimeline(t.buildTimeline([]), {});
  assert.match(empty, /TIMELINE/);
  assert.match(empty, /no entries/);
});

test("renderTimeline clips to the viewport height and notes the remainder", () => {
  const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1, "note", { text: `n${i + 1}` }));
  const tl = t.buildTimeline(entries);
  const out = t.renderTimeline(tl, { width: 90, height: 5, offset: 0 });
  const lines = out.split("\n");
  assert.equal(lines.length, 1 + 5 + 1, "header + 5 rows + remainder hint");
  assert.match(lines[lines.length - 1], /more/);
});

test("navigateTimeline clamps at both ends and honours TOP/BOTTOM", () => {
  const tl = t.buildTimeline([entry(1, "note", { text: "a" }), entry(2, "note", { text: "b" }), entry(3, "note", { text: "c" })]);
  let cur = t.navigateTimeline(tl, t.TIMELINE_DIRECTIONS.UP);
  assert.equal(cur.active, 1);
  cur = t.navigateTimeline(cur, t.TIMELINE_DIRECTIONS.UP);
  assert.equal(cur.active, 0);
  cur = t.navigateTimeline(cur, t.TIMELINE_DIRECTIONS.UP);
  assert.equal(cur.active, 0, "clamped at top");
  cur = t.navigateTimeline(cur, t.TIMELINE_DIRECTIONS.DOWN);
  assert.equal(cur.active, 1);
  cur = t.navigateTimeline(cur, t.TIMELINE_DIRECTIONS.BOTTOM);
  assert.equal(cur.active, 2, "jump to bottom");
  cur = t.navigateTimeline(cur, t.TIMELINE_DIRECTIONS.TOP);
  assert.equal(cur.active, 0, "jump to top");
});

test("navigateTimeline on an empty timeline stays empty", () => {
  const out = t.navigateTimeline(t.buildTimeline([]), t.TIMELINE_DIRECTIONS.DOWN);
  assert.equal(out.active, -1);
  assert.equal(out.count, 0);
});

test("timelineDialog starts on the last entry and moves with the arrow keys", () => {
  const entries = [entry(1, "note", { text: "a" }), entry(2, "note", { text: "b" }), entry(3, "note", { text: "c" })];
  const dlg = d.timelineDialog(entries, { width: 80, height: 12 });
  assert.equal(dlg.state.timeline.active, 2);
  dlg.handleKey("", { name: "up" });
  dlg.handleKey("", { name: "up" });
  assert.equal(dlg.state.timeline.active, 0);
  dlg.handleKey("", { name: "down" });
  assert.equal(dlg.state.timeline.active, 1);
  const rendered = dlg.render();
  assert.match(rendered, /TIMELINE/);
  assert.match(rendered, /↑↓/, "hint line is present");
});

test("timelineDialog Enter yields the active node; f yields a fork request", () => {
  const entries = [entry(1, "note", { text: "a" }), entry(2, "note", { text: "b" })];
  const dlg = d.timelineDialog(entries, {});
  const jumped = dlg.handleKey("", { name: "enter" });
  assert.equal(jumped.done, true);
  assert.equal(jumped.value.jump, true);
  assert.equal(jumped.value.node.seq, 2);

  const dlg2 = d.timelineDialog(entries, {});
  dlg2.handleKey("", { name: "up" });
  const forked = dlg2.handleKey("f", { name: "f" });
  assert.equal(forked.value.fork, true);
  assert.equal(forked.value.node.seq, 1);
});

test("timelineDialog q, Escape and Ctrl+C all close without a value", () => {
  for (const key of [{ name: "q" }, { name: "escape" }, { name: "c", ctrl: true }]) {
    const dlg = d.timelineDialog([entry(1, "note", { text: "a" })], {});
    const res = dlg.handleKey(key.name === "q" ? "q" : "", key);
    assert.equal(res.done, true, `${key.name} closes`);
    assert.equal(res.value, null);
  }
});

test("timelineDialog ignores unknown keys and keeps the session open", () => {
  const dlg = d.timelineDialog([entry(1, "note", { text: "a" })], {});
  const res = dlg.handleKey("x", { name: "x" });
  assert.equal(res.done, false);
});

test("timelineDialog render is ANSI-free when colour is disabled", () => {
  const dlg = d.timelineDialog([entry(1, "note", { text: "a" })], { width: 80, height: 12 });
  assert.ok(!dlg.render().includes("\u001b"));
});
