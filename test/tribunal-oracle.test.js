// Oracle (Stage 5) tests.
//
// Six layers, matching the task breakdown:
//   * schema      -- the final contract and its verdict/confidence agreement
//   * confidence  -- the weighted model and its clamping/defaults
//   * checks      -- the five model-free validation checks
//   * battle      -- the narrative report and its ledgers
//   * execution   -- runOracle's four verdict paths
//   * pipeline    -- runFullTribunal end to end
//
// Every provider is a deterministic mock; no network, no credentials.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BATTLE_STAGES,
  CONFIDENCE_THRESHOLD,
  CONFIDENCE_WEIGHTS,
  MERGE_QUALITY_SCORE,
  ORACLE_SCHEMA_VERSION,
  ORACLE_VERDICT,
  TRIAL_SCORE,
  validateOracleReport,
} from "../src/core/tribunal/oracle-schema.js";
import {
  VALIDATION_CHECK,
  computeConfidence,
  generateBattleReport,
  runOracle,
  runValidationChecks,
} from "../src/core/tribunal/oracle.js";
import { ORACLE_STAGE, runFullTribunal, runOracleStage } from "../src/core/tribunal/stage-oracle.js";
import { FINDING_RESOLUTION_STATUS, MERGE_DECISION } from "../src/core/tribunal/merge-schema.js";
import { TRIAL_VERDICT } from "../src/core/tribunal/trial-schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function weights() {
  return { ...CONFIDENCE_WEIGHTS };
}

function mergeReport(overrides = {}) {
  return {
    schema_version: 1,
    decision: MERGE_DECISION.SYNTHESIZED,
    hybrid_solution: {
      content: "THE HYBRID",
      elements: [
        { element_id: "e1", source_proposal_ids: ["p1"], rationale: "from A", addresses_findings: [] },
        { element_id: "e2", source_proposal_ids: ["p2"], rationale: "from B", addresses_findings: [] },
      ],
    },
    findings_resolution: [],
    discarded_elements: [],
    synthesis_notes: "merged A and B",
    insufficiency_reason: null,
    ...overrides,
  };
}

function mergeStageResult(report = mergeReport()) {
  return {
    stage: "MERGE",
    status: "COMPLETED",
    result: { status: "OK", report },
    gate: { attempt: true, reason: "Multiple viable proposals — will synthesize" },
    criticalFindings: [],
  };
}

function stage1Result(confidenceAfter = 1) {
  return {
    candidates: [
      { id: "p1", review: { confidenceAfter } },
      { id: "p2", review: { confidenceAfter } },
    ],
    summary: { total: 2, reviewed: 2, invalid: 0, limited: 0, revised: 0 },
  };
}

function stage2Result(survivalScore = 1, aggregatedFindings = []) {
  return {
    stage: "CRUCIBLE",
    results: [{ proposalId: "p1", survivalScore, aggregatedFindings, counts: {}, reports: [], invalid: [] }],
    summary: { total: 1 },
  };
}

/** @param {string} [verdict] */
function stage4Result(verdict = TRIAL_VERDICT.ACQUITTED, findings = [], extra = {}) {
  return {
    stage: "TRIAL",
    status: "COMPLETED",
    outcome: { verdict },
    trialResult: { status: "OK", report: { verdict, findings } },
    ...extra,
  };
}

