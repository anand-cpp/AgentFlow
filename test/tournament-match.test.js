// Arena match execution (src/core/tournament/match.js).
//
// Every provider here is a deterministic mock that keys off the system prompt
// to decide which stage it is answering. No network, no credentials, no clock
// dependence beyond the injected `now`.

import test from "node:test";
import assert from "node:assert/strict";

const matchModule = await import("../src/core/tournament/match.js");
const schema = await import("../src/core/tournament/match-schema.js");
const judge = await import("../src/core/tournament/judge.js");
const state = await import("../src/core/tournament/tournament-state.js");

const NOW = 1_700_000_000_000;
const match = { id: "r1m1", a: "cand-a", b: "cand-b" };
const candidates = {
  a: { id: "cand-a", model: "model-a", proposal: "PROPOSAL_A", card: { id: "card-a", reasoning: "r", workflow: "w", optimization: "o" } },
  b: { id: "cand-b", model: "model-b", proposal: "PROPOSAL_B", card: { id: "card-b", reasoning: "r", workflow: "w", optimization: "o" } },
};

function scores(correctness, completeness, robustness, specificity, clarity) {
  return { correctness, completeness, robustness, specificity, clarity };
}

function judgeReport(matchId, overrides = {}) {
  return {
    schema_version: judge.JUDGE_SCHEMA_VERSION,
    match_id: matchId,
    scores: {
      candidate_a: scores(9, 8, 8, 7, 8),
      candidate_b: scores(8, 8, 7, 7, 8),
    },
    unresolved_objections: { candidate_a: [], candidate_b: [] },
    fatal_flaw: null,
    verdict: "A_WINS",
    rationale: "A is more robust under the retry case.",
    judge_model: "fixture-judge",
    ...overrides,
  };
}

function stageOf(opts) {
  if (opts?.system === schema.ATTACK_SYSTEM_PROMPT) return "attack";
  if (opts?.system === schema.DEFENSE_SYSTEM_PROMPT) return "defense";
  if (opts?.system === schema.REVISION_SYSTEM_PROMPT) return "revision";
  if (opts?.system === judge.JUDGE_SYSTEM_PROMPT) return "judge";
  return "unknown";
}

function matchIdOf(prompt) {
  return prompt.match(/Match: (\S+)/)?.[1] ?? "r1m1";
}

function attackCountOf(prompt) {
  return (prompt.match(/^\[\d+\]/gm) ?? []).length;
}

function defaultAttackValue(prompt, matchId) {
  const attacker = prompt.includes("(candidate_a)") ? "candidate_a" : "candidate_b";
  const target = attacker === "candidate_a" ? "candidate_b" : "candidate_a";
  return {
    schema_version: schema.MATCH_SCHEMA_VERSION,
    match_id: matchId,
    attacker,
    target,
    summary: "one concrete risk",
    attacks: [
      {
        criterion: attacker === "candidate_a" ? "robustness" : "completeness",
        severity: "SERIOUS",
        claim: attacker === "candidate_a" ? "no retry on timeout" : "no migration notes",
        evidence:
          attacker === "candidate_a"
            ? { kind: "TEST_CASE", payload: "retry.test.js fails on timeout" }
            : { kind: "ALLEGATION", payload: "" },
      },
    ],
  };
}

/**
 * A mock provider. `handlers` may override any stage with a function that
 * receives `{ prompt, modelId, callIndex }` and returns a JSON value or throws.
 */
function createMock(handlers = {}) {
  const calls = { attack: 0, defense: 0, revision: 0, judge: 0 };
  const prompts = { attack: [], defense: [], revision: [], judge: [] };

  const completeFn = async (config, modelId, prompt, opts) => {
    const stage = stageOf(opts);
    calls[stage] += 1;
    prompts[stage].push(prompt);
    const callIndex = calls[stage];
    const matchId = matchIdOf(prompt);

    let value;
    if (handlers[stage]) {
      value = await handlers[stage]({ prompt, modelId, callIndex, matchId });
    } else if (stage === "attack") {
      value = defaultAttackValue(prompt, matchId);
    } else if (stage === "defense") {
      value = {
        schema_version: schema.MATCH_SCHEMA_VERSION,
        match_id: matchId,
        defender: prompt.includes("You are cand-a") ? "candidate_a" : "candidate_b",
        responses: Array.from({ length: attackCountOf(prompt) }, (_, index) => ({
          attack_index: index,
          stance: "FIXED",
          explanation: "added the missing handling",
        })),
      };
    } else if (stage === "revision") {
      value = {
        schema_version: schema.MATCH_SCHEMA_VERSION,
        match_id: matchId,
        candidate: prompt.includes("You are cand-a") ? "candidate_a" : "candidate_b",
        proposal: prompt.includes("You are cand-a") ? "REVISED_PROPOSAL_A" : "REVISED_PROPOSAL_B",
        changes: ["addressed the open attack"],
      };
    } else if (stage === "judge") {
      value = judgeReport(matchId);
    }
    if (value === undefined) throw new Error(`no mock for stage ${stage}`);
    return { text: JSON.stringify(value), model: modelId };
  };

  return { completeFn, calls, prompts };
}

