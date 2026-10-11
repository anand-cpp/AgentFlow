// Merge (Stage 3) tests.
//
// Six layers, matching the task breakdown:
//   * schema      -- the contract and its audit invariants
//   * prompt      -- anonymity, labels, findings, domain framing
//   * execution   -- runMerge happy path and every failure path
//   * decision    -- the survival gate
//   * integration -- the stage's three outcomes
//   * extraction  -- pulling P0/P1 findings out of a Crucible result
//
// Every provider is a deterministic mock; no network, no credentials.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FINDING_RESOLUTION_STATUS,
  MERGE_DECISION,
  MERGE_SCHEMA_VERSION,
  findUnresolvedCriticalFindings,
  validateMergeReport,
} from "../src/core/tribunal/merge-schema.js";
import {
  INVALID_MERGE,
  buildMergePrompt,
  extractCriticalFindings,
  runMerge,
  shouldAttemptMerge,
} from "../src/core/tribunal/merge.js";
import { MERGE_STAGE, MERGE_STAGE_STATUS, runMergeStage } from "../src/core/tribunal/stage-merge.js";
import { CRUCIBLE_SEVERITY } from "../src/core/tribunal/crucible-schema.js";

const PROPOSAL_IDS = ["p1", "p2"];

function element(overrides = {}) {
  return {
    element_id: "e1",
    source_proposal_ids: ["p1"],
    rationale: "strongest of the two",
    addresses_findings: [],
    ...overrides,
  };
}

function resolution(overrides = {}) {
  return {
    finding_id: "f1",
    status: FINDING_RESOLUTION_STATUS.ADDRESSED,
    resolution: "the hybrid escapes the input before use",
    ...overrides,
  };
}

function mergeReport(overrides = {}) {
  return {
    schema_version: MERGE_SCHEMA_VERSION,
    decision: MERGE_DECISION.SYNTHESIZED,
    hybrid_solution: {
      content: "the hybrid solution",
      elements: [element({ addresses_findings: ["f1"] })],
    },
    findings_resolution: [resolution()],
    discarded_elements: [
      { source_proposal_id: "p2", element_summary: "a heavier abstraction", discard_reason: "added cost without benefit" },
    ],
    synthesis_notes: "took the parser from A and the retry policy from B",
    insufficiency_reason: null,
    ...overrides,
  };
}

function criticalFinding(overrides = {}) {
  return {
    id: "f1",
    severity: CRUCIBLE_SEVERITY.P0_CRITICAL,
    vector: "SECURITY",
    title: "injection",
    explanation: "input reaches the shell",
    ...overrides,
  };
}

function crucibleResult(results) {
  return { stage: "CRUCIBLE", results, summary: {}, completedAt: "2026-01-01T00:00:00.000Z" };
}

function queueComplete(responses) {
  const calls = [];
  const fn = async (config, modelId, prompt, opts) => {
    calls.push({ modelId, prompt, system: opts?.system });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { text: typeof next === "string" ? next : JSON.stringify(next) };
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// 4.1 Schema validation
// ---------------------------------------------------------------------------

test("a well-formed SYNTHESIZED report with full provenance validates", () => {
  const { valid, errors } = validateMergeReport(mergeReport(), PROPOSAL_IDS);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a SINGLE_PROPOSAL_RETAINED report still requires a hybrid", () => {
  const report = mergeReport({
    decision: MERGE_DECISION.SINGLE_PROPOSAL_RETAINED,
    hybrid_solution: { content: "the retained proposal", elements: [element({ source_proposal_ids: ["p1"] })] },
    findings_resolution: [resolution()],
  });
  assert.equal(validateMergeReport(report, PROPOSAL_IDS).valid, true);
  assert.equal(validateMergeReport({ ...report, hybrid_solution: null }, PROPOSAL_IDS).valid, false);
});

test("SYNTHESIZED without hybrid_solution is invalid", () => {
  const { valid, errors } = validateMergeReport(mergeReport({ hybrid_solution: null }), PROPOSAL_IDS);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("hybrid_solution is required")));
});

test("INSUFFICIENT_INPUT without insufficiency_reason is invalid", () => {
  const report = mergeReport({
    decision: MERGE_DECISION.INSUFFICIENT_INPUT,
    hybrid_solution: null,
    insufficiency_reason: null,
  });
  const { valid, errors } = validateMergeReport(report, PROPOSAL_IDS);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("insufficiency_reason is required")));
});

