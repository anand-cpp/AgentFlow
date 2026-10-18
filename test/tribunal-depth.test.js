// Depth knob tests.
//
// resolveDepth maps a depth name (quick / standard / deep / inquisition) to the
// preset the five-stage pipeline uses. Unknown names fall back to standard; the
// gate (0.95) is unchanged by depth.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEPTH_QUICK,
  DEPTH_STANDARD,
  DEPTH_DEEP,
  DEPTH_INQUISITION,
  DEPTH_DEFAULT,
  DEPTH_NAMES,
  resolveDepth,
  isValidDepth,
} from "../src/core/tribunal/tribunal-depth.js";

test("resolveDepth maps each known name to its preset", () => {
  assert.deepEqual(resolveDepth(DEPTH_QUICK), {
    models: 2,
    rounds: 1,
    oracleMode: "lite",
    earlyTermination: false,
    hardTimeoutMs: null,
  });
  assert.deepEqual(resolveDepth(DEPTH_STANDARD), {
    models: 3,
    rounds: 2,
    oracleMode: "full",
    earlyTermination: false,
    hardTimeoutMs: null,
  });
  assert.deepEqual(resolveDepth(DEPTH_DEEP), {
    models: 5,
    rounds: 3,
    oracleMode: "full",
    earlyTermination: false,
    hardTimeoutMs: null,
  });
  assert.deepEqual(resolveDepth(DEPTH_INQUISITION), {
    models: null,
    rounds: null,
    oracleMode: "full",
    earlyTermination: true,
    hardTimeoutMs: 300_000,
  });
});

test("resolveDepth falls back to standard for unknown or missing names", () => {
  assert.deepEqual(resolveDepth(null), resolveDepth(DEPTH_STANDARD));
  assert.deepEqual(resolveDepth(undefined), resolveDepth(DEPTH_STANDARD));
  assert.deepEqual(resolveDepth("bogus"), resolveDepth(DEPTH_STANDARD));
  assert.deepEqual(resolveDepth(""), resolveDepth(DEPTH_STANDARD));
});

test("isValidDepth recognises exactly the four depth names", () => {
  assert.equal(isValidDepth(DEPTH_QUICK), true);
  assert.equal(isValidDepth(DEPTH_STANDARD), true);
  assert.equal(isValidDepth(DEPTH_DEEP), true);
  assert.equal(isValidDepth(DEPTH_INQUISITION), true);
  assert.equal(isValidDepth("bogus"), false);
  assert.equal(isValidDepth(null), false);
  assert.equal(isValidDepth(undefined), false);
});

test("DEPTH_DEFAULT is standard", () => {
  assert.equal(DEPTH_DEFAULT, DEPTH_STANDARD);
});

test("DEPTH_NAMES lists all four depths in effort order", () => {
  assert.deepEqual(DEPTH_NAMES, [DEPTH_QUICK, DEPTH_STANDARD, DEPTH_DEEP, DEPTH_INQUISITION]);
});

test("depth presets are immutable (frozen)", () => {
  const quick = resolveDepth(DEPTH_QUICK);
  assert.throws(() => {
    quick.models = 99;
  }, TypeError);
  assert.equal(quick.models, 2, "freeze prevented mutation");
});
