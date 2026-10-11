// Trial (Stage 4) tests.
//
// Six layers, matching the task breakdown:
//   * schema     -- the contract and its verdict/findings agreement
//   * prompt     -- anonymity, subject, regression material, persona, vectors
//   * execution  -- runTrial happy path and every MISTRIAL path
//   * classifier -- the retry budget
//   * integration-- the stage's three outcomes
//   * retry loop -- the bounded Trial/Merge loop
//
// Every provider is a deterministic mock; no network, no credentials.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SEVERITY,
  TRIAL_SCHEMA_VERSION,
  TRIAL_VECTOR,
  TRIAL_VERDICT,
  validateTrialReport,
} from "../src/core/tribunal/trial-schema.js";
import {
  MISTRIAL,
  buildTrialPrompt,
  classifyTrialOutcome,
  runTrial,
} from "../src/core/tribunal/trial.js";
import { TRIAL_STAGE, TRIAL_STAGE_STATUS, runTrialStage, runTrialWithRetry } from "../src/core/tribunal/stage-trial.js";

function mergeReport(overrides = {}) {
  return {
    schema_version: 1,
    decision: "SYNTHESIZED",
    hybrid_solution: {
      content: "the merged hybrid",
      elements: [
        { element_id: "e1", source_proposal_ids: ["p1"], rationale: "from A", addresses_findings: [] },
        { element_id: "e2", source_proposal_ids: ["p2"], rationale: "from B", addresses_findings: ["cf1"] },
      ],
    },
    findings_resolution: [
      { finding_id: "cf1", status: "ADDRESSED", resolution: "fixed on paper" },
    ],
    discarded_elements: [],
    synthesis_notes: "merged A and B",
    insufficiency_reason: null,
    ...overrides,
  };
}

function mergeStageResult(report = mergeReport()) {
  return { stage: "MERGE", status: "COMPLETED", result: { status: "OK", report }, gate: {}, modelId: "synth-1", elapsed_ms: 5, completedAt: "T" };
}

function trialFinding(overrides = {}) {
  return {
    id: "t1",
    severity: SEVERITY.P0_CRITICAL,
    vector: TRIAL_VECTOR.INTEGRATION_SEAM,
    title: "deadlock at the seam",
    explanation: "A's lock and B's lock-free path deadlock",
    affected_element_ids: ["e1"],
    regression_of: null,
    falsifiable_proof: { kind: "LOGICAL_PROOF", payload: "thread 1 holds e1, waits for e2, and vice versa" },
    ...overrides,
  };
}

function trialReport(overrides = {}) {
  return {
    schema_version: TRIAL_SCHEMA_VERSION,
    verdict: TRIAL_VERDICT.ACQUITTED,
    findings: [],
    prosecution_summary: "no critical issues found",
    recommended_retry_focus: null,
    ...overrides,
  };
}

function convictedReport(findings, overrides = {}) {
  return trialReport({
    verdict: TRIAL_VERDICT.CONVICTED_RETRY,
    findings,
    recommended_retry_focus: "re-examine the integration seam between e1 and e2",
    ...overrides,
  });
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

test("a valid ACQUITTED report with no findings passes", () => {
  const { valid, errors } = validateTrialReport(trialReport(), mergeReport());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a valid ACQUITTED report with only P2/P3 findings passes", () => {
  const report = trialReport({
    findings: [
      trialFinding({ id: "t1", severity: SEVERITY.P2_MINOR, affected_element_ids: ["e1"] }),
      trialFinding({ id: "t2", severity: SEVERITY.P3_INFORMATIONAL, affected_element_ids: ["e2"] }),
    ],
  });
  assert.equal(validateTrialReport(report, mergeReport()).valid, true);
});

test("an ACQUITTED verdict carrying a P0 is invalid", () => {
  const report = trialReport({ findings: [trialFinding()] });
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("must not contain a P0/P1 when verdict is ACQUITTED")));
});

test("CONVICTED_RETRY without recommended_retry_focus is invalid", () => {
  const report = convictedReport([trialFinding()], { recommended_retry_focus: null });
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("recommended_retry_focus is required")));
});

test("CONVICTED_RETRY without any P0/P1 is invalid", () => {
  const report = convictedReport([trialFinding({ severity: SEVERITY.P2_MINOR })]);
  assert.equal(validateTrialReport(report, mergeReport()).valid, false);
});