test("IRRECONCILABLE with a null hybrid and a reason is valid", () => {
  const report = mergeReport({
    decision: MERGE_DECISION.IRRECONCILABLE,
    hybrid_solution: null,
    findings_resolution: [],
    discarded_elements: [],
    insufficiency_reason: "one proposal mandates synchronous core, the other asynchronous",
  });
  assert.equal(validateMergeReport(report, PROPOSAL_IDS).valid, true);
});

test("IRRECONCILABLE that still carries a hybrid is invalid", () => {
  const report = mergeReport({ decision: MERGE_DECISION.IRRECONCILABLE, insufficiency_reason: "contradiction" });
  const { valid, errors } = validateMergeReport(report, PROPOSAL_IDS);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("hybrid_solution must be null")));
});

test("an element referencing a finding not in findings_resolution is invalid", () => {
  const report = mergeReport({ hybrid_solution: { content: "x", elements: [element({ addresses_findings: ["f9"] })] } });
  const { valid, errors } = validateMergeReport(report, PROPOSAL_IDS);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"f9" is not in findings_resolution')));
});

test("an element referencing a non-existent source_proposal_id is invalid", () => {
  const report = mergeReport({ hybrid_solution: { content: "x", elements: [element({ source_proposal_ids: ["p9"] })] } });
  const { valid, errors } = validateMergeReport(report, PROPOSAL_IDS);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"p9" is not one of the input proposals')));
});

test("a finding addressed by an element but DISPUTED in resolution is invalid", () => {
  const report = mergeReport({
    findings_resolution: [resolution({ status: FINDING_RESOLUTION_STATUS.DISPUTED })],
  });
  const { valid, errors } = validateMergeReport(report, PROPOSAL_IDS);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("is not marked ADDRESSED")));
});

test("a finding ACKNOWLEDGED_UNRESOLVED may not be cited as addressed either", () => {
  const report = mergeReport({
    findings_resolution: [resolution({ status: FINDING_RESOLUTION_STATUS.ACKNOWLEDGED_UNRESOLVED })],
  });
  assert.equal(validateMergeReport(report, PROPOSAL_IDS).valid, false);
});

test("unknown fields are rejected at every level", () => {
  assert.equal(validateMergeReport(mergeReport({ extra: 1 }), PROPOSAL_IDS).valid, false);
  const withBadElement = mergeReport({
    hybrid_solution: { content: "x", elements: [element({ note: "hi" })] },
  });
  assert.equal(validateMergeReport(withBadElement, PROPOSAL_IDS).valid, false);
  const withBadResolution = mergeReport({ findings_resolution: [resolution({ confidence: 0.9 })] });
  assert.equal(validateMergeReport(withBadResolution, PROPOSAL_IDS).valid, false);
});

