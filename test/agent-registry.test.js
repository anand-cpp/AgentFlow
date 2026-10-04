// Agent registry and declaration validation.
//
// The registry is the foundation everything else stands on: if a declaration can
// be malformed, the runtime's decisions downstream are all suspect. These tests
// are therefore mostly about what is REJECTED.
//
// Credential fixtures are assembled from fragments at runtime. A literal
// secret-shaped string in a test file is exactly what scan-secrets.mjs exists to
// prevent, and a fixture that only looks safe in review is a fixture that gets
// committed.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentRegistry,
  defineAgent,
  AgentDefinitionError,
  AgentNotFoundError,
  AgentConflictError,
  CAPABILITY,
  TOOL_SCOPE,
  AGENT_STATE,
  LIMITS,
} from "../src/core/agents/registry.js";
import { redact } from "../src/core/redact.js";

/** A minimal valid declaration. Tests override only the field under test. */
function spec(over = {}) {
  return {
    id: "coder",
    name: "Coder",
    purpose: "implement changes",
    instructions: "Implement the change described in the task.",
    capabilities: [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test("a minimal declaration registers and round-trips", () => {
  const def = defineAgent(spec());
  assert.equal(def.id, "coder");
  assert.equal(def.name, "Coder");
  assert.deepEqual([...def.capabilities], [CAPABILITY.CODING, CAPABILITY.TOOL_CALLING]);
});

test("name defaults to the id when omitted", () => {
  assert.equal(defineAgent(spec({ name: undefined })).name, "coder");
});

test("omitted policy sections become documented defaults, not undefined", () => {
  const def = defineAgent(spec());
  assert.deepEqual(def.model.requireCapabilities, []);
  assert.equal(def.model.maxTokens, 4096);
  assert.equal(def.routing.allowFallback, true);
  assert.deepEqual(def.tools.scopes, []);
  assert.equal(def.bounds.maxIterations, LIMITS.maxIterations);
  assert.equal(def.failure.maxRetries, LIMITS.maxRetries);
});

test("lifecycle hooks may be supplied as functions", () => {
  const prepare = () => "prepared";
  const def = defineAgent(spec({ lifecycle: { prepare } }));
  assert.equal(def.lifecycle.prepare, prepare);
});

test("a returned definition is frozen so a holder cannot mutate what is registered", () => {
  const def = defineAgent(spec());
  assert.throws(() => {
    "use strict";
    def.id = "hijacked";
  }, TypeError);
  assert.throws(() => def.capabilities.push(CAPABILITY.REASONING), TypeError);
});

// ---------------------------------------------------------------------------
// identity validation
// ---------------------------------------------------------------------------

test("id must be lowercase alphanumeric with separators", () => {
  for (const bad of ["Coder", "1coder", "coder!", "coder--x", "-coder", ""]) {
    assert.throws(() => defineAgent(spec({ id: bad })), AgentDefinitionError, `id ${JSON.stringify(bad)} should be rejected`);
  }
});

test("surrounding whitespace on an id is trimmed rather than rejected", () => {
  // Trimming is friendlier than failing, and a trailing space in a config file is
  // a typo rather than an intent to name a different agent.
  assert.equal(defineAgent(spec({ id: "  coder  " })).id, "coder");
});

test("acceptable ids are accepted", () => {
  for (const good of ["coder", "release", "security-reviewer", "test_runner", "a1"]) {
    assert.equal(defineAgent(spec({ id: good })).id, good);
  }
});

test("missing required fields are named in the error", () => {
  for (const field of ["id", "purpose", "instructions"]) {
    const bad = spec();
    delete bad[field];
    assert.throws(
      () => defineAgent(bad),
      (err) => {
        assert.ok(err instanceof AgentDefinitionError);
        assert.equal(err.field, field);
        return true;
      },
      `${field} should be required`
    );
  }
});

test("whitespace-only required fields are rejected rather than trimmed to nothing", () => {
  assert.throws(() => defineAgent(spec({ purpose: "   " })), AgentDefinitionError);
});

test("oversized fields are rejected with the limit stated", () => {
  assert.throws(
    () => defineAgent(spec({ purpose: "x".repeat(5000) })),
    (err) => {
      assert.match(err.message, /purpose exceeds 400 characters/);
      return true;
    }
  );
});

test("a non-object definition is rejected", () => {
  for (const bad of [null, undefined, "coder", 42, []]) {
    assert.throws(() => defineAgent(bad), AgentDefinitionError);
  }
});

// ---------------------------------------------------------------------------
// closed vocabularies
// ---------------------------------------------------------------------------

test("an unknown capability is rejected at registration, not left to fail downstream", () => {
  assert.throws(
    () => defineAgent(spec({ capabilities: ["codeing"] })),
    (err) => {
      assert.match(err.message, /unknown value: codeing/);
      assert.match(err.message, /allowed:/);
      return true;
    }
  );
});

test("every declared capability is accepted", () => {
  const all = Object.values(CAPABILITY);
  assert.deepEqual([...defineAgent(spec({ capabilities: all })).capabilities], all);
});

test("capabilities must be an array of non-empty strings", () => {
  assert.throws(() => defineAgent(spec({ capabilities: "coding" })), AgentDefinitionError);
  assert.throws(() => defineAgent(spec({ capabilities: ["coding", ""] })), AgentDefinitionError);
  assert.throws(() => defineAgent(spec({ capabilities: [42] })), AgentDefinitionError);
});

test("duplicate capabilities collapse rather than double-counting", () => {
  const def = defineAgent(spec({ capabilities: [CAPABILITY.CODING, CAPABILITY.CODING] }));
  assert.deepEqual([...def.capabilities], [CAPABILITY.CODING]);
});

test("an unknown tool scope is rejected", () => {
  assert.throws(() => defineAgent(spec({ tools: { scopes: ["sudo"] } })), AgentDefinitionError);
});

test("tool scopes may be given as a bare array", () => {
  const def = defineAgent(spec({ tools: [TOOL_SCOPE.READ, TOOL_SCOPE.WRITE] }));
  assert.deepEqual(def.tools.scopes, [TOOL_SCOPE.READ, TOOL_SCOPE.WRITE]);
});

// ---------------------------------------------------------------------------
// bounded work: an agent may ask for less, never for unbounded
// ---------------------------------------------------------------------------

test("bounds may be tightened below the runtime default", () => {
  const def = defineAgent(spec({ bounds: { maxIterations: 3, timeoutMs: 5000 } }));
  assert.equal(def.bounds.maxIterations, 3);
  assert.equal(def.bounds.timeoutMs, 5000);
});

test("bounds cannot exceed the runtime ceilings", () => {
  assert.throws(() => defineAgent(spec({ bounds: { maxIterations: 10_000 } })), AgentDefinitionError);
  assert.throws(() => defineAgent(spec({ bounds: { timeoutMs: 999_999_999 } })), AgentDefinitionError);
  assert.throws(() => defineAgent(spec({ bounds: { maxToolCalls: 1e9 } })), AgentDefinitionError);
});

test("zero tool calls is allowed -- some agents legitimately need none", () => {
  assert.equal(defineAgent(spec({ bounds: { maxToolCalls: 0 } })).bounds.maxToolCalls, 0);
});

test("a negative or fractional bound is rejected", () => {
  assert.throws(() => defineAgent(spec({ bounds: { maxIterations: -1 } })), AgentDefinitionError);
  assert.throws(() => defineAgent(spec({ bounds: { maxIterations: 2.5 } })), AgentDefinitionError);
});

// ---------------------------------------------------------------------------
// model policy
// ---------------------------------------------------------------------------

test("a bare model string pins one model", () => {
  const def = defineAgent(spec({ model: "oc/muse" }));
  assert.equal(def.model.pinModel, "oc/muse");
});

test("pinning a model and also requiring capabilities is contradictory and rejected", () => {
  assert.throws(
    () => defineAgent(spec({ model: { pinModel: "oc/muse", requireCapabilities: [CAPABILITY.CODING] } })),
    (err) => {
      assert.match(err.message, /mutually exclusive/);
      return true;
    }
  );
});

test("model requirements use the closed capability vocabulary", () => {
  assert.throws(
    () => defineAgent(spec({ model: { requireCapabilities: ["speed"] } })),
    AgentDefinitionError
  );
});

test("temperature outside 0..2 is rejected", () => {
  assert.throws(() => defineAgent(spec({ model: { temperature: 5 } })), AgentDefinitionError);
  assert.equal(defineAgent(spec({ model: { temperature: 0 } })).model.temperature, 0);
});

// ---------------------------------------------------------------------------
// tool policy
// ---------------------------------------------------------------------------

test("tool policy is an explicit allowlist, never a denylist", () => {
  const def = defineAgent(spec({ tools: { scopes: [TOOL_SCOPE.READ], requireApproval: ["shell"] } }));
  // Nothing outside the declared scopes is granted, and `deny` is optional.
  assert.deepEqual(def.tools.scopes, [TOOL_SCOPE.READ]);
  assert.deepEqual(def.tools.requireApproval, ["shell"]);
  assert.deepEqual(def.tools.deny, []);
});

test("a tool policy that is neither array nor object is rejected", () => {
  assert.throws(() => defineAgent(spec({ tools: "read" })), AgentDefinitionError);
});

test("lifecycle hooks must be functions", () => {
  assert.throws(() => defineAgent(spec({ lifecycle: { prepare: "nope" } })), AgentDefinitionError);
});

// ---------------------------------------------------------------------------
// task contracts
// ---------------------------------------------------------------------------

test("input and output contracts accept the object form", () => {
  const def = defineAgent(
    spec({
      input: { task: { type: "string", required: true, maxLength: 4000 } },
      output: { summary: { type: "string", required: true } },
    })
  );
  assert.equal(def.input.fields.length, 1);
  assert.equal(def.input.fields[0].name, "task");
  assert.equal(def.input.fields[0].required, true);
  assert.equal(def.input.fields[0].maxLength, 4000);
});

test("contracts accept the array form", () => {
  const def = defineAgent(spec({ input: [{ name: "task", type: "string", required: true }] }));
  assert.equal(def.input.fields[0].name, "task");
});

test("a contract field with an unknown type is rejected", () => {
  assert.throws(() => defineAgent(spec({ output: { x: { type: "blob" } } })), AgentDefinitionError);
});

test("a contract field with an invalid name is rejected", () => {
  assert.throws(() => defineAgent(spec({ input: { "9lives": { type: "string" } } })), AgentDefinitionError);
});

test("unknownFields defaults to reject and can be relaxed explicitly", () => {
  assert.equal(defineAgent(spec()).input.unknownFields, "reject");
  assert.equal(defineAgent(spec({ input: { unknownFields: "ignore" } })).input.unknownFields, "ignore");
  assert.throws(() => defineAgent(spec({ input: { unknownFields: "maybe" } })), AgentDefinitionError);
});

// ---------------------------------------------------------------------------
// credential boundary
// ---------------------------------------------------------------------------

test("a credential-shaped value in instructions is refused at registration", () => {
  // Assembled from fragments so this file itself stays scanner-clean.
  // The github-token pattern is a prefix plus 20 or more characters.
  const token = ["gh", "p", "_", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("");
  assert.match(redact(token), /\*\*\*/, "fixture must actually be credential-shaped");
  assert.throws(
    () => defineAgent(spec({ instructions: `Call the API with ${token} in the Authorization header.` })),
    (err) => {
      assert.ok(err instanceof AgentDefinitionError);
      assert.match(err.message, /credential-shaped/);
      return true;
    }
  );
});

test("a credential-shaped value in a tool allowlist is refused", () => {
  // The AIza pattern is the prefix plus exactly 35 characters.
  const key = ["AIza", "SyD9f2kLmN0pQrStUvWxYzAbCdEfGhJkLnO"].join("");
  assert.match(redact(key), /AIza\*\*\*/, "fixture must actually be credential-shaped");
  assert.throws(() => defineAgent(spec({ tools: { allow: [`script --key ${key}`] } })), AgentDefinitionError);
});

test("instructions that merely discuss tokens are not false-positived", () => {
  // A definition that documents credential handling must still load, or the gate
  // is unusable for the Security agent in particular.
  const def = defineAgent(
    spec({ instructions: "Never echo the authorization header. If a token appears in a response, redact it before recording." })
  );
  assert.match(def.instructions, /Never echo/);
});

// ---------------------------------------------------------------------------
// registry behaviour
// ---------------------------------------------------------------------------

test("an empty registry reports nothing and finds nothing", () => {
  const reg = new AgentRegistry();
  assert.equal(reg.size, 0);
  assert.deepEqual(reg.ids(), []);
  assert.equal(reg.find("nope"), null);
  assert.equal(reg.has("nope"), false);
});

test("register returns the validated definition", () => {
  const reg = new AgentRegistry();
  const def = reg.register(spec());
  assert.equal(reg.get("coder"), def);
  assert.equal(reg.has("coder"), true);
});

test("registerAll registers in order", () => {
  const reg = new AgentRegistry();
  reg.registerAll([spec({ id: "planner" }), spec({ id: "coder" })]);
  assert.deepEqual(reg.ids(), ["coder", "planner"]);
});

test("a duplicate id is a conflict rather than a silent replace", () => {
  const reg = new AgentRegistry([spec({ purpose: "first" })]);
  assert.throws(() => reg.register(spec({ purpose: "second" })), AgentConflictError);
  // The original must survive untouched.
  assert.equal(reg.get("coder").purpose, "first");
});

test("unknown agent names the alternatives", () => {
  const reg = new AgentRegistry([spec({ id: "coder" }), spec({ id: "planner", name: "Planner" })]);
  assert.throws(
    () => reg.get("reviewe"),
    (err) => {
      assert.ok(err instanceof AgentNotFoundError);
      assert.equal(err.code, "agent_not_found");
      assert.match(err.message, /known agents: coder, planner/);
      return true;
    }
  );
});

test("an empty registry says nothing about known agents", () => {
  assert.throws(() => new AgentRegistry().get("x"), /no such agent: x$/);
});

test("lookup trims whitespace so a stray space is not a different agent", () => {
  const reg = new AgentRegistry([spec()]);
  assert.equal(reg.get("  coder  ").id, "coder");
});

test("list is sorted by id for stable output", () => {
  const reg = new AgentRegistry([spec({ id: "release" }), spec({ id: "coder" }), spec({ id: "planner" })]);
  assert.deepEqual(reg.list().map((a) => a.id), ["coder", "planner", "release"]);
});

test("byCapability finds every agent that declares it", () => {
  const reg = new AgentRegistry([
    spec({ id: "coder", capabilities: [CAPABILITY.CODING] }),
    spec({ id: "planner", capabilities: [CAPABILITY.PLANNING, CAPABILITY.REASONING] }),
    spec({ id: "reviewer", capabilities: [CAPABILITY.REASONING] }),
  ]);
  assert.deepEqual(reg.byCapability(CAPABILITY.REASONING).map((a) => a.id), ["planner", "reviewer"]);
  assert.deepEqual(reg.byCapability(CAPABILITY.NETWORK || "network").map((a) => a.id), []);
});

test("unregister removes an agent", () => {
  const reg = new AgentRegistry([spec()]);
  assert.equal(reg.unregister("coder"), true);
  assert.equal(reg.unregister("coder"), false);
  assert.equal(reg.size, 0);
});

test("two registries are independent, so one agent id cannot leak between them", () => {
  const a = new AgentRegistry([spec({ id: "coder" })]);
  const b = new AgentRegistry();
  assert.equal(b.has("coder"), false);
  b.register(spec({ id: "coder", purpose: "different" }));
  assert.notEqual(a.get("coder").purpose, b.get("coder").purpose);
});

// ---------------------------------------------------------------------------
// lifecycle vocabulary
// ---------------------------------------------------------------------------

test("the lifecycle states are the documented set", () => {
  assert.deepEqual(Object.values(AGENT_STATE).sort(), [
    "cancelled",
    "completed",
    "context_loading",
    "created",
    "failed",
    "running",
    "timed_out",
    "waiting_approval",
  ]);
});