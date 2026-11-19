// Task graph tests — validates versioned contracts and dependency graph.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TaskContract, TaskGraph } from "../../../src/core/hackathon/task-graph.js";

describe("TaskGraph", () => {
  it("adds and retrieves a contract", () => {
    const g = new TaskGraph();
    const c = new TaskContract({
      taskId: "task-1",
      title: "Add endpoint",
      objective: "Create a health check endpoint",
      assignedWorkerId: "worker-1",
    });
    g.upsert(c);
    const got = g.get("task-1");
    assert.ok(got);
    assert.strictEqual(got.title, "Add endpoint");
    assert.strictEqual(got.version, 1);
  });

  it("increments version on update and preserves history", () => {
    const g = new TaskGraph();
    const c1 = new TaskContract({
      taskId: "task-1",
      title: "v1",
      objective: "original",
      assignedWorkerId: "worker-1",
    });
    g.upsert(c1);
    const c2 = new TaskContract({
      taskId: "task-1",
      title: "v2",
      objective: "updated",
      assignedWorkerId: "worker-1",
    });
    g.upsert(c2);
    const latest = g.get("task-1");
    assert.strictEqual(latest.version, 2);
    assert.strictEqual(latest.title, "v2");
    const hist = g.history("task-1");
    assert.strictEqual(hist.length, 1);
    assert.strictEqual(hist[0].version, 1);
    assert.strictEqual(hist[0].title, "v1");
  });

  it("detects dependency cycles", () => {
    const g = new TaskGraph();
    g.upsert(new TaskContract({
      taskId: "a", title: "A", objective: "a", dependencies: ["b"],
    }));
    g.upsert(new TaskContract({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
    }));
    const cycle = g.detectCycle();
    assert.ok(cycle);
    assert.ok(cycle.includes("a"));
    assert.ok(cycle.includes("b"));
  });

  it("reports no cycle for a DAG", () => {
    const g = new TaskGraph();
    g.upsert(new TaskContract({
      taskId: "a", title: "A", objective: "a", dependencies: [],
    }));
    g.upsert(new TaskContract({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
    }));
    assert.strictEqual(g.detectCycle(), null);
  });

  it("lists ready tasks (no unsatisfied deps)", () => {
    const g = new TaskGraph();
    g.upsert(new TaskContract({
      taskId: "a", title: "A", objective: "a", dependencies: [], state: "pending",
    }));
    g.upsert(new TaskContract({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"], state: "pending",
    }));
    g.upsert(new TaskContract({
      taskId: "c", title: "C", objective: "c", dependencies: ["a", "b"], state: "pending",
    }));
    const states = { a: "completed" };
    const ready = g.ready(states);
    assert.ok(ready.includes("b"));
    assert.ok(!ready.includes("c")); // b not done yet
  });

  it("returns dependents of a task", () => {
    const g = new TaskGraph();
    g.upsert(new TaskContract({
      taskId: "a", title: "A", objective: "a", dependencies: [],
    }));
    g.upsert(new TaskContract({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
    }));
    g.upsert(new TaskContract({
      taskId: "c", title: "C", objective: "c", dependencies: ["a"],
    }));
    const deps = g.dependentsOf("a");
    assert.ok(deps.includes("b"));
    assert.ok(deps.includes("c"));
  });

  it("returns affected workers for a task change", () => {
    const g = new TaskGraph();
    g.upsert(new TaskContract({
      taskId: "a", title: "A", objective: "a", dependencies: [],
      assignedWorkerId: "worker-1",
    }));
    g.upsert(new TaskContract({
      taskId: "b", title: "B", objective: "b", dependencies: ["a"],
      assignedWorkerId: "worker-2",
    }));
    const affected = g.affectedWorkers("a");
    assert.ok(affected.includes("worker-1"));
    assert.ok(affected.includes("worker-2"));
  });

  it("removes a contract", () => {
    const g = new TaskGraph();
    g.upsert(new TaskContract({
      taskId: "a", title: "A", objective: "a", dependencies: [],
    }));
    g.remove("a");
    assert.strictEqual(g.get("a"), undefined);
    assert.deepStrictEqual(g.history("a"), []);
  });
});
