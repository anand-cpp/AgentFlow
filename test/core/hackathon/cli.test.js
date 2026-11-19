// Hackathon CLI command tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Test the command module loads and exports correctly.
import { run } from "../../../src/commands/hackathon.js";

describe("hackathon CLI", () => {
  it("exports a run function", () => {
    assert.strictEqual(typeof run, "function");
  });

  it("shows help for unknown subcommand", async () => {
    const messages = [];
    const out = {
      init: async (_data, render) => {
        messages.push(await render());
      },
    };
    const result = await run({ args: ["help"], flags: {}, config: {}, out });
    assert.strictEqual(result, 0);
    assert.ok(messages.length > 0);
    const text = messages[0];
    assert.ok(text.includes("hackathon"), "output should mention hackathon");
    assert.ok(text.includes("start"), "output should list start subcommand");
  });

  it("throws usage error for start without a project idea", async () => {
    const out = {
      init: async () => {},
    };
    await assert.rejects(
      () => run({ args: ["start"], flags: {}, config: {}, out }),
      /which project/
    );
  });
});
