// The Arena judge (src/core/tournament/judge.js).
//
// Every fixture is deterministic: no model calls, no clock dependence beyond an
// injected `now`. The tests pin the parts that decide a match -- scoring,
// evidence, fatal flaws, tie-breaks, contradiction rejection, and the handoff
// to applyMatchResult().

import test from "node:test";
import assert from "node:assert/strict";

const j = await import("../src/core/tournament/judge.js");
const state = await import("../src/core/tournament/tournament-state.js");

const NOW = 1_700_000_000_000;

function scores(correctness, completeness, robustness, specificity, clarity) {
  return { correctness, completeness, robustness, specificity, clarity };
}

function report(overrides = {}) {
  return {
    schema_version: j.JUDGE_SCHEMA_VERSION,
    match_id: "r1m1",
    scores: {
      candidate_a: scores(9, 8, 8, 7, 8),
      candidate_b: scores(8, 8, 7, 7, 8),
    },
    unresolved_objections: { candidate_a: [], candidate_b: [] },
    fatal_flaw: null,
    verdict: "A_WINS",
    rationale: "A handles the retry boundary that B leaves open.",
    judge_model: "fixture-judge",
    ...overrides,
  };
}

/**
 * Build an evidence fixture.
 *
 * @param {keyof typeof j.EVIDENCE_KIND} [kind]
 * @param {string} [payload]
 */
function evidence(kind = j.EVIDENCE_KIND.TEST_CASE, payload = "test/retry.test.js fails at line 42") {
  return { kind, payload };
}

