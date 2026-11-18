// Hackathon CLI status/tasks/workers integration tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../../../src/commands/hackathon.js";

const out = {
  init: async () => {},
};

describe("hackathon CLI status/tasks/workers", () => {
  it("status on nonexistent session returns error code 1", async () => {
    const result = await run({
      args: ["status", "nonexistent-session"],
      flags: {},
      config: {},
      out,
    });
    assert.strictEqual(result, 1);
  });

  it("workers on nonexistent session returns error code 1", async () => {
    const result = await run({
      args: ["workers", "nonexistent-session"],
      flags: {},
      config: {},
      out,
    });
    assert.strictEqual(result, 1);
  });

  it("tasks on nonexistent session returns error code 1", async () => {
    const result = await run({
      args: ["tasks", "nonexistent-session"],
      flags: {},
      config: {},
      out,
    });
    assert.strictEqual(result, 1);
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

  it("report on nonexistent session returns error code 1", async () => {
    const result = await run({
      args: ["report", "nonexistent-session"],
      flags: {},
      config: {},
      out,
    });
    assert.strictEqual(result, 1);
  });

  it("start returns success with session info", async () => {
    const messages = [];
    const testOut = {
      init: async (_data, render) => {
        messages.push(await render());
      },
    };

    const result = await run({
      args: ["start", "test project"],
      flags: { "leader-id": "leader-1", workspace: "/tmp" },
      config: {},
      out: testOut,
    });
    assert.strictEqual(result, 0);

    const startText = messages[messages.length - 1];
    assert.ok(startText.includes("session started"));
    assert.ok(startText.includes("session:"));
    assert.ok(startText.includes("worker invitation"));
  });

  it("help shows all flags", async () => {
    const messages = [];
    const testOut = {
      init: async (_data, render) => {
        messages.push(await render());
      },
    };
    await run({ args: ["help"], flags: {}, config: {}, out: testOut });
    const text = messages[messages.length - 1];
    assert.ok(text.includes("--leader-id"));
    assert.ok(text.includes("--workspace"));
  });
});
