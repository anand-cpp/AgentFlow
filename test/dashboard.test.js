// Dashboard rendering tests.
//
// renderFrame is a pure function of state specifically so it can be tested
// without a TTY. Rendering bugs in a full-screen app are otherwise invisible
// until someone runs it.

import test from "node:test";
import assert from "node:assert/strict";
import { renderFrame } from "../src/tui/dashboard.js";
import { setColor, width } from "../src/cli/ui.js";

setColor(false);

const baseState = {
  reachable: true,
  baseUrl: "http://localhost:20127",
  latencyMs: 42,
  version: "0.5.95",
  catalogueCount: 790,
  reachableProbeCount: 0,
  probes: [],
  now: "12:00:00",
};

test("renders reachable gateway", () => {
  const out = renderFrame(baseState, 100);
  assert.match(out, /AgentFlow/);
  assert.match(out, /up/);
  assert.match(out, /790/);
});

test("renders unreachable gateway with a hint", () => {
  const out = renderFrame({ reachable: false, error: "ECONNREFUSED", baseUrl: "http://localhost:20127", probes: [] }, 100);
  assert.match(out, /unreachable/i);
  assert.match(out, /ECONNREFUSED/);
  assert.match(out, /custom-server\.js/);
});

test("shows probe rows when probes exist", () => {
  const out = renderFrame(
    {
      ...baseState,
      probes: [
        { model: "oc/muse-spark", status: "ok", elapsedMs: 120, sample: "PONG" },
        { model: "ocz/x", status: "error", elapsedMs: 30, detail: "no credentials" },
      ],
    },
    100
  );
  assert.match(out, /oc\/muse-spark/);
  assert.match(out, /no credentials/);
});

test("empty probe result is reported honestly, not hidden", () => {
  // The whole point of this view: advertised vs actually working.
  const out = renderFrame(
    { ...baseState, reachableProbeCount: 0, probes: [{ model: "m", status: "empty", elapsedMs: 10, detail: "200 empty" }] },
    100
  );
  assert.match(out, /empty/);
});

test("no ANSI escapes leak when colour is disabled", () => {
  const out = renderFrame(baseState, 100);
  assert.ok(!/\u001b\[/.test(out), "must be plain text when colour is off");
});

test("frame respects a narrow terminal without throwing", () => {
  assert.doesNotThrow(() => renderFrame(baseState, 20));
  assert.doesNotThrow(() => renderFrame(baseState, 200));
});

test("width() ignores ANSI escapes", () => {
  setColor(true);
  const painted = "\u001b[31mabc\u001b[0m";
  assert.equal(width(painted), 3);
  setColor(false);
});