function run(overrides = {}) {
  return matchModule.runMatch({
    task: "Fix the retry bug",
    match,
    candidates,
    completeFn: createMock().completeFn,
    judgeModel: "judge-model",
    now: () => NOW,
    sleep: async () => {},
    retryDelayMs: 0,
    ...overrides,
  });
}

test("a clean match runs seven calls and hands a winner to the bracket", async () => {
  const mock = createMock();
  const result = await run({ completeFn: mock.completeFn });

  assert.equal(result.ok, true);
  assert.equal(result.status, matchModule.MATCH_STATUS.DECIDED);
  assert.equal(result.decision.winnerId, "cand-a");
  assert.equal(result.matchResult.winnerId, "cand-a");
  assert.deepEqual(result.calls, { used: 7, max: matchModule.DEFAULT_MAX_CALLS });
  assert.deepEqual(mock.calls, { attack: 2, defense: 2, revision: 2, judge: 1 });
  assert.equal(result.artifacts.attacks.candidate_a.report.attacks.length, 1);
  assert.equal(result.artifacts.revisions.candidate_a.report.proposal, "REVISED_PROPOSAL_A");
  assert.equal(result.artifacts.judge.report.match_id, "r1m1");
  assert.ok(result.artifacts.judge.text.includes("candidate_a"));

  // The judge saw the defenses and revisions, and marked the allegation as
  // unverified rather than letting it read like proof.
  const judgePrompt = mock.prompts.judge[0];
  assert.match(judgePrompt, /defense: FIXED/);
  assert.match(judgePrompt, /UNVERIFIED ALLEGATION/);
  assert.ok(judgePrompt.includes("REVISED_PROPOSAL_A"));
  assert.ok(judgePrompt.includes("REVISED_PROPOSAL_B"));
});

test("a match decision applies cleanly to the tournament state machine", async () => {
  let tournament = state.createTournamentState({
    task: "Fix the retry bug",
    candidates: [{ id: "cand-a" }, { id: "cand-b" }],
    seed: 1,
    id: "arena_match_test",
    now: NOW,
  });
  const bracketMatch = tournament.rounds[0].matches[0];
  const byId = { "cand-a": candidates.a, "cand-b": candidates.b };

  const result = await run({
    match: bracketMatch,
    candidates: { a: byId[bracketMatch.a], b: byId[bracketMatch.b] },
  });
  assert.equal(result.ok, true);

  tournament = state.applyMatchResult(tournament, { ...result.matchResult, now: NOW });
  assert.equal(tournament.rounds[0].matches[0].status, "completed");
  assert.equal(tournament.rounds[0].matches[0].winner, result.matchResult.winnerId);
  assert.equal(
    /** @type {{ verdict: { verdict: string; } } } */ (
      /** @type {unknown} */ (tournament.rounds[0].matches[0])
    ).verdict.verdict,
    "A_WINS",
  );

  tournament = state.closeRound(tournament, { now: NOW });
  assert.equal(tournament.status, state.TOURNAMENT_STATUS.COMPLETED);
  assert.equal(tournament.champion, result.matchResult.winnerId);
});

test("a schema-invalid attack report fails the match, never defaults a winner", async () => {
  const mock = createMock({
    attack: ({ prompt, matchId }) => {
      const value = defaultAttackValue(prompt, matchId);
      value.attacks[0].criterion = "vibes";
      return value;
    },
  });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.equal(result.decision, null);
  assert.equal(result.matchResult, null);
  assert.equal(result.failures[0].kind, matchModule.STAGE_FAILURE.INVALID);
  assert.match(result.errors.join(" "), /attack\/candidate_a/);
  assert.match(result.errors.join(" "), /criterion must be one of/);
});