function oracleReport(overrides = {}) {
  return {
    schema_version: ORACLE_SCHEMA_VERSION,
    verdict: ORACLE_VERDICT.VERIFIED,
    confidence: 0.97,
    confidence_breakdown: {
      self_review_score: 1,
      survival_score: 1,
      merge_quality_score: 1,
      trial_score: 1,
      validation_score: 1,
      weights: weights(),
    },
    validation_checks: [
      { check_id: "STRUCTURAL_INTEGRITY", name: "Structural integrity", domain: "general", passed: true, details: "ok" },
    ],
    battle_report: {
      title: "Tribunal Battle Report (code)",
      summary: "a summary",
      rounds: [
        { round_number: 1, stage: BATTLE_STAGES.FORGE, events: ["a"] },
        { round_number: 2, stage: BATTLE_STAGES.CRUCIBLE, events: ["b"] },
        { round_number: 3, stage: BATTLE_STAGES.MERGE, events: ["c"] },
        { round_number: 4, stage: BATTLE_STAGES.TRIAL, events: ["d"] },
        { round_number: 5, stage: BATTLE_STAGES.ORACLE, events: ["e"] },
      ],
      winner: "Synthesized hybrid: THE HYBRID",
      total_findings: { p0: 0, p1: 0, p2: 0, p3: 0 },
      resolved_findings: 0,
      unresolved_critical: 0,
    },
    final_output: "the endorsed output",
    caveats: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 4.1 Schema validation
// ---------------------------------------------------------------------------

test("a valid VERIFIED report passes", () => {
  const { valid, errors } = validateOracleReport(oracleReport());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("VERIFIED below the threshold is invalid", () => {
  const { valid, errors } = validateOracleReport(oracleReport({ confidence: 0.9 }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("at least 0.95")));
});

test("VERIFIED with a null final_output is invalid", () => {
  assert.equal(validateOracleReport(oracleReport({ final_output: null })).valid, false);
});

test("INSUFFICIENT_CONFIDENCE with empty caveats is invalid", () => {
  const report = oracleReport({ verdict: ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE, confidence: 0.9, caveats: [], final_output: "x" });
  const { valid, errors } = validateOracleReport(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("caveats must be non-empty")));
});

test("INSUFFICIENT_CONFIDENCE at or above the threshold is invalid", () => {
  const report = oracleReport({ verdict: ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE, confidence: 0.96, caveats: ["x"] });
  assert.equal(validateOracleReport(report).valid, false);
});

test("REJECTED with a non-null final_output is invalid", () => {
  const report = oracleReport({ verdict: ORACLE_VERDICT.REJECTED, confidence: 0, final_output: "x" });
  assert.equal(validateOracleReport(report).valid, false);
});

test("REJECTED with confidence 0 and a null output is valid", () => {
  const report = oracleReport({ verdict: ORACLE_VERDICT.REJECTED, confidence: 0, final_output: null });
  assert.equal(validateOracleReport(report).valid, true);
});

test("ABORTED with a non-zero confidence is invalid", () => {
  const report = oracleReport({ verdict: ORACLE_VERDICT.ABORTED, confidence: 0.5, final_output: null });
  assert.equal(validateOracleReport(report).valid, false);
});

test("weights not summing to 1.0 are invalid", () => {
  const report = oracleReport({
    confidence_breakdown: { ...oracleReport().confidence_breakdown, weights: { ...weights(), trial: 0.4 } },
  });
  const { valid, errors } = validateOracleReport(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("must sum to 1.0")));
});

test("rounds out of order are invalid", () => {
  const report = oracleReport();
  report.battle_report.rounds = [
    { round_number: 2, stage: BATTLE_STAGES.CRUCIBLE, events: ["b"] },
    { round_number: 1, stage: BATTLE_STAGES.FORGE, events: ["a"] },
  ];
  const { valid, errors } = validateOracleReport(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("ordered by round_number")));
});

test("a findings count that does not partition the total is invalid", () => {
  const report = oracleReport();
  report.battle_report.total_findings = { p0: 2, p1: 0, p2: 1, p3: 0 };
  report.battle_report.resolved_findings = 1;
  report.battle_report.unresolved_critical = 0;
  const { valid, errors } = validateOracleReport(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("must equal resolved_findings + unresolved_critical")));
});

test("unknown fields are rejected at the top level and within nested objects", () => {
  assert.equal(validateOracleReport({ ...oracleReport(), extra: 1 }).valid, false);
  const bad = oracleReport();
  bad.confidence_breakdown = { ...bad.confidence_breakdown, extra: 1 };
  assert.equal(validateOracleReport(bad).valid, false);
  const badRound = oracleReport();
  badRound.battle_report.rounds[0] = { ...badRound.battle_report.rounds[0], extra: 1 };
  assert.equal(validateOracleReport(badRound).valid, false);
});

test("an out-of-range confidence is invalid", () => {
  assert.equal(validateOracleReport(oracleReport({ confidence: 1.5 })).valid, false);
  assert.equal(validateOracleReport(oracleReport({ confidence: -0.1 })).valid, false);
});

