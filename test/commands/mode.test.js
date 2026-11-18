// CLI mode command tests.

import assert from "node:assert/strict";
import test from "node:test";

import { MODE } from "../../src/core/modes/index.js";

test("cli-mode: MODE constants are exported", () => {
  assert.strictEqual(MODE.PLAN, "plan");
  assert.strictEqual(MODE.BUILD, "build");
  assert.strictEqual(MODE.ORCHESTRATE, "orchestrate");
  assert.strictEqual(MODE.AUTO, "auto");
});