test("non-JSON output is an invalid_response after the retry budget", async () => {
  const mock = createMock({ attack: () => "prose, not JSON" });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 1 });

  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.equal(result.failures[0].kind, matchModule.STAGE_FAILURE.INVALID);
  // One attempt plus one retry, both counted against the budget.
  assert.equal(result.calls.used, 2);
});

test("a retryable provider failure is retried and counted", async () => {
  let thrown = false;
  const mock = createMock({
    attack: ({ prompt, matchId }) => {
      if (prompt.includes("(candidate_a)") && !thrown) {
        thrown = true;
        throw new Error("429 rate limit exceeded");
      }
      return defaultAttackValue(prompt, matchId);
    },
  });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.calls.used, 8);
  assert.equal(result.artifacts.attacks.candidate_a.attempts, 2);
});

test("a missing credential is classified and not retried", async () => {
  const mock = createMock({
    attack: () => {
      throw new Error("missing api key for provider");
    },
  });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 3 });

  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.equal(result.failures[0].kind, "no_credentials");
  assert.equal(result.calls.used, 1);
});

test("an exhausted rate limit keeps its failure kind and stops", async () => {
  const mock = createMock({
    attack: () => {
      throw new Error("429 too many requests");
    },
  });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 2 });

  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.equal(result.failures[0].kind, "rate_limited");
  assert.equal(result.calls.used, 3);
});

test("the call budget stops a match before it overspends", async () => {
  const mock = createMock();
  const result = await run({ completeFn: mock.completeFn, maxCalls: 2 });

  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.equal(result.calls.used, 2);
  assert.equal(result.calls.max, 2);
  assert.equal(result.failures[0].kind, matchModule.STAGE_FAILURE.BUDGET);
  assert.match(result.errors.join(" "), /call budget of 2 exhausted/);
});

test("a pre-aborted signal cancels without making a call", async () => {
  const controller = new AbortController();
  controller.abort("operator cancelled");
  const mock = createMock();
  const result = await run({ completeFn: mock.completeFn, signal: controller.signal });

  assert.equal(result.status, matchModule.MATCH_STATUS.CANCELLED);
  assert.equal(result.cancelled, true);
  assert.equal(result.calls.used, 0);
  assert.deepEqual(mock.calls, { attack: 0, defense: 0, revision: 0, judge: 0 });
});

test("an abort between stages keeps the artifacts already earned", async () => {
  const controller = new AbortController();
  const mock = createMock();
  const result = await run({
    completeFn: mock.completeFn,
    signal: controller.signal,
    onStage: ({ stage }) => {
      if (stage === "attack") controller.abort();
    },
  });

  assert.equal(result.status, matchModule.MATCH_STATUS.CANCELLED);
  assert.equal(result.calls.used, 1);
  assert.ok(result.artifacts.attacks.candidate_a);
  assert.equal(result.artifacts.attacks.candidate_b, undefined);
});

test("a genuinely level judge result stays explicitly unresolved", async () => {
  const mock = createMock({
    judge: ({ matchId }) =>
      judgeReport(matchId, {
        scores: {
          candidate_a: scores(7, 7, 7, 7, 7),
          candidate_b: scores(7, 7, 7, 7, 7),
        },
        verdict: "TIE",
      }),
  });
  const result = await run({ completeFn: mock.completeFn });

  assert.equal(result.ok, true);
  assert.equal(result.status, matchModule.MATCH_STATUS.UNRESOLVED);
  assert.equal(result.decision.winnerId, null);
  assert.equal(result.matchResult, null);
});

test("a contradictory judge is rejected rather than obeyed", async () => {
  const mock = createMock({
    judge: ({ matchId }) => judgeReport(matchId, { verdict: "B_WINS" }),
  });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 0 });

  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.match(result.errors.join(" "), /contradictory verdict/);
  assert.equal(result.decision, null);
});