test("CONVICTED_FINAL without any P0/P1 is invalid", () => {
  const report = trialReport({
    verdict: TRIAL_VERDICT.CONVICTED_FINAL,
    findings: [trialFinding({ severity: SEVERITY.P3_INFORMATIONAL })],
  });
  assert.equal(validateTrialReport(report, mergeReport()).valid, false);
});

test("FINDING_REGRESSION without regression_of is invalid", () => {
  const report = convictedReport([
    trialFinding({ vector: TRIAL_VECTOR.FINDING_REGRESSION, regression_of: null }),
  ]);
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("regression_of is required")));
});

test("FINDING_REGRESSION with regression_of not among the Crucible findings is invalid", () => {
  const report = convictedReport([
    trialFinding({ vector: TRIAL_VECTOR.FINDING_REGRESSION, regression_of: "nope" }),
  ]);
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"nope" is not a finding the merge resolved')));
});

test("a valid FINDING_REGRESSION linking back to a resolved finding passes", () => {
  const report = convictedReport([
    trialFinding({ vector: TRIAL_VECTOR.FINDING_REGRESSION, regression_of: "cf1", affected_element_ids: ["e2"] }),
  ]);
  assert.equal(validateTrialReport(report, mergeReport()).valid, true);
});

test("affected_element_ids referencing a non-existent merge element is invalid", () => {
  const report = convictedReport([trialFinding({ affected_element_ids: ["e9"] })]);
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('"e9" is not an element of the merge report')));
});

test("duplicate finding ids are rejected", () => {
  const report = convictedReport([trialFinding({ id: "t1" }), trialFinding({ id: "t1" })]);
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("used more than once")));
});

test("an empty falsifiable_proof payload is invalid", () => {
  const report = convictedReport([
    trialFinding({ falsifiable_proof: { kind: "LOGICAL_PROOF", payload: "" } }),
  ]);
  const { valid, errors } = validateTrialReport(report, mergeReport());
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("payload must be a non-empty string")));
});

test("unknown fields are rejected at the top level and within a finding", () => {
  assert.equal(validateTrialReport({ ...trialReport(), extra: 1 }, mergeReport()).valid, false);
  const bad = convictedReport([trialFinding({ note: "hi" })]);
  assert.equal(validateTrialReport(bad, mergeReport()).valid, false);
});

