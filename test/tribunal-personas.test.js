// Persona assignment tests.
//
// Personas are configured data (not cloud models) that Forge applies as a
// system-prompt modifier so every candidate is examined through a distinct
// lens.
import test from "node:test";
import assert from "node:assert/strict";

import {
  PERSONA_ELEGANCE,
  PERSONA_PERFORMANCE,
  PERSONA_DEFENSIVE,
  PERSONA_SECURITY,
  PERSONA_IDS,
  PERSONAS,
  loadPersonas,
  assignPersona,
  personaPromptModifier,
} from "../src/core/tribunal/personas.js";
import { runSelfAdversarialStage } from "../src/core/tribunal/stage.js";

function queueComplete(responses) {
  const calls = [];
  const fn = async (_config, _modelId, _prompt, opts) => {
    calls.push({ system: opts?.system });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { text: typeof next === "string" ? next : JSON.stringify(next) };
  };
  return { fn, calls };
}

function review() {
  return {
    schemaVersion: 1,
    candidateId: "c1",
    originalApproach: "approach",
    strongestCounterArgument: "counter",
    failureHypotheses: [
      { statement: "a", severity: "high", category: "correctness", evidence: "reproduced", reproduction: "repro" },
    ],
    assumptions: [],
    missingEvidence: [],
    securityWeaknesses: [],
    logicRisks: [],
    edgeCases: [],
    performanceConcerns: [],
    proposedTests: [],
    confidenceBefore: 0.8,
    confidenceAfter: 0.5,
    confidenceJustification: "reproduced failure",
    decision: "RETAIN_WITH_EVIDENCE",
    revisedApproach: null,
  };
}

test("loadPersonas returns the built-in set with no config", () => {
  const personas = loadPersonas();
  assert.ok(personas[PERSONA_ELEGANCE]);
  assert.ok(personas[PERSONA_PERFORMANCE]);
  assert.ok(personas[PERSONA_DEFENSIVE]);
  assert.ok(personas[PERSONA_SECURITY]);
  assert.deepEqual(Object.keys(personas).sort(), [...PERSONA_IDS].sort());
});

test("loadPersonas overrides built-ins and accepts new personas from config", () => {
  const personas = loadPersonas({
    personas: {
      [PERSONA_ELEGANCE]: { id: PERSONA_ELEGANCE, name: "Elegant", modifier: "override" },
      bespoke: { id: "bespoke", name: "Bespoke", modifier: "a new lens" },
    },
  });
  assert.equal(personas[PERSONA_ELEGANCE].name, "Elegant");
  assert.equal(personas[PERSONA_ELEGANCE].modifier, "override");
  assert.ok(personas.bespoke);
  assert.equal(personas.bespoke.modifier, "a new lens");
  // Other built-ins are retained alongside overrides and additions.
  assert.ok(PERSONA_PERFORMANCE in personas);
  assert.equal(personas[PERSONA_PERFORMANCE].id, PERSONA_PERFORMANCE);
});

test("loadPersonas ignores malformed config entries", () => {
  const personas = loadPersonas({
    personas: {
      [PERSONA_SECURITY]: { id: PERSONA_SECURITY }, // missing name/modifier
      broken: "not an object",
      [PERSONA_DEFENSIVE]: { id: PERSONA_DEFENSIVE, name: "D", modifier: "d" },
    },
  });
  assert.ok(personas[PERSONA_SECURITY], "malformed entry keeps built-in");
  assert.equal(personas[PERSONA_SECURITY].modifier, PERSONAS[PERSONA_SECURITY].modifier);
  assert.ok(!personas.broken, "string entry dropped");
  assert.equal(personas[PERSONA_DEFENSIVE].modifier, "d");
});

test("PERSONA_IDS lists the four built-ins", () => {
  assert.deepEqual(PERSONA_IDS, [
    PERSONA_ELEGANCE,
    PERSONA_PERFORMANCE,
    PERSONA_DEFENSIVE,
    PERSONA_SECURITY,
  ]);
});

test("assignPersona round-robins deterministically over the registry", () => {
  const personas = { a: { id: "a", name: "A", modifier: "a" }, b: { id: "b", name: "B", modifier: "b" }, c: { id: "c", name: "C", modifier: "c" } };
  assert.equal(assignPersona({}, 0, personas).id, "a");
  assert.equal(assignPersona({}, 1, personas).id, "b");
  assert.equal(assignPersona({}, 2, personas).id, "c");
  assert.equal(assignPersona({}, 3, personas).id, "a"); // wraps around
  assert.equal(assignPersona({}, 0, {}), null, "empty registry returns null");
});

test("personaPromptModifier returns the modifier or empty string", () => {
  assert.equal(personaPromptModifier(PERSONAS[PERSONA_SECURITY]), PERSONAS[PERSONA_SECURITY].modifier);
  assert.equal(personaPromptModifier({}), "");
  assert.equal(personaPromptModifier(null), "");
  assert.equal(personaPromptModifier(undefined), "");
});

test("Forge assigns a distinct persona to each candidate and records it", async () => {
  const responses = [review(), review(), review(), review()];
  const { fn, calls } = queueComplete(responses);
  const result = await runSelfAdversarialStage({
    candidates: [
      { id: "c1", model: "m1", approach: "one" },
      { id: "c2", model: "m2", approach: "two" },
      { id: "c3", model: "m3", approach: "three" },
      { id: "c4", model: "m4", approach: "four" },
    ],
    complete: fn,
  });
  assert.equal(calls.length, 4);
  const personaIds = result.candidates.map((c) => c.personaId);
  assert.equal(personaIds.length, 4);
  // Round-robin over 4 personas -> each candidate gets a different one.
  assert.deepEqual(new Set(personaIds).size, 4, "distinct candidates get distinct personas");
  // Every review's system prompt carries the base prompt plus a modifier.
  assert.ok(calls.every((c) => c.system.includes("You are a hostile but fair reviewer")));
  assert.ok(calls.every((c) => c.system.length > PERSONAS[PERSONA_ELEGANCE].modifier.length));
});

test("Forge persona assignment is deterministic for the same index", async () => {
  const responses = [review(), review()];
  const { fn: fn1 } = queueComplete(responses);
  const r1 = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "x" }, { id: "c2", model: "m2", approach: "y" }],
    complete: fn1,
  });
  const { fn: fn2 } = queueComplete(responses);
  const r2 = await runSelfAdversarialStage({
    candidates: [{ id: "c1", model: "m1", approach: "x" }, { id: "c2", model: "m2", approach: "y" }],
    complete: fn2,
  });
  assert.deepEqual(
    r1.candidates.map((c) => c.personaId),
    r2.candidates.map((c) => c.personaId),
    "same index -> same persona across runs",
  );
});
