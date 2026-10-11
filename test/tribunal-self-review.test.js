// Self-review execution tests.
//
// These drive runSelfReview with a fake `complete` so the module can be tested
// without a provider. What they check is the contract the stage depends on:
// identity-blind prompts, safe parsing, fail-closed validation, and redaction
// before the review leaves the module.

import test from "node:test";
import assert from "node:assert/strict";
import {
  SELF_REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  parseReview,
  runSelfReview,
} from "../src/core/tribunal/self-review.js";
import { SELF_REVIEW_SCHEMA_VERSION } from "../src/core/tribunal/review-schema.js";

function validReview(overrides = {}) {
  return {
    schemaVersion: SELF_REVIEW_SCHEMA_VERSION,
    candidateId: "c1",
    originalApproach: "return the first row",
    strongestCounterArgument: "empty input has no first row",
    failureHypotheses: [
      { statement: "throws on empty", severity: "high", category: "correctness", evidence: "reproduced", reproduction: "f('') -> TypeError" },
      { statement: "unicode", severity: "low", category: "edge_case", evidence: "hypothesis", reproduction: null },
      { statement: "slow", severity: "low", category: "performance", evidence: "hypothesis", reproduction: null },
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
    decision: "REVISE",
    revisedApproach: "guard empty input",
    ...overrides,
  };
}

function asComplete(value) {
  return async () => ({ text: typeof value === "string" ? value : JSON.stringify(value) });
}

test("parseReview reads a bare JSON object surrounded by prose", () => {
  const parsed = parseReview(`Sure, here you go:\n${JSON.stringify(validReview())}\nHope that helps.`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.candidateId, "c1");
});

test("parseReview reads a fenced code block", () => {
  const parsed = parseReview("```json\n" + JSON.stringify(validReview()) + "\n```");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.decision, "REVISE");
});

test("parseReview fails cleanly on non-JSON", () => {
  assert.equal(parseReview("I refuse to answer").ok, false);
  assert.equal(parseReview("").ok, false);
});

test("parseReview fails cleanly on malformed JSON", () => {
  const parsed = parseReview("{ this is not json }");
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /JSON/);
});

test("the review prompt contains the proposal but not its author", () => {
  const candidate = {
    id: "c1",
    model: "secret-author-model-id",
    approach: "UNIQUE_APPROACH_MARKER",
    rationale: "because reasons",
  };
  const prompt = buildReviewPrompt({ candidate, schemaVersion: SELF_REVIEW_SCHEMA_VERSION });
  assert.ok(prompt.includes("UNIQUE_APPROACH_MARKER"));
  assert.ok(!prompt.includes("secret-author-model-id"), "authorship must not leak into the prompt");
});

test("runSelfReview returns a validated, redacted review", async () => {
  const seen = {};
  const complete = async (config, modelId, prompt, opts) => {
    seen.modelId = modelId;
    seen.system = opts.system;
    seen.prompt = prompt;
    return { text: JSON.stringify(validReview()) };
  };
  const result = await runSelfReview({ complete, modelId: "gpt-like", candidate: { id: "c1", approach: "x" } });
  assert.equal(result.ok, true);
  assert.equal(result.review.candidateId, "c1");
  assert.deepEqual(result.errors, []);
  assert.equal(seen.modelId, "gpt-like");
  assert.equal(seen.system, SELF_REVIEW_SYSTEM_PROMPT);
});

test("runSelfReview redacts secrets that appear in the model output", async () => {
  const review = validReview({ confidenceJustification: "leaked sk-abcdef0123456789ABCDEF ok" });
  const result = await runSelfReview({ complete: asComplete(review), modelId: "m", candidate: { id: "c1", approach: "x" } });
  assert.equal(result.ok, true);
  assert.ok(!result.review.confidenceJustification.includes("abcdef0123456789ABCDEF"));
});

test("runSelfReview fails closed on an invalid schema", async () => {
  const result = await runSelfReview({
    complete: asComplete(validReview({ decision: "MAYBE" })),
    modelId: "m",
    candidate: { id: "c1", approach: "x" },
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("runSelfReview fails closed when the model returns non-JSON", async () => {
  const result = await runSelfReview({ complete: asComplete("no json here"), modelId: "m", candidate: { id: "c1", approach: "x" } });
  assert.equal(result.ok, false);
});

test("runSelfReview reports a thrown call as a failure, not a crash", async () => {
  const complete = async () => {
    throw new Error("gateway unreachable");
  };
  const result = await runSelfReview({ complete, modelId: "m", candidate: { id: "c1", approach: "x" } });
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes("gateway unreachable"));
});

test("runSelfReview refuses to run without the required inputs", async () => {
  assert.equal((await runSelfReview({ modelId: "m", candidate: { id: "c1" } })).ok, false);
  assert.equal((await runSelfReview({ complete: asComplete(validReview()), candidate: { id: "c1" } })).ok, false);
  assert.equal((await runSelfReview({ complete: asComplete(validReview()), modelId: "m" })).ok, false);
});