test("a valid report produces a weighted decision", () => {
  const result = j.decideMatch(report(), {
    matchId: "r1m1",
    candidateA: "cand-a",
    candidateB: "cand-b",
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);

  const decision = result.decision;
  assert.equal(decision.outcome, "winner");
  assert.equal(decision.verdict, "A_WINS");
  assert.equal(decision.winnerId, "cand-a");
  assert.equal(decision.loserId, "cand-b");
  assert.equal(decision.reason, j.DECISION_REASON.SCORE);
  assert.equal(decision.scores.candidate_a.total, 81.5);
  assert.equal(decision.scores.candidate_b.total, 76.5);
  assert.equal(decision.scores.candidate_a.weighted, 8.15);
  assert.equal(decision.fatalFlaw, null);
  assert.equal(decision.tieBreak, null);
  assert.equal(decision.judgeModel, "fixture-judge");
  assert.equal(decision.decidedAt, new Date(NOW).toISOString());
});

test("judgeMatch parses fenced JSON and keeps the raw report separate", () => {
  const text = "Here is my verdict:\n```json\n" + JSON.stringify(report()) + "\n```\nThanks.";
  const result = j.judgeMatch({ text, match: { id: "r1m1", a: "cand-a", b: "cand-b" }, now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.decision.winnerId, "cand-a");
  assert.equal(result.raw.match_id, "r1m1");
  assert.equal("raw" in result.decision, false);
});

test("malformed judge output is an error, not a winner", () => {
  for (const text of ["", "no json here", "[1,2,3]", "```json\n{oops}\n```"]) {
    const result = j.judgeMatch({ text, match: { id: "r1m1", a: "a", b: "b" } });
    assert.equal(result.ok, false);
    assert.equal(result.decision, null);
    assert.ok(result.errors.length > 0);
  }
});

test("missing criteria and unknown fields are rejected", () => {
  const missing = report();
  delete missing.scores.candidate_b.robustness;
  const missingCheck = j.validateJudgeResponse(missing);
  assert.equal(missingCheck.valid, false);
  assert.match(missingCheck.errors.join(" "), /scores\.candidate_b: scores are missing "robustness"/);

  const extra = report({ unsupported_opinion: true });
  const extraCheck = j.validateJudgeResponse(extra);
  assert.equal(extraCheck.valid, false);
  assert.match(extraCheck.errors.join(" "), /unknown field "unsupported_opinion"/);
});

test("out-of-range and non-numeric scores are rejected", () => {
  for (const bad of [-1, 11, "8", null, NaN]) {
    const broken = report();
    broken.scores.candidate_a.correctness = bad;
    const result = j.decideMatch(broken, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
    assert.equal(result.ok, false, `expected ${String(bad)} to be rejected`);
    assert.equal(result.decision, null);
  }
});

test("a wrong schema version or match id is rejected", () => {
  assert.match(
    j.validateJudgeResponse(report({ schema_version: 2 })).errors.join(" "),
    /schema_version must be 1/,
  );
  assert.match(
    j.validateJudgeResponse(report({ match_id: "r9m9" }), { matchId: "r1m1" }).errors.join(" "),
    /does not match "r1m1"/,
  );
});

test("a declared winner that contradicts the scores is rejected", () => {
  const result = j.decideMatch(report({ verdict: "B_WINS" }), {
    matchId: "r1m1",
    candidateA: "a",
    candidateB: "b",
  });

  assert.equal(result.ok, false);
  assert.equal(result.decision, null);
  assert.match(result.errors.join(" "), /contradictory verdict/);
});

test("a declared TIE is accepted and the scores still decide", () => {
  const result = j.decideMatch(report({ verdict: "TIE" }), {
    matchId: "r1m1",
    candidateA: "a",
    candidateB: "b",
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision.winnerId, "a");
  assert.equal(result.decision.declaredVerdict, "TIE");
  assert.equal(result.decision.verdict, "A_WINS");
});

test("a verified fatal flaw eliminates a candidate that scored higher overall", () => {
  const fixture = report({
    // B totals 76 (2,10,10,10,10); A totals 75 (all 7.5). B wins on score,
    // unless the verified correctness defect disqualifies it.
    scores: {
      candidate_a: scores(7.5, 7.5, 7.5, 7.5, 7.5),
      candidate_b: scores(2, 10, 10, 10, 10),
    },
    unresolved_objections: {
      candidate_a: [],
      candidate_b: [
        { criterion: "correctness", claim: "B returns stale state after the retry", evidence: evidence() },
      ],
    },
    fatal_flaw: {
      candidate: "candidate_b",
      criterion: "correctness",
      claim: "B returns stale state after the retry",
      evidence: evidence(),
    },
  });

  const result = j.decideMatch(fixture, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(result.ok, true);
  assert.equal(result.decision.reason, j.DECISION_REASON.FATAL_FLAW);
  assert.equal(result.decision.winnerId, "a");
  assert.equal(result.decision.fatalFlaw.verified, true);
  assert.equal(result.decision.fatalFlaw.candidateId, "b");
  assert.ok(result.decision.scores.candidate_b.total > result.decision.scores.candidate_a.total);
});

test("an unsupported fatal flaw is recorded but does not decide the match", () => {
  const fixture = report({
    fatal_flaw: {
      candidate: "candidate_a",
      criterion: "correctness",
      claim: "A must be wrong, I can feel it",
      evidence: evidence(j.EVIDENCE_KIND.ALLEGATION, ""),
    },
  });

  const result = j.decideMatch(fixture, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(result.ok, true);
  assert.equal(result.decision.reason, j.DECISION_REASON.SCORE);
  assert.equal(result.decision.winnerId, "a");
  assert.equal(result.decision.fatalFlaw.verified, false);
  assert.equal(result.decision.fatalFlaw.evidence.kind, j.EVIDENCE_KIND.ALLEGATION);
});

test("a fatal flaw against a well-scored criterion is contradictory", () => {
  const fixture = report({
    fatal_flaw: {
      candidate: "candidate_a",
      criterion: "correctness",
      claim: "A is fatally wrong",
      evidence: evidence(),
    },
  });

  const result = j.decideMatch(fixture, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /contradictory fatal flaw/);
});

test("a serious score needs a concrete unresolved objection", () => {
  const noEvidence = report();
  noEvidence.scores.candidate_b.correctness = 2;
  const result = j.decideMatch(noEvidence, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /no unresolved objection with evidence supports it/);

  const withEvidence = report();
  withEvidence.scores.candidate_b.correctness = 2;
  withEvidence.unresolved_objections.candidate_b = [
    { criterion: "correctness", claim: "B drops the retry", evidence: evidence() },
  ];
  withEvidence.verdict = "A_WINS";
  const ok = j.decideMatch(withEvidence, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(ok.ok, true);
});

test("an objection with an ALLEGATION is not evidence of a serious defect", () => {
  const fixture = report();
  fixture.scores.candidate_b.correctness = 2;
  fixture.unresolved_objections.candidate_b = [
    { criterion: "correctness", claim: "trust me", evidence: evidence(j.EVIDENCE_KIND.ALLEGATION, "") },
  ];

  const check = j.validateJudgeResponse(fixture);
  assert.equal(check.valid, false);
  assert.match(check.errors.join(" "), /evidence\.kind must be one of/);
});

test("equal totals and equal tie-breaks produce an explicit unresolved outcome", () => {
  const fixture = report({
    scores: {
      candidate_a: scores(7, 7, 7, 7, 7),
      candidate_b: scores(7, 7, 7, 7, 7),
    },
    verdict: "TIE",
  });

  const result = j.decideMatch(fixture, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(result.ok, true);
  assert.equal(result.decision.outcome, "unresolved");
  assert.equal(result.decision.winnerId, null);
  assert.equal(result.decision.loserId, null);
  assert.equal(result.decision.reason, j.DECISION_REASON.UNRESOLVED);
  assert.equal(j.decisionToMatchResult(result.decision), null);
});

test("a declared winner over a resolved tie is contradictory", () => {
  const fixture = report({
    scores: {
      candidate_a: scores(7, 7, 7, 7, 7),
      candidate_b: scores(7, 7, 7, 7, 7),
    },
    verdict: "A_WINS",
  });
  const result = j.decideMatch(fixture, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /declared A_WINS but the rubric is level/);
});

test("ties are broken by correctness, then robustness, then open objections", () => {
  // Totals are both exactly 7.0; A is more correct, B is more complete.
  const byCorrectness = report({
    scores: {
      candidate_a: scores(8, 7, 7, 7, 7),
      candidate_b: scores(6, 9.4, 7, 7, 7),
    },
    verdict: "TIE",
  });
  const correctness = j.decideMatch(byCorrectness, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(correctness.ok, true);
  assert.equal(correctness.decision.reason, j.DECISION_REASON.CORRECTNESS);
  assert.equal(correctness.decision.winnerId, "a");
  assert.match(correctness.decision.tieBreak.detail, /correctness 8 vs 6/);

  // Totals are both 7.0 and correctness is level; robustness separates them.
  const byRobustness = report({
    scores: {
      candidate_a: scores(7, 6.2, 8, 7, 7),
      candidate_b: scores(7, 7.8, 6, 7, 7),
    },
    verdict: "TIE",
  });
  const robustness = j.decideMatch(byRobustness, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(robustness.ok, true);
  assert.equal(robustness.decision.reason, j.DECISION_REASON.ROBUSTNESS);
  assert.equal(robustness.decision.winnerId, "a");

  // Totals, correctness, and robustness are level; fewer open objections wins.
  const byObjections = report({
    scores: {
      candidate_a: scores(7, 7, 7, 7, 7),
      candidate_b: scores(7, 7, 7, 7, 7),
    },
    unresolved_objections: {
      candidate_a: [],
      candidate_b: [
        { criterion: "clarity", claim: "the migration note is ambiguous", evidence: evidence(j.EVIDENCE_KIND.LOGICAL_PROOF, "step 2 contradicts step 4") },
      ],
    },
    verdict: "TIE",
  });
  const objections = j.decideMatch(byObjections, { matchId: "r1m1", candidateA: "a", candidateB: "b" });
  assert.equal(objections.ok, true);
  assert.equal(objections.decision.reason, j.DECISION_REASON.OBJECTIONS);
  assert.equal(objections.decision.winnerId, "a");
  assert.equal(objections.decision.unresolvedObjections.candidate_b, 1);
});

test("the compact decision does not carry the full objection text", () => {
  const claim = "UNIQUE_OBJECTION_TEXT_SHOULD_LIVE_IN_RAW_ONLY";
  const fixture = report({
    unresolved_objections: {
      candidate_a: [],
      candidate_b: [{ criterion: "clarity", claim, evidence: evidence(j.EVIDENCE_KIND.LOGICAL_PROOF, "proof") }],
    },
  });
  const result = j.judgeMatch({ text: JSON.stringify(fixture), match: { id: "r1m1", a: "a", b: "b" } });

  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.decision).includes(claim), false);
  assert.equal(JSON.stringify(result.raw).includes(claim), true);
});

test("a decision applies cleanly to the tournament state machine", () => {
  let tournament = state.createTournamentState({
    task: "Fix the retry bug",
    candidates: [{ id: "cand-a" }, { id: "cand-b" }],
    seed: 1,
    id: "arena_judge_test",
  });
  const match = tournament.rounds[0].matches[0];

  const judged = j.judgeMatch({
    text: JSON.stringify(
      report({
        match_id: match.id,
        scores: {
          candidate_a: scores(9, 8, 8, 7, 8),
          candidate_b: scores(8, 8, 7, 7, 8),
        },
        verdict: "A_WINS",
      }),
    ),
    match,
  });
  assert.equal(judged.ok, true);

  const applied = j.decisionToMatchResult(judged.decision);
  assert.deepEqual(applied.matchId, match.id);
  assert.equal(applied.winnerId, decidedWinner(match, judged.decision));

  tournament = state.applyMatchResult(tournament, applied);
  assert.equal(tournament.rounds[0].matches[0].status, "completed");
  assert.equal(
    /** @type {{ verdict: { verdict: string; } } } */ (
      /** @type {unknown} */ (tournament.rounds[0].matches[0])
    ).verdict.verdict,
    "A_WINS",
  );

  tournament = state.closeRound(tournament);
  assert.equal(tournament.status, state.TOURNAMENT_STATUS.COMPLETED);
  assert.equal(tournament.champion, applied.winnerId);
});

function decidedWinner(match, decision) {
  assert.ok(decision.winnerId === match.a || decision.winnerId === match.b);
  return decision.winnerId;
}

test("the judge prompt carries the rubric, evidence rules, and both candidates", () => {
  const prompt = j.buildJudgePrompt({
    task: "Fix the retry bug",
    matchId: "r1m1",
    candidateA: { id: "cand-a", proposal: "PROPOSAL_A", cardId: "card-a" },
    candidateB: { id: "cand-b", proposal: "PROPOSAL_B", cardId: "card-b" },
  });

  assert.match(prompt, /correctness \(weight 0\.30\)/);
  assert.match(prompt, /ALLEGATION is not/);
  assert.match(prompt, /Candidate cand-a/);
  assert.match(prompt, /Candidate cand-b/);
  assert.ok(prompt.includes("PROPOSAL_A"));
  assert.ok(prompt.includes("PROPOSAL_B"));
  assert.match(prompt, /"schema_version": 1/);
});
