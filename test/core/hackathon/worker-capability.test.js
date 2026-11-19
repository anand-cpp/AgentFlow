// Worker capability advertisement tests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkerRuntime } from "../../../src/core/hackathon/worker.js";

describe("Worker capability advertisement", () => {
  it("advertises default capabilities", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    const caps = worker._getCapabilities();
    assert.ok(Array.isArray(caps));
    assert.ok(caps.includes("filesystem"));
    assert.ok(caps.includes("shell"));
    assert.ok(caps.includes("node"));
    assert.ok(caps.includes("plan")); // default mode
  });

  it("advertises mode-specific capability", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
      mode: "build",
    });
    const caps = worker._getCapabilities();
    assert.ok(caps.includes("build"));
  });

  it("capabilities are unique", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    const caps = worker._getCapabilities();
    const unique = new Set(caps);
    assert.strictEqual(unique.size, caps.length);
  });

  it("getTasks returns empty before any tasks", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    assert.deepStrictEqual(worker.getTasks(), []);
  });

  it("getCurrentTask returns null before any task", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    assert.strictEqual(worker.getCurrentTask(), null);
  });

  it("connected and registered start false", () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    assert.strictEqual(worker.connected, false);
    assert.strictEqual(worker.registered, false);
  });

  it("disconnect sets connected to false", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    worker._connected = true;
    await worker.disconnect();
    assert.strictEqual(worker.connected, false);
  });

  it("reconnect sets connected to true", async () => {
    const worker = new WorkerRuntime({
      workerId: "worker-1",
      sessionId: "sess-1",
    });
    worker._connected = false;
    await worker.reconnect();
    assert.strictEqual(worker.connected, true);
  });
});
