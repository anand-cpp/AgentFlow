// Crucible (Stage 2) tests.
//
// Four layers, matching the four modules:
//   * schema   -- the contract: valid passes, malformed fails closed
//   * prompt   -- isolation and identity-blindness, per domain
//   * cross    -- orchestration: proof lowers survival, a clean pass does not,
//                 and bad output is recorded rather than thrown
//   * stage    -- the pipeline loop: aggregation, ordering, and non-mutation
//
// Every provider is a deterministic mock; no network, no credentials.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACK_VECTOR,
  ATTACK_VECTOR_SPECS,
  CRUCIBLE_ATTACK_SCHEMA,
  CRUCIBLE_SCHEMA_VERSION,
  CRUCIBLE_SEVERITY,
  CRUCIBLE_VERDICT,
  PROOF_KIND,
  classifyAttackFindings,
  validateCrucibleReport,
} from "../src/core/tribunal/crucible-schema.js";
import {
  CRUCIBLE_SYSTEM_PROMPT,
  INVALID_ATTACK,
  aggregateCrucibleFindings,
  buildCruciblePrompt,
  runCrossExamination,
} from "../src/core/tribunal/crucible.js";
import { CRUCIBLE_STAGE, runCrucibleStage } from "../src/core/tribunal/stage-crucible.js";

function finding(overrides = {}) {
  return {
    id: "f1",
    severity: CRUCIBLE_SEVERITY.P0_CRITICAL,
    vector: ATTACK_VECTOR.SECURITY,
    title: "injection",
    explanation: "user input reaches the shell unescaped",
    falsifiable_proof: { kind: PROOF_KIND.TEST_CASE, payload: "input='; rm -rf /' => executes" },
    ...overrides,
  };
}

function attack(overrides = {}) {
  return {
    schema_version: CRUCIBLE_SCHEMA_VERSION,
    attacker_perspective: ATTACK_VECTOR.SECURITY,
    target_proposal_id: "p1",
    verdict: CRUCIBLE_VERDICT.FLAWED,
    findings: [finding()],
    summary: "one exploitable path",
    ...overrides,
  };
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
// Schema
// ---------------------------------------------------------------------------

test("a well-formed attack report validates", () => {
  const { valid, errors } = validateCrucibleReport(attack());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a PASS verdict with no findings is valid", () => {
  const { valid } = validateCrucibleReport(
    attack({ verdict: CRUCIBLE_VERDICT.PASS, findings: [], summary: "withstood every attack" }),
  );
  assert.equal(valid, true);
});

test("unknown fields are rejected", () => {
  const { valid, errors } = validateCrucibleReport(attack({ confidence: 0.9 }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("confidence")));
});

test("an invalid vector is rejected", () => {
  const { valid, errors } = validateCrucibleReport(attack({ attacker_perspective: "STYLE" }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("attacker_perspective")));
});

test("an invalid severity is rejected", () => {
  const { valid, errors } = validateCrucibleReport(
    attack({ findings: [finding({ severity: "P4" })] }),
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("severity")));
});

test("a finding with an empty proof payload is rejected", () => {
  const { valid, errors } = validateCrucibleReport(
    attack({ findings: [finding({ falsifiable_proof: { kind: PROOF_KIND.TEST_CASE, payload: "" } })] }),
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("payload")));
});

test("an unknown proof kind is rejected", () => {
  const { valid, errors } = validateCrucibleReport(
    attack({ findings: [finding({ falsifiable_proof: { kind: "VIBES", payload: "x" } })] }),
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("kind")));
});