test("validation never throws on garbage", () => {
  for (const input of [null, 42, "nope", [], { verdict: "ACQUITTED" }]) {
    const result = validateTrialReport(input, mergeReport());
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test("shape-only validation (no merge) skips element membership", () => {
  const report = trialReport({ findings: [trialFinding({ severity: SEVERITY.P2_MINOR, affected_element_ids: ["anything"] })] });
  assert.equal(validateTrialReport(report).valid, true);
});

// ---------------------------------------------------------------------------
// 4.2 Prompt generation
// ---------------------------------------------------------------------------

test("author identity is stripped from the merge report", () => {
  const report = mergeReport({ synthesizer: "secret-synth", model: "secret-model" });
  const prompt = buildTrialPrompt({ mergeReport: report });
  for (const leak of ["secret-synth", "secret-model"]) {
    assert.ok(!prompt.includes(leak), `prompt must not leak "${leak}"`);
  }
  assert.ok(prompt.includes("the merged hybrid"));
});

test("proposal identity is stripped and proposals get anonymous labels", () => {
  const prompt = buildTrialPrompt({
    mergeReport: mergeReport(),
    originalProposals: [
      { id: "p1", approach: "APPROACH_ONE", model: "secret-model" },
      { id: "p2", approach: "APPROACH_TWO", provider: "acme" },
    ],
  });
  assert.ok(prompt.includes("Proposal A"));
  assert.ok(prompt.includes("Proposal B"));
  assert.ok(prompt.includes("APPROACH_ONE"));
  for (const leak of ["secret-model", "acme"]) assert.ok(!prompt.includes(leak));
});

test("the Crucible findings are present for regression checking", () => {
  const prompt = buildTrialPrompt({
    mergeReport: mergeReport(),
    crucibleFindings: [
      { id: "cf1", severity: SEVERITY.P0_CRITICAL, vector: "SECURITY", title: "injection", proposal_id: "p1" },
    ],
  });
  assert.ok(prompt.includes("cf1"));
  assert.ok(prompt.includes("injection"));
  assert.ok(prompt.includes("ADDRESSED"), "the merge's claimed status should be shown");
});

test("the original proposals are present for provenance/scope checking", () => {
  const prompt = buildTrialPrompt({
    mergeReport: mergeReport(),
    originalProposals: [{ id: "p1", approach: "PROVENANCE_MARKER" }],
  });
  assert.ok(prompt.includes("PROVENANCE_MARKER"));
  assert.ok(prompt.includes("provenance"));
});

test("the hostile-prosecutor persona is installed", () => {
  const prompt = buildTrialPrompt({ mergeReport: mergeReport() });
  assert.match(prompt, /hostile prosecutor/i);
  assert.match(prompt, /not reviewing the original proposals/i);
});

test("all five merge-specific vectors are described", () => {
  const prompt = buildTrialPrompt({ mergeReport: mergeReport() });
  for (const vector of Object.values(TRIAL_VECTOR)) {
    assert.ok(prompt.includes(vector), `prompt must describe vector ${vector}`);
  }
});

test("domain-specific instructions appear and differ by domain", () => {
  const code = buildTrialPrompt({ mergeReport: mergeReport(), domain: "code" });
  const architecture = buildTrialPrompt({ mergeReport: mergeReport(), domain: "architecture" });
  assert.ok(code.includes("source code"));
  assert.ok(architecture.includes("system architecture"));
  assert.notEqual(code, architecture);
});

// ---------------------------------------------------------------------------
// 4.3 Trial execution
// ---------------------------------------------------------------------------

test("an ACQUITTED prosecution returns OK with no critical findings", async () => {
  const { fn, calls } = queueComplete([trialReport()]);
  const result = await runTrial({ mergeReport: mergeReport(), completeFn: fn });
  assert.equal(calls.length, 1);
  assert.equal(result.status, "OK");
  assert.equal(result.report.verdict, TRIAL_VERDICT.ACQUITTED);
  assert.equal(result.report.findings.length, 0);
});

test("a CONVICTED_RETRY with an INTEGRATION_SEAM P0 captures the finding and focus", async () => {
  const report = convictedReport([trialFinding()]);
  const { fn } = queueComplete([report]);
  const result = await runTrial({ mergeReport: mergeReport(), completeFn: fn });
  assert.equal(result.status, "OK");
  assert.equal(result.report.findings.length, 1);
  assert.equal(result.report.findings[0].vector, TRIAL_VECTOR.INTEGRATION_SEAM);
  assert.ok(result.report.recommended_retry_focus.length > 0);
});

test("a FINDING_REGRESSION links regression_of back to the Crucible finding", async () => {
  const report = convictedReport([
    trialFinding({ vector: TRIAL_VECTOR.FINDING_REGRESSION, regression_of: "cf1", affected_element_ids: ["e2"] }),
  ]);
  const { fn } = queueComplete([report]);
  const result = await runTrial({
    mergeReport: mergeReport(),
    crucibleFindings: [{ id: "cf1", severity: SEVERITY.P0_CRITICAL, vector: "SECURITY", title: "injection" }],
    completeFn: fn,
  });
  assert.equal(result.status, "OK");
  assert.equal(result.report.findings[0].regression_of, "cf1");
});

test("malformed JSON yields MISTRIAL with the raw response, no crash", async () => {
  const { fn } = queueComplete(["this is not json"]);
  const result = await runTrial({ mergeReport: mergeReport(), completeFn: fn });
  assert.equal(result.status, MISTRIAL);
  assert.equal(result.rawResponse, "this is not json");
  assert.ok(result.errors.some((e) => e.includes("no JSON object")));
});

test("a schema-invalid report yields MISTRIAL", async () => {
  const { fn } = queueComplete([trialReport({ findings: [trialFinding()] })]); // ACQUITTED + P0
  const result = await runTrial({ mergeReport: mergeReport(), completeFn: fn });
  assert.equal(result.status, MISTRIAL);
  assert.ok(result.errors.some((e) => e.includes("ACQUITTED")));
});

test("a transport failure yields MISTRIAL, not an exception", async () => {
  const fn = async () => {
    throw new Error("connection refused");
  };
  const result = await runTrial({ mergeReport: mergeReport(), completeFn: fn });
  assert.equal(result.status, MISTRIAL);
  assert.ok(result.errors[0].includes("connection refused"));
});

test("a missing mergeReport is reported as MISTRIAL, not thrown", async () => {
  const result = await runTrial({ completeFn: async () => ({ text: "{}" }) });
  assert.equal(result.status, MISTRIAL);
  assert.ok(result.errors.some((e) => e.includes("mergeReport")));
});

// ---------------------------------------------------------------------------
// 4.4 Classification
// ---------------------------------------------------------------------------

test("no findings classifies as ACQUITTED", () => {
  const outcome = classifyTrialOutcome(trialReport(), 0, 3);
  assert.equal(outcome.verdict, TRIAL_VERDICT.ACQUITTED);
  assert.equal(outcome.shouldRetry, false);
});

test("P2-only findings classify as ACQUITTED", () => {
  const report = trialReport({ findings: [trialFinding({ severity: SEVERITY.P2_MINOR })] });
  assert.equal(classifyTrialOutcome(report, 0, 3).verdict, TRIAL_VERDICT.ACQUITTED);
});

test("a P1 at iteration 0 of 3 classifies as CONVICTED_RETRY", () => {
  const report = convictedReport([trialFinding({ severity: SEVERITY.P1_MAJOR })]);
  const outcome = classifyTrialOutcome(report, 0, 3);
  assert.equal(outcome.verdict, TRIAL_VERDICT.CONVICTED_RETRY);
  assert.equal(outcome.shouldRetry, true);
  assert.equal(outcome.focus, report.recommended_retry_focus);
});

test("a P0 at iteration 2 of 3 is still CONVICTED_RETRY (last chance)", () => {
  const report = convictedReport([trialFinding()]);
  assert.equal(classifyTrialOutcome(report, 2, 3).verdict, TRIAL_VERDICT.CONVICTED_RETRY);
});

test("a P0 at iteration 3 of 3 is CONVICTED_FINAL with the budget exhausted", () => {
  const report = convictedReport([trialFinding()]);
  const outcome = classifyTrialOutcome(report, 3, 3);
  assert.equal(outcome.verdict, TRIAL_VERDICT.CONVICTED_FINAL);
  assert.equal(outcome.shouldRetry, false);
  assert.equal(outcome.exhaustedBudget, true);
});

// ---------------------------------------------------------------------------
// 4.5 Stage integration
// ---------------------------------------------------------------------------

test("the full pipeline completes with an ACQUITTED outcome", async () => {
  const cru = { stage: "CRUCIBLE", results: [{ proposalId: "p1", survivalScore: 0.5, aggregatedFindings: [{ id: "cf1", severity: SEVERITY.P0_CRITICAL, title: "x" }] }] };
  const { fn } = queueComplete([trialReport()]);
  const stage = await runTrialStage({
    mergeStageResult: mergeStageResult(),
    crucibleStageResult: cru,
    originalProposals: [{ id: "p1" }, { id: "p2" }],
    completeFn: fn,
    modelId: "prosecutor-1",
    options: { completedAt: "2026-01-01T00:00:00.000Z" },
  });
  assert.equal(stage.stage, TRIAL_STAGE);
  assert.equal(stage.status, TRIAL_STAGE_STATUS.COMPLETED);
  assert.equal(stage.outcome.verdict, TRIAL_VERDICT.ACQUITTED);
  assert.equal(stage.modelId, "prosecutor-1");
  assert.equal(stage.completedAt, "2026-01-01T00:00:00.000Z");
});

test("a SKIPPED merge makes the trial skip without calling the model", async () => {
  let called = 0;
  const stage = await runTrialStage({
    mergeStageResult: { stage: "MERGE", status: "SKIPPED", reason: "All proposals below survival threshold" },
    completeFn: async () => {
      called += 1;
      return { text: "{}" };
    },
  });
  assert.equal(stage.status, TRIAL_STAGE_STATUS.SKIPPED);
  assert.equal(stage.reason, "No merge to try");
  assert.equal(called, 0);
});

test("an INVALID_RESULT merge makes the trial skip", async () => {
  const stage = await runTrialStage({
    mergeStageResult: { stage: "MERGE", status: "INVALID_RESULT", rawResponse: "junk" },
    completeFn: async () => ({ text: "{}" }),
  });
  assert.equal(stage.status, TRIAL_STAGE_STATUS.SKIPPED);
});

test("a valid merge with a CONVICTED_RETRY trial completes with the retry outcome", async () => {
  const { fn } = queueComplete([convictedReport([trialFinding()])]);
  const stage = await runTrialStage({ mergeStageResult: mergeStageResult(), completeFn: fn });
  assert.equal(stage.status, TRIAL_STAGE_STATUS.COMPLETED);
  assert.equal(stage.outcome.verdict, TRIAL_VERDICT.CONVICTED_RETRY);
  assert.equal(stage.outcome.shouldRetry, true);
});

test("an unreadable trial yields MISTRIAL status", async () => {
  const { fn } = queueComplete(["utter nonsense"]);
  const stage = await runTrialStage({ mergeStageResult: mergeStageResult(), completeFn: fn, modelId: "prosecutor-1" });
  assert.equal(stage.status, TRIAL_STAGE_STATUS.MISTRIAL);
  assert.equal(stage.trialResult.rawResponse, "utter nonsense");
  assert.equal(stage.modelId, "prosecutor-1");
});

// ---------------------------------------------------------------------------
// 4.6 Retry loop
// ---------------------------------------------------------------------------

test("a single ACQUITTED trial uses one iteration and no retries", async () => {
  const { fn } = queueComplete([trialReport()]);
  const loop = await runTrialWithRetry({
    mergeStageResult: mergeStageResult(),
    completeFn: fn,
    options: { maxRetries: 3 },
  });
  assert.equal(loop.finalVerdict, TRIAL_VERDICT.ACQUITTED);
  assert.equal(loop.iterationsUsed, 1);
  assert.equal(loop.history.length, 1);
});

test("CONVICTED_RETRY then ACQUITTED uses two iterations", async () => {
  let mergeCalls = 0;
  const mergeFn = async () => {
    mergeCalls += 1;
    return mergeStageResult();
  };
  const { fn } = queueComplete([convictedReport([trialFinding()]), trialReport()]);
  const loop = await runTrialWithRetry({
    mergeStageResult: mergeStageResult(),
    completeFn: fn,
    mergeFn,
    options: { maxRetries: 3 },
  });
  assert.equal(loop.finalVerdict, TRIAL_VERDICT.ACQUITTED);
  assert.equal(loop.iterationsUsed, 2);
  assert.equal(mergeCalls, 1, "one re-merge between the two trials");
  assert.deepEqual(loop.history.map((h) => h.iteration), [0, 1]);
});

test("CONVICTED_RETRY through the whole budget ends CONVICTED_FINAL", async () => {
  const mergeFn = async () => mergeStageResult();
  const { fn } = queueComplete([convictedReport([trialFinding()])]);
  const loop = await runTrialWithRetry({
    mergeStageResult: mergeStageResult(),
    completeFn: fn,
    mergeFn,
    options: { maxRetries: 3 },
  });
  assert.equal(loop.finalVerdict, TRIAL_VERDICT.CONVICTED_FINAL);
  assert.equal(loop.iterationsUsed, 4, "initial trial plus three retries");
});

test("the history records every iteration with its verdict", async () => {
  const mergeFn = async () => mergeStageResult();
  const { fn } = queueComplete([convictedReport([trialFinding()])]);
  const loop = await runTrialWithRetry({
    mergeStageResult: mergeStageResult(),
    completeFn: fn,
    mergeFn,
    options: { maxRetries: 2 },
  });
  assert.equal(loop.history.length, 3);
  assert.deepEqual(loop.history.map((h) => h.iteration), [0, 1, 2]);
  assert.equal(loop.history[0].verdict, TRIAL_VERDICT.CONVICTED_RETRY);
  assert.equal(loop.history[2].verdict, TRIAL_VERDICT.CONVICTED_FINAL);
});

test("without a mergeFn the loop returns the retry recommendation, documented", async () => {
  const { fn } = queueComplete([convictedReport([trialFinding()])]);
  const loop = await runTrialWithRetry({
    mergeStageResult: mergeStageResult(),
    completeFn: fn,
    options: { maxRetries: 3 },
  });
  assert.equal(loop.finalVerdict, TRIAL_VERDICT.CONVICTED_RETRY);
  assert.equal(loop.iterationsUsed, 1);
  assert.match(loop.note, /Re-merge not wired/);
});

test("a skipped merge means the retry loop never starts", async () => {
  const loop = await runTrialWithRetry({
    mergeStageResult: { stage: "MERGE", status: "SKIPPED" },
    completeFn: async () => ({ text: "{}" }),
  });
  assert.equal(loop.finalVerdict, TRIAL_STAGE_STATUS.SKIPPED);
  assert.equal(loop.iterationsUsed, 0);
});