test("an invalid check domain or unknown round stage is invalid", () => {
  const badDomain = oracleReport();
  badDomain.validation_checks[0] = { ...badDomain.validation_checks[0], domain: "nope" };
  assert.equal(validateOracleReport(badDomain).valid, false);

  const badStage = oracleReport();
  badStage.battle_report.rounds[0] = /** @type {any} */ ({ ...badStage.battle_report.rounds[0], stage: "NOPE" });
  assert.equal(validateOracleReport(badStage).valid, false);
});

test("validation never throws on garbage", () => {
  for (const input of [null, 42, "nope", [], {}]) {
    const result = validateOracleReport(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

// ---------------------------------------------------------------------------
// 4.2 Confidence computation
// ---------------------------------------------------------------------------

test("all stages perfect yields confidence 1.0", () => {
  const { confidence, breakdown } = computeConfidence({
    stage1Result: stage1Result(1),
    stage2Result: stage2Result(1),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    validationChecks: [{ passed: true }],
  });
  assert.equal(confidence, 1);
  assert.equal(breakdown.self_review_score, 1);
  assert.equal(breakdown.validation_score, 1);
});

test("all stages failed yields confidence 0.0", () => {
  const { confidence, breakdown } = computeConfidence({
    stage1Result: stage1Result(0),
    stage2Result: stage2Result(0),
    stage3Result: { status: "INVALID_RESULT" },
    stage4Result: stage4Result(TRIAL_VERDICT.MISTRIAL),
    validationChecks: [{ passed: false }],
  });
  assert.equal(confidence, 0);
  assert.equal(breakdown.merge_quality_score, 0);
  assert.equal(breakdown.trial_score, 0);
});

test("mixed scores match the weighted calculation", () => {
  // .15*.8 + .25*.6 + .20*1 + .30*1 + .10*1 = .87
  const { confidence } = computeConfidence({
    stage1Result: stage1Result(0.8),
    stage2Result: stage2Result(0.6),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    validationChecks: [{ passed: true }],
  });
  assert.ok(Math.abs(confidence - 0.87) < 1e-9, `expected 0.87, got ${confidence}`);
});

test("missing stage data falls back to graceful defaults", () => {
  const { confidence, breakdown } = computeConfidence({});
  // self-review and survival default to 1.0; merge and trial default to 0.0;
  // an empty check list is vacuously 1.0 -> 0.15 + 0.25 + 0.10 = 0.50
  assert.ok(Math.abs(confidence - 0.5) < 1e-9, `expected 0.5, got ${confidence}`);
  assert.equal(breakdown.self_review_score, 1);
  assert.equal(breakdown.survival_score, 1);
  assert.equal(breakdown.merge_quality_score, 0);
  assert.equal(breakdown.trial_score, 0);
  assert.equal(breakdown.validation_score, 1);
});

test("component inputs are clamped to [0, 1]", () => {
  const high = computeConfidence({
    stage1Result: stage1Result(10),
    stage2Result: stage2Result(5),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    validationChecks: [],
  });
  assert.equal(high.confidence, 1);
  assert.equal(high.breakdown.self_review_score, 1);
  assert.equal(high.breakdown.survival_score, 1);

  const low = computeConfidence({
    stage1Result: stage1Result(-3),
    stage2Result: stage2Result(-4),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    validationChecks: [],
  });
  assert.equal(low.breakdown.self_review_score, 0);
  assert.equal(low.breakdown.survival_score, 0);
});

test("an acquittal after a retry scores the trial at 0.7", () => {
  const withHistory = stage4Result(TRIAL_VERDICT.ACQUITTED, [], {
    finalVerdict: TRIAL_VERDICT.ACQUITTED,
    history: [{ iteration: 0, verdict: TRIAL_VERDICT.CONVICTED_RETRY }, { iteration: 1, verdict: TRIAL_VERDICT.ACQUITTED }],
  });
  const { breakdown } = computeConfidence({ stage4Result: withHistory });
  assert.equal(breakdown.trial_score, TRIAL_SCORE.ACQUITTED_AFTER_RETRY);
});

test("a single-proposal merge scores merge quality at 0.8", () => {
  const { breakdown } = computeConfidence({ stage3Result: mergeStageResult(mergeReport({ decision: MERGE_DECISION.SINGLE_PROPOSAL_RETAINED })) });
  assert.equal(breakdown.merge_quality_score, MERGE_QUALITY_SCORE.SINGLE_PROPOSAL_RETAINED);
});

test("a mistrial and a skipped trial both score the trial at 0.0", () => {
  assert.equal(computeConfidence({ stage4Result: stage4Result(TRIAL_VERDICT.MISTRIAL) }).breakdown.trial_score, 0);
  assert.equal(computeConfidence({ stage4Result: { status: "SKIPPED" } }).breakdown.trial_score, 0);
});

test("the breakdown always carries weights that sum to 1.0", () => {
  const { breakdown } = computeConfidence({});
  const sum = Object.values(breakdown.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ---------------------------------------------------------------------------
// 4.3 Validation checks
// ---------------------------------------------------------------------------

test("all checks pass on a clean merge and acquittal", () => {
  const checks = runValidationChecks({ mergeReport: mergeReport(), trialReport: { verdict: TRIAL_VERDICT.ACQUITTED, findings: [] }, domain: "code" });
  assert.equal(checks.length, 5);
  assert.ok(checks.every((check) => check.passed === true));
  const { breakdown } = computeConfidence({ validationChecks: checks });
  assert.equal(breakdown.validation_score, 1);
});

test("validation_score reflects the pass ratio when some checks fail", () => {
  const report = mergeReport({
    hybrid_solution: {
      content: "THE HYBRID",
      elements: [{ element_id: "e1", source_proposal_ids: [], rationale: "orphan", addresses_findings: [] }],
    },
  });
  const checks = runValidationChecks({
    mergeReport: report,
    trialReport: { verdict: TRIAL_VERDICT.CONVICTED_FINAL, findings: [] },
    domain: "code",
  });
  const failed = checks.filter((check) => check.passed === false);
  assert.ok(failed.some((c) => c.check_id === VALIDATION_CHECK.PROVENANCE_COMPLETE));
  assert.ok(failed.some((c) => c.check_id === VALIDATION_CHECK.TRIAL_SURVIVAL));
  const { breakdown } = computeConfidence({ validationChecks: checks });
  assert.ok(Math.abs(breakdown.validation_score - 3 / 5) < 1e-9);
});

test("an empty check list is vacuously 1.0", () => {
  assert.equal(computeConfidence({ validationChecks: [] }).breakdown.validation_score, 1);
});

test("FINDING_CLOSURE fails on an unaddressed P0 and passes once ADDRESSED", () => {
  const crucibleFindings = [{ id: "cf0", severity: "P0_CRITICAL", title: "leak" }];
  const open = runValidationChecks({ mergeReport: mergeReport(), trialReport: { verdict: TRIAL_VERDICT.ACQUITTED, findings: [] }, domain: "code", options: { crucibleFindings } });
  assert.equal(open.find((c) => c.check_id === VALIDATION_CHECK.FINDING_CLOSURE).passed, false);

  const closed = runValidationChecks({
    mergeReport: mergeReport({ findings_resolution: [{ finding_id: "cf0", status: FINDING_RESOLUTION_STATUS.ADDRESSED, resolution: "fixed" }] }),
    trialReport: { verdict: TRIAL_VERDICT.ACQUITTED, findings: [] },
    domain: "code",
    options: { crucibleFindings },
  });
  assert.equal(closed.find((c) => c.check_id === VALIDATION_CHECK.FINDING_CLOSURE).passed, true);
});

test("NO_SCOPE_INFLATION fails on a critical scope-inflation finding", () => {
  const checks = runValidationChecks({
    mergeReport: mergeReport(),
    trialReport: { verdict: TRIAL_VERDICT.CONVICTED_RETRY, findings: [{ vector: "SCOPE_INFLATION", severity: "P1_MAJOR" }] },
    domain: "code",
  });
  assert.equal(checks.find((c) => c.check_id === VALIDATION_CHECK.NO_SCOPE_INFLATION).passed, false);
});

// ---------------------------------------------------------------------------
// 4.4 Battle report generation
// ---------------------------------------------------------------------------

test("a full run yields five ordered rounds", () => {
  const report = generateBattleReport({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(1),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    confidence: 1,
    verdict: ORACLE_VERDICT.VERIFIED,
    domain: "code",
  });
  assert.equal(report.rounds.length, 5);
  assert.deepEqual(
    report.rounds.map((r) => r.stage),
    [BATTLE_STAGES.FORGE, BATTLE_STAGES.CRUCIBLE, BATTLE_STAGES.MERGE, BATTLE_STAGES.TRIAL, BATTLE_STAGES.ORACLE],
  );
  assert.deepEqual(report.rounds.map((r) => r.round_number), [1, 2, 3, 4, 5]);
});

test("a skipped merge is handled gracefully", () => {
  const report = generateBattleReport({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(0),
    stage3Result: { stage: "MERGE", status: "SKIPPED", reason: "All proposals below survival threshold" },
    stage4Result: { stage: "TRIAL", status: "SKIPPED" },
    confidence: 0,
    verdict: ORACLE_VERDICT.ABORTED,
    domain: "code",
  });
  assert.equal(report.rounds.length, 5);
  assert.equal(report.winner, null);
  assert.ok(report.rounds[2].events.some((e) => e.includes("NONE")));
});

test("findings are aggregated across the Crucible and the Trial", () => {
  const crucible = [
    { id: "cf0", severity: "P0_CRITICAL", vector: "SECURITY", title: "leak" },
    { id: "cf1", severity: "P2_MINOR", vector: "EDGE_CASES", title: "empty" },
  ];
  const report = generateBattleReport({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(0.5, crucible),
    stage3Result: mergeStageResult(
      mergeReport({ findings_resolution: [{ finding_id: "cf0", status: FINDING_RESOLUTION_STATUS.ACKNOWLEDGED_UNRESOLVED, resolution: "ships anyway" }] }),
    ),
    stage4Result: stage4Result(TRIAL_VERDICT.CONVICTED_RETRY, [{ id: "t1", severity: "P1_MAJOR", vector: "INTEGRATION_SEAM", title: "seam" }]),
    confidence: 0.5,
    verdict: ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE,
    domain: "code",
  });
  assert.deepEqual(report.total_findings, { p0: 1, p1: 1, p2: 1, p3: 0 });
  const total = 3;
  assert.equal(report.resolved_findings + report.unresolved_critical, total);
  // cf0 is resolved by the merge; the trial's t1 is still outstanding.
  assert.equal(report.unresolved_critical, 1);
});

test("the winner names the hybrid, and is null when rejected", () => {
  const verified = generateBattleReport({ stage3Result: mergeStageResult(), confidence: 1, verdict: ORACLE_VERDICT.VERIFIED, domain: "code" });
  assert.match(verified.winner, /THE HYBRID/);
  const rejected = generateBattleReport({ stage3Result: mergeStageResult(), confidence: 0, verdict: ORACLE_VERDICT.REJECTED, domain: "code" });
  assert.equal(rejected.winner, null);
});

// ---------------------------------------------------------------------------
// 4.5 Oracle execution
// ---------------------------------------------------------------------------

test("a clean acquittal path yields VERIFIED", () => {
  const oracle = runOracle({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(1),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    domain: "code",
  });
  assert.equal(oracle.verdict, ORACLE_VERDICT.VERIFIED);
  assert.ok(oracle.confidence >= CONFIDENCE_THRESHOLD);
  assert.equal(oracle.final_output, "THE HYBRID");
  assert.equal(validateOracleReport(oracle).valid, true);
});

test("a CONVICTED_FINAL trial yields REJECTED", () => {
  const oracle = runOracle({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(1),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(TRIAL_VERDICT.CONVICTED_FINAL, [{ id: "t1", severity: "P0_CRITICAL", vector: "INTEGRATION_SEAM", title: "seam" }]),
    domain: "code",
  });
  assert.equal(oracle.verdict, ORACLE_VERDICT.REJECTED);
  assert.equal(oracle.confidence, 0);
  assert.equal(oracle.final_output, null);
  assert.equal(validateOracleReport(oracle).valid, true);
});

test("a low-confidence run yields INSUFFICIENT_CONFIDENCE with caveats", () => {
  const oracle = runOracle({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(0.5),
    stage3Result: mergeStageResult(mergeReport({ decision: MERGE_DECISION.SINGLE_PROPOSAL_RETAINED })),
    stage4Result: stage4Result(),
    domain: "code",
  });
  assert.equal(oracle.verdict, ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE);
  assert.ok(oracle.confidence < CONFIDENCE_THRESHOLD);
  assert.ok(oracle.caveats.length > 0);
  assert.equal(validateOracleReport(oracle).valid, true);
});

test("a missing stage 4 yields ABORTED", () => {
  const oracle = runOracle({ stage1Result: stage1Result(), stage2Result: stage2Result(1), stage3Result: mergeStageResult(), domain: "code" });
  assert.equal(oracle.verdict, ORACLE_VERDICT.ABORTED);
  assert.equal(oracle.confidence, 0);
  assert.equal(oracle.final_output, null);
  assert.equal(validateOracleReport(oracle).valid, true);
});

test("a mistrial yields ABORTED, not a throw", () => {
  const oracle = runOracle({
    stage1Result: stage1Result(),
    stage2Result: stage2Result(1),
    stage3Result: mergeStageResult(),
    stage4Result: { stage: "TRIAL", status: "MISTRIAL", trialResult: { status: "MISTRIAL", rawResponse: "junk" } },
    domain: "code",
  });
  assert.equal(oracle.verdict, ORACLE_VERDICT.ABORTED);
  assert.equal(validateOracleReport(oracle).valid, true);
});

test("deterministic stages produce an exact confidence", () => {
  const oracle = runOracle({
    stage1Result: stage1Result(0.8),
    stage2Result: stage2Result(0.6),
    stage3Result: mergeStageResult(),
    stage4Result: stage4Result(),
    domain: "code",
  });
  assert.ok(Math.abs(oracle.confidence - 0.87) < 1e-9, `expected 0.87, got ${oracle.confidence}`);
  assert.equal(oracle.verdict, ORACLE_VERDICT.INSUFFICIENT_CONFIDENCE);
});

test("runOracle never throws on empty or garbage input", () => {
  for (const input of [{}, { stage3Result: 42 }, { stage4Result: "x" }]) {
    const oracle = runOracle(input);
    assert.equal(validateOracleReport(oracle).valid, true);
  }
});

// ---------------------------------------------------------------------------
// 4.6 Full pipeline integration
// ---------------------------------------------------------------------------

const SELF_REVIEW_FIXTURE = {
  schemaVersion: 1,
  candidateId: "candidate",
  originalApproach: "the approach",
  strongestCounterArgument: "the counter",
  failureHypotheses: [{ statement: "maybe slow", severity: "low", category: "performance", evidence: "hypothesis", reproduction: null }],
  failureHypothesesRationale: "only one plausible concern",
  assumptions: [],
  missingEvidence: [],
  securityWeaknesses: [],
  logicRisks: [],
  edgeCases: [],
  performanceConcerns: [],
  proposedTests: [],
  confidenceBefore: 0.9,
  confidenceAfter: 0.9,
  confidenceJustification: "no material change",
  decision: "RETAIN_WITH_EVIDENCE",
  revisedApproach: null,
};

const CRUCIBLE_PASS_FIXTURE = {
  schema_version: 1,
  attacker_perspective: "SECURITY",
  target_proposal_id: "p1",
  verdict: "PASS",
  findings: [],
  summary: "the proposal held",
};

const MERGE_FIXTURE = {
  schema_version: 1,
  decision: "SYNTHESIZED",
  hybrid_solution: {
    content: "THE HYBRID",
    elements: [
      { element_id: "e1", source_proposal_ids: ["p1"], rationale: "from A", addresses_findings: [] },
      { element_id: "e2", source_proposal_ids: ["p2"], rationale: "from B", addresses_findings: [] },
    ],
  },
  findings_resolution: [],
  discarded_elements: [],
  synthesis_notes: "merged",
  insufficiency_reason: null,
};

const TRIAL_ACQUIT_FIXTURE = {
  schema_version: 1,
  verdict: "ACQUITTED",
  findings: [],
  prosecution_summary: "clean",
  recommended_retry_focus: null,
};

function tribunalMock({ crucible = CRUCIBLE_PASS_FIXTURE, trial = JSON.stringify(TRIAL_ACQUIT_FIXTURE) } = {}) {
  return async (config, modelId, prompt, opts) => {
    const system = opts?.system ?? "";
    if (/hostile but fair reviewer/.test(system)) return { text: JSON.stringify(SELF_REVIEW_FIXTURE) };
    if (/adversarial examiner/.test(system)) return { text: JSON.stringify(crucible) };
    if (/neutral senior architect/.test(system)) return { text: JSON.stringify(MERGE_FIXTURE) };
    if (/prosecutor/.test(system)) return { text: typeof trial === "string" ? trial : JSON.stringify(trial) };
    return { text: "{}" };
  };
}

const PIPELINE_PROPOSALS = [
  { id: "p1", model: "mock", approach: "approach A" },
  { id: "p2", model: "mock", approach: "approach B" },
];

test("runFullTribunal records a complete run and a VERIFIED oracle", async () => {
  const record = await runFullTribunal({ proposals: PIPELINE_PROPOSALS, completeFn: tribunalMock(), modelId: "mock", domain: "code" });
  assert.equal(typeof record.tribunal_id, "string");
  assert.ok(record.tribunal_id.length > 0);
  assert.deepEqual(Object.keys(record.stages), ["stage1", "stage2", "stage3", "stage4", "stage5"]);
  assert.equal(record.stages.stage2.stage, "CRUCIBLE");
  assert.equal(record.stages.stage3.status, "COMPLETED");
  assert.equal(record.stages.stage4.status, "COMPLETED");
  assert.equal(record.stages.stage5.stage, ORACLE_STAGE);
  assert.equal(record.oracle.verdict, ORACLE_VERDICT.VERIFIED);
  assert.equal(validateOracleReport(record.oracle).valid, true);
  assert.equal(record.battle_report.rounds.length, 5);
});

test("runFullTribunal terminates early when the Crucible kills every proposal", async () => {
  const killer = (title) => ({
    id: `f-${title}`,
    severity: "P0_CRITICAL",
    vector: "LOGIC_INTEGRITY",
    title,
    explanation: "fatal",
    falsifiable_proof: { kind: "LOGICAL_PROOF", payload: "a contradiction" },
  });
  const crucible = {
    schema_version: 1,
    attacker_perspective: "LOGIC_INTEGRITY",
    target_proposal_id: "p1",
    verdict: "FATAL",
    findings: [killer("alpha"), killer("beta")],
    summary: "unsalvageable",
  };
  const record = await runFullTribunal({ proposals: PIPELINE_PROPOSALS, completeFn: tribunalMock({ crucible }), modelId: "mock", domain: "code" });
  assert.equal(record.stages.stage2.summary.averageSurvival, 0);
  assert.equal(record.stages.stage3.status, "SKIPPED");
  assert.equal(record.stages.stage4.status, "SKIPPED");
  assert.equal(record.oracle.verdict, ORACLE_VERDICT.ABORTED);
  assert.equal(validateOracleReport(record.oracle).valid, true);
});

test("runFullTribunal degrades gracefully when the Trial is a mistrial", async () => {
  const record = await runFullTribunal({ proposals: PIPELINE_PROPOSALS, completeFn: tribunalMock({ trial: "not json at all" }), modelId: "mock", domain: "code" });
  assert.equal(record.stages.stage4.status, "MISTRIAL");
  assert.equal(record.oracle.verdict, ORACLE_VERDICT.ABORTED);
  assert.equal(validateOracleReport(record.oracle).valid, true);
  assert.equal(record.battle_report.rounds.length, 5);
});

test("runOracleStage reports COMPLETED and wraps an abort cleanly", async () => {
  const completed = await runOracleStage({
    allStageResults: { stage1: stage1Result(), stage2: stage2Result(1), stage3: mergeStageResult(), stage4: stage4Result() },
    domain: "code",
  });
  assert.equal(completed.stage, ORACLE_STAGE);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.oracleResult.verdict, ORACLE_VERDICT.VERIFIED);

  const aborted = await runOracleStage({ allStageResults: {}, domain: "code" });
  assert.equal(aborted.status, "COMPLETED");
  assert.equal(aborted.oracleResult.verdict, ORACLE_VERDICT.ABORTED);
});
