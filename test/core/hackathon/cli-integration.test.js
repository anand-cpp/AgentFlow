// Hackathon CLI integration tests — start and stop flow.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../../../src/commands/hackathon.js";

describe("hackathon CLI integration", () => {
  it("start creates a session and returns session id", async () => {
    const messages = [];
    const out = {
      init: async (_data, render) => {
        messages.push(await render());
      },
    };
    const result = await run({
      args: ["start", "build a todo app"],
      flags: {
        "leader-id": "leader-1",
        workspace: "/tmp",
        "duration-hours": "24",
        "elapsed-hours": "2",
        teammates: "5",
      },
      config: {},
      out,
    });
    assert.strictEqual(result, 0);
    const text = messages[messages.length - 1];
    assert.ok(text.includes("session started"));
    assert.ok(text.includes("session:"));
  });

  it("start requires a project idea", async () => {
    await assert.rejects(
      () => run({ args: ["start"], flags: {}, config: {}, out: { init: async () => {} } }),
      /which project/
    );
  });

  it("status requires a session id", async () => {
    await assert.rejects(
      () => run({ args: ["status"], flags: {}, config: {}, out: { init: async () => {} } }),
      /which session/
    );
  });

  it("stop requires a session id", async () => {
    await assert.rejects(
      () => run({ args: ["stop"], flags: {}, config: {}, out: { init: async () => {} } }),
      /which session/
    );
  });

  it("report requires a session id", async () => {
    await assert.rejects(
      () => run({ args: ["report"], flags: {}, config: {}, out: { init: async () => {} } }),
      /which session/
    );
  });

  it("unknown subcommand throws usage error", async () => {
    await assert.rejects(
      () => run({ args: ["frobnicate"], flags: {}, config: {}, out: { init: async () => {} } }),
      /unknown subcommand/
    );
  });

  it("help output lists all subcommands", async () => {
    const messages = [];
    const out = {
      init: async (_data, render) => {
        messages.push(await render());
      },
    };
    const result = await run({ args: ["help"], flags: {}, config: {}, out });
    assert.strictEqual(result, 0);
    const text = messages[messages.length - 1];
    assert.ok(text.includes("start"));
    assert.ok(text.includes("status"));
    assert.ok(text.includes("workers"));
    assert.ok(text.includes("tasks"));
    assert.ok(text.includes("stop"));
    assert.ok(text.includes("report"));
  });
});