test("the validator enforces the attack cap, defense coverage, and closed fields", () => {
  const base = {
    schema_version: schema.MATCH_SCHEMA_VERSION,
    match_id: "r1m1",
    attacker: "candidate_a",
    target: "candidate_b",
    summary: "summary",
    attacks: [],
  };
  assert.equal(schema.validateAttackResponse(base, { matchId: "r1m1" }).valid, true);

  const tooMany = {
    ...base,
    attacks: [base, base].map(() => ({
      criterion: "correctness",
      severity: "MINOR",
      claim: "claim",
      evidence: { kind: "ALLEGATION", payload: "" },
    })),
  };
  assert.match(
    schema.validateAttackResponse(tooMany, { maxAttacks: 1 }).errors.join(" "),
    /at most 1 entries/,
  );

  const badCriterion = {
    ...base,
    attacks: [{ criterion: "vibes", severity: "MINOR", claim: "c", evidence: { kind: "ALLEGATION", payload: "" } }],
  };
  assert.match(
    schema.validateAttackResponse(badCriterion).errors.join(" "),
    /criterion must be one of/,
  );

  const unknownField = {
    ...base,
    confidence: 0.99,
  };
  assert.match(schema.validateAttackResponse(unknownField).errors.join(" "), /unknown field "confidence"/);

  const shortDefense = {
    schema_version: schema.MATCH_SCHEMA_VERSION,
    match_id: "r1m1",
    defender: "candidate_b",
    responses: [],
  };
  assert.match(
    schema.validateDefenseResponse(shortDefense, { attackCount: 1 }).errors.join(" "),
    /exactly 1 entries/,
  );

  const repeated = {
    ...shortDefense,
    responses: [
      { attack_index: 0, stance: "FIXED", explanation: "one" },
      { attack_index: 0, stance: "OPEN", explanation: "two" },
    ],
  };
  assert.match(
    schema.validateDefenseResponse(repeated, { attackCount: 2 }).errors.join(" "),
    /answered twice/,
  );
});

test("a defense that ignores an attack fails the match", async () => {
  const mock = createMock({
    defense: ({ matchId }) => ({
      schema_version: schema.MATCH_SCHEMA_VERSION,
      match_id: matchId,
      defender: "candidate_a",
      responses: [],
    }),
  });
  const result = await run({ completeFn: mock.completeFn, maxRetries: 0 });

  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.equal(result.failures[0].stage, "defense");
  assert.match(result.errors.join(" "), /exactly 1 entries/);
});

test("resuming a fully recorded match replays no calls", async () => {
  const first = await run();
  assert.equal(first.ok, true);

  const noCalls = createMock();
  const resumed = await run({
    completeFn: noCalls.completeFn,
    resume: { artifacts: first.artifacts },
  });

  assert.equal(resumed.ok, true);
  assert.equal(resumed.status, matchModule.MATCH_STATUS.DECIDED);
  assert.equal(resumed.decision.winnerId, first.decision.winnerId);
  assert.deepEqual(noCalls.calls, { attack: 0, defense: 0, revision: 0, judge: 0 });
  assert.equal(resumed.artifacts.attacks.candidate_a.replayed, true);
  assert.equal(resumed.artifacts.judge.replayed, true);
});

test("a partial resume replays only the missing stages", async () => {
  const first = await run();
  const mock = createMock();
  const resumed = await run({
    completeFn: mock.completeFn,
    resume: { artifacts: { attacks: first.artifacts.attacks } },
  });

  assert.equal(resumed.ok, true);
  assert.deepEqual(mock.calls, { attack: 0, defense: 2, revision: 2, judge: 1 });
  assert.equal(resumed.calls.used, 5);
});

test("a corrupt resumed artifact is recomputed, not trusted", async () => {
  const first = await run();
  const corrupt = JSON.parse(JSON.stringify(first.artifacts));
  corrupt.attacks.candidate_a.report.attacks = "not an array";
  const mock = createMock();
  const resumed = await run({ completeFn: mock.completeFn, resume: { artifacts: corrupt } });

  assert.equal(resumed.ok, true);
  assert.equal(mock.calls.attack, 1);
  assert.equal(resumed.calls.used, 1);
});

test("a missing judge model is refused instead of silently self-judged", async () => {
  const result = await run({ judgeModel: null });
  assert.equal(result.status, matchModule.MATCH_STATUS.FAILED);
  assert.match(result.errors.join(" "), /judgeModel is required/);
});

test("calls are estimated from candidates left alive, not from paired rounds", () => {
  const tournament = state.createTournamentState({
    task: "Fix the retry bug",
    candidates: Array.from({ length: 8 }, (_, index) => ({ id: `cand-${index + 1}` })),
    seed: 3,
    id: "arena_estimate",
  });
  assert.deepEqual(matchModule.estimateTournamentCalls(tournament), {
    alive: 8,
    matches: 7,
    calls: 49,
  });

  /** @type {object} */ (tournament.candidates[0]).status = state.CANDIDATE_STATUS.ELIMINATED;
  /** @type {object} */ (tournament.candidates[1]).status = state.CANDIDATE_STATUS.ELIMINATED;
  assert.deepEqual(matchModule.estimateTournamentCalls(tournament), {
    alive: 6,
    matches: 5,
    calls: 35,
  });
});