test("validation never throws on garbage", () => {
  for (const input of [null, 42, "nope", [], { findings: "not an array" }]) {
    const result = validateCrucibleReport(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test("classifyAttackFindings separates proven findings from idle claims", () => {
  const report = attack({
    findings: [
      finding({ id: "ok" }),
      finding({ id: "no-proof", falsifiable_proof: { kind: PROOF_KIND.LOGICAL_PROOF, payload: "" } }),
    ],
  });
  const { proven, unproven } = classifyAttackFindings(report);
  assert.deepEqual(proven.map((f) => f.id), ["ok"]);
  assert.deepEqual(unproven.map((f) => f.id), ["no-proof"]);
});

test("the schema exports its closed vocabulary", () => {
  assert.equal(CRUCIBLE_ATTACK_SCHEMA.schema_version, CRUCIBLE_SCHEMA_VERSION);
  assert.equal(CRUCIBLE_ATTACK_SCHEMA.vectors.length, 4);
  assert.ok(CRUCIBLE_ATTACK_SCHEMA.severities.includes(CRUCIBLE_SEVERITY.P0_CRITICAL));
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test("the prompt names the single vector under examination", () => {
  const prompt = buildCruciblePrompt({
    proposal: { id: "p1", approach: "does a thing" },
    vector: ATTACK_VECTOR.EDGE_CASES,
  });
  assert.ok(prompt.includes(ATTACK_VECTOR.EDGE_CASES));
  assert.ok(prompt.includes(ATTACK_VECTOR_SPECS[ATTACK_VECTOR.EDGE_CASES].focus));
  assert.ok(!prompt.includes(ATTACK_VECTOR_SPECS[ATTACK_VECTOR.SECURITY].focus));
});

test("the prompt is identity-blind -- no model or author leaks in", () => {
  const prompt = buildCruciblePrompt({
    proposal: {
      id: "p1",
      approach: "APPROACH_MARKER",
      model: "secret-model",
      author: "alice",
      provider: "acme",
    },
    vector: ATTACK_VECTOR.SECURITY,
  });
  assert.ok(prompt.includes("APPROACH_MARKER"), "the work must be present");
  for (const leak of ["secret-model", "alice", "acme"]) {
    assert.ok(!prompt.includes(leak), `the prompt must not leak "${leak}"`);
  }
  assert.equal(prompt.includes("model"), false);
});

test("domain framing differs between code and non-code proposals", () => {
  const code = buildCruciblePrompt({ proposal: { id: "p1" }, vector: ATTACK_VECTOR.LOGIC_INTEGRITY, domain: "code" });
  const idea = buildCruciblePrompt({ proposal: { id: "p1" }, vector: ATTACK_VECTOR.LOGIC_INTEGRITY, domain: "idea" });
  assert.ok(code.includes("TEST_CASE"));
  assert.ok(idea.includes("product") || idea.includes("idea"));
  assert.notEqual(code, idea);
});

test("an unknown vector throws before any call is made", () => {
  assert.throws(() => buildCruciblePrompt({ proposal: { id: "p1" }, vector: "NOPE" }), /unknown attack vector/);
});

// ---------------------------------------------------------------------------
// Cross-examination
// ---------------------------------------------------------------------------

test("a reproducible P0 lowers the survival score", async () => {
  const { fn } = queueComplete([attack()]);
  const { reports } = await runCrossExamination({
    proposal: { id: "p1", approach: "x" },
    completeFn: fn,
    vectors: [ATTACK_VECTOR.SECURITY],
  });
  const { survivalScore, counts } = aggregateCrucibleFindings(reports);
  assert.equal(counts[CRUCIBLE_SEVERITY.P0_CRITICAL], 1);
  assert.equal(survivalScore, 0.5);
});

test("a clean PASS leaves survival at 1.0", async () => {
  const { fn } = queueComplete([attack({ verdict: CRUCIBLE_VERDICT.PASS, findings: [], summary: "held" })]);
  const { reports, invalid } = await runCrossExamination({
    proposal: { id: "p1", approach: "x" },
    completeFn: fn,
    vectors: [ATTACK_VECTOR.SECURITY],
  });
  assert.equal(invalid.length, 0);
  assert.equal(aggregateCrucibleFindings(reports).survivalScore, 1);
});

test("malformed JSON becomes an INVALID_ATTACK, not an exception", async () => {
  const { fn } = queueComplete(["this is not json"]);
  const result = await runCrossExamination({
    proposal: { id: "p1", approach: "x" },
    completeFn: fn,
    vectors: [ATTACK_VECTOR.SECURITY],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reports.length, 0);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].verdict, INVALID_ATTACK);
  assert.equal(result.invalid[0].vector, ATTACK_VECTOR.SECURITY);
});

test("a schema violation becomes an INVALID_ATTACK", async () => {
  const { fn } = queueComplete([attack({ verdict: "MAYBE" })]);
  const result = await runCrossExamination({
    proposal: { id: "p1", approach: "x" },
    completeFn: fn,
    vectors: [ATTACK_VECTOR.SECURITY],
  });
  assert.equal(result.reports.length, 0);
  assert.ok(result.invalid[0].errors.some((e) => e.includes("verdict")));
});

test("a transport failure becomes an INVALID_ATTACK", async () => {
  const fn = async () => {
    throw new Error("connection refused");
  };
  const result = await runCrossExamination({
    proposal: { id: "p1", approach: "x" },
    completeFn: fn,
    vectors: [ATTACK_VECTOR.SECURITY],
  });
  assert.equal(result.invalid.length, 1);
  assert.ok(result.invalid[0].errors[0].includes("connection refused"));
});

test("each vector is examined in isolation, with the attack system prompt", async () => {
  const { fn, calls } = queueComplete([attack({ attacker_perspective: ATTACK_VECTOR.LOGIC_INTEGRITY })]);
  await runCrossExamination({
    proposal: { id: "p1", approach: "APPROACH_MARKER" },
    completeFn: fn,
    vectors: [ATTACK_VECTOR.LOGIC_INTEGRITY, ATTACK_VECTOR.EDGE_CASES],
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.system === CRUCIBLE_SYSTEM_PROMPT));
  assert.ok(calls[0].prompt.includes(ATTACK_VECTOR.LOGIC_INTEGRITY));
  assert.ok(calls[1].prompt.includes(ATTACK_VECTOR.EDGE_CASES));
});

test("identical findings from two lenses are kept, only exact repeats collapse", () => {
  const reports = [
    attack({ findings: [finding({ id: "a", title: "same", vector: ATTACK_VECTOR.SECURITY })] }),
    attack({ findings: [finding({ id: "b", title: "same", vector: ATTACK_VECTOR.SECURITY })] }),
    attack({ findings: [finding({ id: "c", title: "same", vector: ATTACK_VECTOR.EDGE_CASES })] }),
  ];
  const { findings } = aggregateCrucibleFindings(reports);
  assert.equal(findings.length, 2, "same lens+title collapses; a different lens does not");
});

test("findings are sorted P0 first", () => {
  const reports = [
    attack({
      findings: [
        finding({ id: "p2", severity: CRUCIBLE_SEVERITY.P2_MINOR, title: "minor" }),
        finding({ id: "p0", severity: CRUCIBLE_SEVERITY.P0_CRITICAL, title: "fatal" }),
      ],
    }),
  ];
  const { findings } = aggregateCrucibleFindings(reports);
  assert.deepEqual(findings.map((f) => f.severity), [
    CRUCIBLE_SEVERITY.P0_CRITICAL,
    CRUCIBLE_SEVERITY.P2_MINOR,
  ]);
});

// ---------------------------------------------------------------------------
// Executable-proof rule (Tribunal v2)
// ---------------------------------------------------------------------------

test("a P3 finding is downgraded to P2 and cannot block the Oracle gate", () => {
  const reports = [
    attack({
      findings: [
        finding({
          id: "p3-info",
          severity: CRUCIBLE_SEVERITY.P3_INFORMATIONAL,
          title: "informational note",
        }),
      ],
    }),
  ];
  const { findings, counts, downgradedCount, blockingFindingsCount } =
    aggregateCrucibleFindings(reports);
  assert.equal(downgradedCount, 1, "the P3 finding was downgraded");
  assert.equal(findings[0].severity, CRUCIBLE_SEVERITY.P2_MINOR, "downgraded to P2");
  assert.equal(findings[0].downgradedToP2, true, "downgrade flag is set");
  assert.equal(findings[0].executableProof, true, "executable proof is present");
  assert.equal(counts[CRUCIBLE_SEVERITY.P3_INFORMATIONAL], 0, "no P3 findings remain");
  assert.equal(counts[CRUCIBLE_SEVERITY.P2_MINOR], 1, "counted as P2");
  assert.equal(blockingFindingsCount, 0, "P2 does not block the Oracle gate");
});

test("P0 and P1 findings block the Oracle gate; P2 does not", () => {
  const reports = [
    attack({
      findings: [
        finding({ id: "p0", severity: CRUCIBLE_SEVERITY.P0_CRITICAL, title: "fatal" }),
        finding({ id: "p1", severity: CRUCIBLE_SEVERITY.P1_MAJOR, title: "major" }),
        finding({ id: "p2", severity: CRUCIBLE_SEVERITY.P2_MINOR, title: "minor" }),
      ],
    }),
  ];
  const { blockingFindingsCount, downgradedCount } = aggregateCrucibleFindings(reports);
  assert.equal(blockingFindingsCount, 2, "P0 and P1 are blocking");
  assert.equal(downgradedCount, 0, "no downgrades needed");
});

test("every proven finding carries executableProof", () => {
  const reports = [
    attack({
      findings: [
        finding({ id: "f1", severity: CRUCIBLE_SEVERITY.P0_CRITICAL, title: "fatal" }),
        finding({ id: "f2", severity: CRUCIBLE_SEVERITY.P2_MINOR, title: "minor" }),
      ],
    }),
  ];
  const { findings } = aggregateCrucibleFindings(reports);
  assert.ok(findings.every((f) => f.executableProof === true));
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

test("every proposal is examined across every vector", async () => {
  const seen = [];
  const fn = async (config, modelId, prompt) => {
    const match = prompt.match(/attacker_perspective "([A-Z_]+)"/);
    const vector = match ? match[1] : ATTACK_VECTOR.SECURITY;
    seen.push(vector);
    return { text: JSON.stringify(attack({ attacker_perspective: vector })) };
  };
  const result = await runCrucibleStage({
    proposals: [
      { id: "p1", approach: "first", model: "m1" },
      { id: "p2", approach: "second", model: "m2" },
    ],
    completeFn: fn,
    options: { vectors: [ATTACK_VECTOR.SECURITY, ATTACK_VECTOR.EDGE_CASES] },
  });
  assert.equal(result.stage, CRUCIBLE_STAGE);
  assert.equal(result.results.length, 2);
  assert.equal(seen.length, 4, "2 proposals x 2 vectors");
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.reports, 4);
});

test("the stage aggregates and scores each proposal", async () => {
  const fn = async (config, modelId, prompt) => {
    const vector = prompt.includes("(SECURITY)") ? ATTACK_VECTOR.SECURITY : ATTACK_VECTOR.EDGE_CASES;
    const severity = vector === ATTACK_VECTOR.SECURITY ? CRUCIBLE_SEVERITY.P0_CRITICAL : CRUCIBLE_SEVERITY.P2_MINOR;
    return {
      text: JSON.stringify(
        attack({ attacker_perspective: vector, findings: [finding({ id: vector, severity, vector })] }),
      ),
    };
  };
  const result = await runCrucibleStage({
    proposals: [{ id: "p1", approach: "x" }],
    completeFn: fn,
    options: { vectors: [ATTACK_VECTOR.SECURITY, ATTACK_VECTOR.EDGE_CASES] },
  });
  const r = result.results[0];
  assert.equal(r.proposalId, "p1");
  assert.equal(r.aggregatedFindings.length, 2);
  assert.equal(r.aggregatedFindings[0].severity, CRUCIBLE_SEVERITY.P0_CRITICAL);
  assert.equal(r.counts.total, 2);
  assert.ok(Math.abs(r.survivalScore - 0.45) < 1e-9, "1 - (0.5 + 0.05)");
});

test("the stage does not mutate the caller's proposals", async () => {
  const proposals = [{ id: "p1", approach: "x", model: "m1" }];
  const snapshot = JSON.parse(JSON.stringify(proposals));
  const { fn } = queueComplete([attack()]);
  await runCrucibleStage({ proposals, completeFn: fn, options: { vectors: [ATTACK_VECTOR.SECURITY] } });
  assert.deepEqual(proposals, snapshot);
});

test("an empty proposal list is a clean no-op", async () => {
  const result = await runCrucibleStage({ proposals: [], completeFn: async () => ({ text: "{}" }) });
  assert.equal(result.results.length, 0);
  assert.equal(result.summary.total, 0);
  assert.equal(result.stage, CRUCIBLE_STAGE);
});