test("validation never throws on garbage", () => {
  for (const input of [null, 42, "nope", [], { decision: "SYNTHESIZED" }]) {
    const result = validateMergeReport(input, PROPOSAL_IDS);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test("duplicate element ids and duplicate resolutions are rejected", () => {
  const dupElements = mergeReport({
    hybrid_solution: { content: "x", elements: [element({ element_id: "e1" }), element({ element_id: "e1" })] },
  });
  assert.equal(validateMergeReport(dupElements, PROPOSAL_IDS).valid, false);

  const dupResolutions = mergeReport({ findings_resolution: [resolution(), resolution()] });
  assert.equal(validateMergeReport(dupResolutions, PROPOSAL_IDS).valid, false);
});

test("findUnresolvedCriticalFindings names the findings a report left out", () => {
  const report = mergeReport({ findings_resolution: [resolution({ finding_id: "f1" })] });
  const { unresolved, resolved } = findUnresolvedCriticalFindings(report, [{ id: "f1" }, { id: "f2" }]);
  assert.deepEqual(resolved, ["f1"]);
  assert.deepEqual(unresolved, ["f2"]);
});

// ---------------------------------------------------------------------------
// 4.2 Prompt generation
// ---------------------------------------------------------------------------

test("author identity is stripped from every proposal", () => {
  const prompt = buildMergePrompt({
    proposals: [
      { id: "p1", approach: "APPROACH_ONE", model: "secret-model", provider: "acme", author: "alice" },
      { id: "p2", approach: "APPROACH_TWO", model: "other-model" },
    ],
    crucibleFindings: [],
  });
  assert.ok(prompt.includes("APPROACH_ONE"));
  assert.ok(prompt.includes("APPROACH_TWO"));
  for (const leak of ["secret-model", "other-model", "acme", "alice"]) {
    assert.ok(!prompt.includes(leak), `prompt must not leak "${leak}"`);
  }
});

test("proposals get anonymous labels while keeping their real ids", () => {
  const prompt = buildMergePrompt({
    proposals: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
    crucibleFindings: [],
  });
  assert.ok(prompt.includes("Proposal A"));
  assert.ok(prompt.includes("Proposal B"));
  assert.ok(prompt.includes("Proposal C"));
  assert.ok(prompt.includes("(id: p1)"));
  assert.ok(prompt.includes("(id: p3)"));
});

test("P0 and P1 findings are included with their ids", () => {
  const prompt = buildMergePrompt({
    proposals: [{ id: "p1" }],
    crucibleFindings: [
      criticalFinding({ id: "f1", severity: CRUCIBLE_SEVERITY.P0_CRITICAL }),
      criticalFinding({ id: "f2", severity: CRUCIBLE_SEVERITY.P1_MAJOR, title: "resource leak" }),
    ],
  });
  assert.ok(prompt.includes("f1"));
  assert.ok(prompt.includes("f2"));
  assert.ok(prompt.includes("P0_CRITICAL"));
  assert.ok(prompt.includes("resource leak"));
});

test("domain-specific instructions appear and differ by domain", () => {
  const code = buildMergePrompt({ proposals: [{ id: "p1" }], crucibleFindings: [], domain: "code" });
  const architecture = buildMergePrompt({ proposals: [{ id: "p1" }], crucibleFindings: [], domain: "architecture" });
  assert.ok(code.includes("source code"));
  assert.ok(architecture.includes("system architecture"));
  assert.notEqual(code, architecture);
});

// ---------------------------------------------------------------------------
// 4.3 Merge execution
// ---------------------------------------------------------------------------

test("a valid SYNTHESIZED response is returned as OK and tracks every finding", async () => {
  const findings = [criticalFinding({ id: "f1" }), criticalFinding({ id: "f2", severity: CRUCIBLE_SEVERITY.P1_MAJOR })];
  const report = mergeReport({
    hybrid_solution: {
      content: "hybrid",
      elements: [
        element({ element_id: "e1", addresses_findings: ["f1"] }),
        element({ element_id: "e2", source_proposal_ids: ["p2"], addresses_findings: ["f2"] }),
      ],
    },
    findings_resolution: [
      resolution({ finding_id: "f1" }),
      resolution({ finding_id: "f2", resolution: "bounded the buffer" }),
    ],
  });
  const { fn, calls } = queueComplete([report]);
  const result = await runMerge({
    proposals: [{ id: "p1" }, { id: "p2" }],
    crucibleFindings: findings,
    completeFn: fn,
    modelId: "synth-1",
  });
  assert.equal(calls.length, 1, "the synthesizer is called exactly once");
  assert.equal(result.status, "OK");
  assert.equal(result.report.decision, MERGE_DECISION.SYNTHESIZED);
  assert.deepEqual(findUnresolvedCriticalFindings(result.report, findings).unresolved, []);
});

test("fenced JSON is accepted", async () => {
  const body = ["```json", JSON.stringify(mergeReport()), "```"].join("\n");
  const { fn } = queueComplete([body]);
  const result = await runMerge({ proposals: [{ id: "p1" }, { id: "p2" }], completeFn: fn });
  assert.equal(result.status, "OK");
});

test("INSUFFICIENT_INPUT is returned with a null hybrid and a reason", async () => {
  const report = mergeReport({
    decision: MERGE_DECISION.INSUFFICIENT_INPUT,
    hybrid_solution: null,
    findings_resolution: [],
    discarded_elements: [],
    insufficiency_reason: "every proposal carried a P0 that could not be bridged",
  });
  const { fn } = queueComplete([report]);
  const result = await runMerge({ proposals: [{ id: "p1" }], completeFn: fn });
  assert.equal(result.status, "OK");
  assert.equal(result.report.hybrid_solution, null);
  assert.match(result.report.insufficiency_reason, /P0/);
});

test("malformed JSON yields INVALID_MERGE with the raw response, no crash", async () => {
  const { fn } = queueComplete(["this is not json at all"]);
  const result = await runMerge({ proposals: [{ id: "p1" }], completeFn: fn });
  assert.equal(result.status, INVALID_MERGE);
  assert.equal(result.rawResponse, "this is not json at all");
  assert.ok(result.errors.some((e) => e.includes("no JSON object")));
});

test("a schema-invalid report yields INVALID_MERGE", async () => {
  const { fn } = queueComplete([mergeReport({ decision: "MAYBE" })]);
  const result = await runMerge({ proposals: [{ id: "p1" }, { id: "p2" }], completeFn: fn });
  assert.equal(result.status, INVALID_MERGE);
  assert.ok(result.errors.some((e) => e.includes("decision")));
});

test("a transport failure yields INVALID_MERGE, not an exception", async () => {
  const fn = async () => {
    throw new Error("connection refused");
  };
  const result = await runMerge({ proposals: [{ id: "p1" }], completeFn: fn });
  assert.equal(result.status, INVALID_MERGE);
  assert.ok(result.errors[0].includes("connection refused"));
});

test("a missing completeFn is reported, not thrown", async () => {
  const result = await runMerge({ proposals: [{ id: "p1" }] });
  assert.equal(result.status, INVALID_MERGE);
  assert.ok(result.errors.some((e) => e.includes("completeFn")));
});

// ---------------------------------------------------------------------------
// 4.4 Decision logic
// ---------------------------------------------------------------------------

test("all proposals below threshold means no attempt", () => {
  const gate = shouldAttemptMerge(crucibleResult([
    { proposalId: "p1", survivalScore: 0.2 },
    { proposalId: "p2", survivalScore: 0.1 },
  ]));
  assert.equal(gate.attempt, false);
  assert.equal(gate.reason, "All proposals below survival threshold");
});

test("one proposal above threshold means attempt, retaining", () => {
  const gate = shouldAttemptMerge(crucibleResult([
    { proposalId: "p1", survivalScore: 0.6 },
    { proposalId: "p2", survivalScore: 0.1 },
  ]));
  assert.equal(gate.attempt, true);
  assert.equal(gate.reason, "Single viable proposal — will retain");
  assert.deepEqual(gate.viableProposalIds, ["p1"]);
});

test("multiple viable proposals means attempt, synthesizing", () => {
  const gate = shouldAttemptMerge(crucibleResult([
    { proposalId: "p1", survivalScore: 0.6 },
    { proposalId: "p2", survivalScore: 0.9 },
  ]));
  assert.equal(gate.attempt, true);
  assert.equal(gate.reason, "Multiple viable proposals — will synthesize");
});

test("the threshold is configurable", () => {
  const results = crucibleResult([{ proposalId: "p1", survivalScore: 0.4 }]);
  assert.equal(shouldAttemptMerge(results).attempt, true);
  assert.equal(shouldAttemptMerge(results, { minSurvivalScore: 0.5 }).attempt, false);
});

test("an empty or missing result set is not an attempt", () => {
  assert.equal(shouldAttemptMerge(crucibleResult([])).attempt, false);
  assert.equal(shouldAttemptMerge(undefined).attempt, false);
});

// ---------------------------------------------------------------------------
// 4.5 Stage integration
// ---------------------------------------------------------------------------

test("the full SYNTHESIZED path completes and records model and timing", async () => {
  const cru = crucibleResult([
    { proposalId: "p1", survivalScore: 0.5, aggregatedFindings: [criticalFinding({ id: "f1" })] },
    { proposalId: "p2", survivalScore: 0.8, aggregatedFindings: [] },
  ]);
  const report = mergeReport({
    hybrid_solution: {
      content: "hybrid",
      elements: [element({ source_proposal_ids: ["p1", "p2"], addresses_findings: ["f1"] })],
    },
    findings_resolution: [resolution({ finding_id: "f1" })],
  });
  let seenPrompt = null;
  const { fn } = queueComplete([report]);
  const wrapped = async (config, modelId, prompt, opts) => {
    seenPrompt = prompt;
    return fn(config, modelId, prompt, opts);
  };
  const stage = await runMergeStage({
    proposals: [{ id: "p1", approach: "a" }, { id: "p2", approach: "b" }],
    crucibleStageResult: cru,
    completeFn: wrapped,
    modelId: "synth-1",
    options: { completedAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(stage.stage, MERGE_STAGE);
  assert.equal(stage.status, MERGE_STAGE_STATUS.COMPLETED);
  assert.equal(stage.result.report.decision, MERGE_DECISION.SYNTHESIZED);
  assert.equal(stage.modelId, "synth-1");
  assert.equal(typeof stage.elapsed_ms, "number");
  assert.equal(stage.completedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(seenPrompt.includes("f1"), "the critical finding must reach the synthesizer");
});

test("all-flawed proposals skip the merge without calling the model", async () => {
  const cru = crucibleResult([
    { proposalId: "p1", survivalScore: 0.1, aggregatedFindings: [] },
    { proposalId: "p2", survivalScore: 0.05, aggregatedFindings: [] },
  ]);
  let called = 0;
  const stage = await runMergeStage({
    proposals: [{ id: "p1" }, { id: "p2" }],
    crucibleStageResult: cru,
    completeFn: async () => {
      called += 1;
      return { text: "{}" };
    },
  });
  assert.equal(stage.status, MERGE_STAGE_STATUS.SKIPPED);
  assert.equal(stage.reason, "All proposals below survival threshold");
  assert.equal(called, 0, "no model call when the gate refuses");
});

test("an unreadable merge output yields INVALID_RESULT, preserving the raw response", async () => {
  const cru = crucibleResult([
    { proposalId: "p1", survivalScore: 0.7, aggregatedFindings: [] },
    { proposalId: "p2", survivalScore: 0.7, aggregatedFindings: [] },
  ]);
  const { fn } = queueComplete(["utter nonsense"]);
  const stage = await runMergeStage({
    proposals: [{ id: "p1" }, { id: "p2" }],
    crucibleStageResult: cru,
    completeFn: fn,
    modelId: "synth-1",
  });
  assert.equal(stage.status, MERGE_STAGE_STATUS.INVALID_RESULT);
  assert.equal(stage.rawResponse, "utter nonsense");
  assert.ok(stage.errors.length > 0);
  assert.equal(stage.modelId, "synth-1");
});

// ---------------------------------------------------------------------------
// 4.6 Critical finding extraction
// ---------------------------------------------------------------------------

test("only P0 and P1 findings are extracted, tagged with their proposal", () => {
  const cru = crucibleResult([
    {
      proposalId: "p1",
      aggregatedFindings: [
        criticalFinding({ id: "p0", severity: CRUCIBLE_SEVERITY.P0_CRITICAL }),
        criticalFinding({ id: "p2", severity: CRUCIBLE_SEVERITY.P2_MINOR }),
      ],
    },
    {
      proposalId: "p2",
      aggregatedFindings: [
        criticalFinding({ id: "p1f", severity: CRUCIBLE_SEVERITY.P1_MAJOR }),
        criticalFinding({ id: "p3", severity: CRUCIBLE_SEVERITY.P3_INFORMATIONAL }),
      ],
    },
  ]);
  const extracted = extractCriticalFindings(cru);
  assert.deepEqual(extracted.map((f) => f.id), ["p0", "p1f"]);
  assert.deepEqual(extracted.map((f) => f.proposal_id), ["p1", "p2"]);
});

test("extraction falls back to raw reports when aggregated findings are absent", () => {
  const cru = crucibleResult([
    { proposalId: "p1", reports: [{ findings: [criticalFinding({ id: "r1" })] }] },
  ]);
  assert.deepEqual(extractCriticalFindings(cru).map((f) => f.id), ["r1"]);
});

test("empty findings extract to an empty array without crashing", () => {
  assert.deepEqual(extractCriticalFindings(crucibleResult([{ proposalId: "p1", aggregatedFindings: [] }])), []);
  assert.deepEqual(extractCriticalFindings(undefined), []);
});

test("stage timing is zero for a skipped merge", async () => {
  const stage = await runMergeStage({
    proposals: [{ id: "p1" }],
    crucibleStageResult: crucibleResult([{ proposalId: "p1", survivalScore: 0.1 }]),
    completeFn: async () => ({ text: "{}" }),
  });
  assert.equal(stage.elapsed_ms, 0);
});
