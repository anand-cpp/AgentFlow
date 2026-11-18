// Hackathon CLI stop integration tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../../../src/commands/hackathon.js";

describe("hackathon CLI stop", () => {
  const out = {
    init: async () => {},
  };

  it("stop requires a session id", async () => {
    await assert.rejects(
      () => run({ args: ["stop"], flags: {}, config: {}, out }),
      /which session/
    );
  });

  it("stop on nonexistent session returns error code 1", async () => {
    const result = await run({
      args: ["stop", "nonexistent-session"],
      flags: {},
      config: {},
      out,
    });
    assert.strictEqual(result, 1);
  });

  it("stop help shows usage", async () => {
    const messages = [];
    const testOut = {
      init: async (_data, render) => {
        messages.push(await render());
      },
    };
    await run({ args: ["stop", "--help"], flags: {}, config: {}, out: testOut });
    const text = messages[messages.length - 1];
    assert.ok(text.includes("stop"));
  });
});
