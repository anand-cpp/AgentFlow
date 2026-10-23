// Arena bracket driver, arena store, and candidate generation.
//
// The provider is a deterministic mock keyed off the system prompt, so a full
// "quick" tournament runs offline and the resume tests can count calls exactly.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runModule = await import("../src/core/tournament/run.js");
const matchModule = await import("../src/core/tournament/match.js");
const schema = await import("../src/core/tournament/match-schema.js");
const judge = await import("../src/core/tournament/judge.js");
const stateModule = await import("../src/core/tournament/tournament-state.js");
const storeModule = await import("../src/core/tournament/store.js");
const candidatesModule = await import("../src/core/tournament/candidates.js");

const NOW = 1_700_000_000_000;

function scores(correctness, completeness, robustness, specificity, clarity) {
  return { correctness, completeness, robustness, specificity, clarity };
}

function report(matchId, overrides = {}) {
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
    rationale: "A is more robust.",
    judge_model: "fixture-judge",
    ...overrides,
  };
}

function stageOf(opts) {
  if (opts?.system === schema.ATTACK_SYSTEM_PROMPT) return "attack";
  if (opts?.system === schema.DEFENSE_SYSTEM_PROMPT) return "defense";
  if (opts?.system === schema.REVISION_SYSTEM_PROMPT) return "revision";
  if (opts?.system === judge.JUDGE_SYSTEM_PROMPT) return "judge";
  if (opts?.system === candidatesModule.GENERATION_SYSTEM_PROMPT) return "generation";
  return "unknown";
}

function promptMatchId(prompt) {
  return prompt.match(/Match: (\S+)/)?.[1] ?? "r1m1";
}

function attackCountOf(prompt) {
  return (prompt.match(/^\[\d+\]/gm) ?? []).length;
}

function makeProvider({ failOn = null, unresolved = false, onCall = null } = {}) {
  const calls = { attack: 0, defense: 0, revision: 0, judge: 0, generation: 0, unknown: 0 };
  const seen = [];

  const completeFn = async (config, modelId, prompt, opts) => {
    const stage = stageOf(opts);
    const matchId = promptMatchId(prompt);
    calls[stage] += 1;
    seen.push({ stage, matchId, prompt, modelId });
    onCall?.({ stage, matchId, prompt, modelId, calls });

    if (stage === "generation") {
      const id = prompt.match(/You are candidate (\S+) in a competitive/)?.[1] ?? "candidate";
      return { text: `PROPOSAL for ${id}: do the thing.\n\nConcrete steps.` };
    }

    if (stage === "attack") {
      if (failOn && failOn === matchId) {
        throw new Error("401 unauthorized: missing api key");
      }
      const isA = prompt.includes("(candidate_a)");
      return {
        text: JSON.stringify({
          schema_version: schema.MATCH_SCHEMA_VERSION,
          match_id: matchId,
          attacker: isA ? "candidate_a" : "candidate_b",
          target: isA ? "candidate_b" : "candidate_a",
          summary: "one risk",
          attacks: [
            {
              criterion: "robustness",
              severity: "SERIOUS",
              claim: "no retry",
              evidence: { kind: "TEST_CASE", payload: "retry.test.js fails" },
            },
          ],
        }),
      };
    }

    if (stage === "defense") {
      return {
        text: JSON.stringify({
          schema_version: schema.MATCH_SCHEMA_VERSION,
          match_id: matchId,
          defender: prompt.includes("(candidate_a)") ? "candidate_a" : "candidate_b",
          responses: Array.from({ length: attackCountOf(prompt) }, (_, index) => ({
            attack_index: index,
            stance: "FIXED",
            explanation: "handled",
          })),
        }),
      };
    }

    if (stage === "revision") {
      return {
        text: JSON.stringify({
          schema_version: schema.MATCH_SCHEMA_VERSION,
          match_id: matchId,
          candidate: prompt.includes("(candidate_a)") ? "candidate_a" : "candidate_b",
          proposal: prompt.includes("(candidate_a)") ? "REVISED_A" : "REVISED_B",
          changes: ["fixed"],
        }),
      };
    }

    if (stage === "judge") {
      return {
        text: JSON.stringify(
          unresolved
            ? report(matchId, {
                scores: {
                  candidate_a: scores(7, 7, 7, 7, 7),
                  candidate_b: scores(7, 7, 7, 7, 7),
                },
                verdict: "TIE",
              })
            : report(matchId),
        ),
      };
    }

    throw new Error(`unexpected stage ${stage}`);
  };

  return { completeFn, calls, seen };
}

function createState(count = 4) {
  return stateModule.createTournamentState({
    task: "Fix the retry bug",
    candidates: Array.from({ length: count }, (_, index) => ({
      id: `cand-${index + 1}`,
      model: `model-${index + 1}`,
    })),
    mode: "quick",
    seed: 7,
    id: "arena_driver_test",
    now: NOW,
  });
}

function proposalsFor(state) {
  return Object.fromEntries(state.candidates.map((candidate) => [candidate.id, `PROPOSAL ${candidate.id}`]));
}

function run(state, proposals, provider, extra = {}) {
  return runModule.runTournament({
    state,
    proposals,
    completeFn: provider.completeFn,
    judgeModel: "judge-model",
    now: () => NOW,
    sleep: async () => {},
    retryDelayMs: 0,
    ...extra,
  });
}

test("a four-agent quick tournament runs three matches and crowns a champion", async () => {
  const state = createState();
  const provider = makeProvider();
  const result = await run(state, proposalsFor(state), provider);

  assert.equal(result.ok, true);
  assert.equal(result.status, runModule.TOURNAMENT_RUN_STATUS.COMPLETED);
  assert.equal(result.champion, result.state.champion);
  assert.equal(result.matches.length, 3);
  assert.equal(result.calls.matches, 3);
  assert.equal(result.calls.used, 21);
  assert.equal(result.state.rounds.length, 2);
  assert.equal(result.state.status, stateModule.TOURNAMENT_STATUS.COMPLETED);
  assert.equal(result.state.candidates.filter((c) => c.status === "eliminated").length, 3);
});

test("the driver never invents a winner for an unresolved match", async () => {
  const state = createState();
  const result = await run(state, proposalsFor(state), makeProvider({ unresolved: true }));

  assert.equal(result.ok, false);
  assert.equal(result.status, runModule.TOURNAMENT_RUN_STATUS.UNRESOLVED);
  assert.equal(result.champion, null);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].matchId, "r1m1");
  assert.equal(result.state.status, stateModule.TOURNAMENT_STATUS.RUNNING);
  assert.equal(result.state.rounds[0].matches[0].winner, null);
});

test("a failed match stops the run and leaves earlier winners in place", async () => {
  const state = createState();
  const result = await run(
    state,
    proposalsFor(state),
    makeProvider({ failOn: "r1m2" }),
  );

  assert.equal(result.status, runModule.TOURNAMENT_RUN_STATUS.FAILED);
  assert.equal(result.champion, null);
  assert.match(result.errors.join(" "), /401 unauthorized/);
  const failedMatch = result.matches.find((entry) => entry.matchId === "r1m2");
  assert.equal(failedMatch.failures[0].kind, "no_credentials");
  assert.equal(result.state.rounds[0].matches[0].winner !== null, true);
  assert.equal(result.state.rounds[0].matches[1].winner, null);
});

test("resume skips completed matches and replays stored artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-run-"));
  const store = new storeModule.ArenaStore({ dir });
  try {
    const state = createState();
    const proposals = proposalsFor(state);
    store.saveState(state);
    store.saveProposals(state.id, proposals);

    const first = await run(state, proposals, makeProvider({ failOn: "r1m2" }), { store });
    assert.equal(first.status, runModule.TOURNAMENT_RUN_STATUS.FAILED);

    const reloaded = store.loadState(state.id);
    assert.equal(reloaded.rounds[0].matches[0].winner !== null, true);

    const resumedProvider = makeProvider();
    const resumed = await run(reloaded, store.loadProposals(state.id), resumedProvider, { store });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.champion, resumed.state.champion);
    assert.equal(resumed.calls.matches, 2);
    assert.equal(resumed.calls.used, 14);
    assert.equal(
      resumedProvider.seen.some((call) => call.matchId === "r1m1"),
      false,
      "a completed match must not be replayed",
    );
    assert.equal(store.loadState(state.id).status, stateModule.TOURNAMENT_STATUS.COMPLETED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming an unresolved match re-asks the judge and can finish", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-unresolved-"));
  const store = new storeModule.ArenaStore({ dir });
  try {
    const state = createState();
    const proposals = proposalsFor(state);
    const first = await run(state, proposals, makeProvider({ unresolved: true }), { store });
    assert.equal(first.status, runModule.TOURNAMENT_RUN_STATUS.UNRESOLVED);

    const resumedProvider = makeProvider();
    const resumed = await run(first.state, proposals, resumedProvider, { store });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.status, runModule.TOURNAMENT_RUN_STATUS.COMPLETED);
    // The unresolved match re-runs only its judge; its debate artifacts are
    // replayed. The two matches that had not started run normally.
    const replayed = resumedProvider.seen.filter((call) => call.matchId === "r1m1");
    assert.deepEqual(replayed.map((call) => call.stage), ["judge"]);
    assert.deepEqual(resumedProvider.calls, {
      attack: 4,
      defense: 4,
      revision: 4,
      judge: 3,
      generation: 0,
      unknown: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-aborted tournament makes no calls", async () => {
  const controller = new AbortController();
  controller.abort("operator cancelled");
  const provider = makeProvider();
  const state = createState();
  const result = await run(state, proposalsFor(state), provider, { signal: controller.signal });

  assert.equal(result.status, runModule.TOURNAMENT_RUN_STATUS.CANCELLED);
  assert.equal(result.cancelled, true);
  assert.equal(result.calls.used, 0);
  assert.equal(result.state.rounds[0].matches[0].winner, null);
});

test("concurrency is bounded to four matches", () => {
  assert.equal(runModule.clampConcurrency(0), 1);
  assert.equal(runModule.clampConcurrency("2"), 2);
  assert.equal(runModule.clampConcurrency(99), 4);
});

test("candidate generation makes one call per candidate and never fabricates one", async () => {
  const candidates = [
    { id: "cand-1", model: "model-a", card: { reasoning: "r", workflow: "w", optimization: "o" } },
    { id: "cand-2", model: "model-b", card: { reasoning: "r", workflow: "w", optimization: "o" } },
  ];
  const provider = makeProvider();
  const generated = await candidatesModule.generateCandidates({
    task: "Fix the retry bug",
    candidates,
    completeFn: provider.completeFn,
    sleep: async () => {},
  });

  assert.equal(generated.ok, true);
  assert.equal(generated.calls, 2);
  assert.equal(Object.keys(generated.proposals).length, 2);
  assert.match(generated.proposals["cand-1"], /PROPOSAL for cand-1/);
});

test("a failed generation is reported, not replaced with a placeholder", async () => {
  const generated = await candidatesModule.generateCandidates({
    task: "Fix the retry bug",
    candidates: [{ id: "cand-1", model: "model-a" }],
    completeFn: async () => {
      throw new Error("401 unauthorized");
    },
    maxRetries: 0,
    sleep: async () => {},
  });

  assert.equal(generated.ok, false);
  assert.equal(generated.proposals["cand-1"], undefined);
  assert.match(generated.errors.join(" "), /cand-1: 401 unauthorized/);
});

test("candidate generation never exceeds its call budget", async () => {
  let calls = 0;
  const generated = await candidatesModule.generateCandidates({
    task: "Fix the retry bug",
    candidates: [
      { id: "cand-1", model: "model-a" },
      { id: "cand-2", model: "model-b" },
    ],
    completeFn: async () => {
      calls += 1;
      return { text: "a proposal" };
    },
    maxCalls: 1,
    sleep: async () => {},
  });

  assert.equal(calls, 1);
  assert.equal(generated.ok, false);
  assert.match(generated.errors.join(" "), /budget of 1 exhausted/);
});

test("candidate generation can be cancelled between calls", async () => {
  const controller = new AbortController();
  let generated = null;
  generated = await candidatesModule.generateCandidates({
    task: "Fix the retry bug",
    candidates: [
      { id: "cand-1", model: "model-a" },
      { id: "cand-2", model: "model-b" },
    ],
    completeFn: async () => ({ text: "a proposal" }),
    onCandidate: () => controller.abort(),
    signal: controller.signal,
    sleep: async () => {},
  });

  assert.equal(generated.cancelled, true);
  assert.equal(Object.keys(generated.proposals).length, 1);
  assert.match(generated.errors.join(" "), /cancelled/);
});

test("the arena store round-trips state, proposals, and match artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-store-"));
  const store = new storeModule.ArenaStore({ dir });
  try {
    const state = createState(4);
    store.saveState(state);
    store.saveProposals(state.id, proposalsFor(state));
    store.saveMatch(state.id, "r1m1", {
      matchId: "r1m1",
      status: "decided",
      artifacts: { attacks: {}, defenses: {}, revisions: {}, judge: null },
    });

    assert.equal(store.loadState(state.id).id, state.id);
    assert.equal(store.loadProposals(state.id)["cand-1"], "PROPOSAL cand-1");
    assert.equal(store.loadMatch(state.id, "r1m1").status, "decided");
    assert.equal(store.loadState("does-not-exist"), null);
    assert.equal(store.loadMatch(state.id, "r9m9"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the arena store rejects path traversal ids", () => {
  const store = new storeModule.ArenaStore({ dir: os.tmpdir() });
  assert.throws(() => store.statePath("../escape"), /invalid arena id/);
  assert.throws(() => store.matchPath("ok", "../escape"), /invalid match id/);
});

test("the arena store reports corrupt records instead of silently discarding them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-store-corrupt-"));
  const store = new storeModule.ArenaStore({ dir });
  try {
    const state = createState();
    store.saveState(state);

    fs.mkdirSync(path.dirname(store.proposalsPath(state.id)), { recursive: true });
    fs.writeFileSync(store.proposalsPath(state.id), "{not json");
    assert.throws(() => store.loadProposals(state.id), /unreadable/);

    fs.mkdirSync(path.dirname(store.matchPath(state.id, "r1m1")), { recursive: true });
    fs.writeFileSync(store.matchPath(state.id, "r1m1"), JSON.stringify({ version: 999, record: {} }));
    assert.throws(() => store.loadMatch(state.id, "r1m1"), /has version 999/);

    fs.writeFileSync(store.validationPath(state.id), "[1,2,3]");
    assert.throws(() => store.loadValidation(state.id), /unreadable/);

    fs.writeFileSync(store.statePath(state.id), "{");
    assert.throws(() => store.loadState(state.id), /unreadable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing match runner fails the run instead of rejecting it", async () => {
  const state = createState();
  const result = await run(state, proposalsFor(state), makeProvider(), {
    matchRunner: async () => {
      throw new Error("runner exploded");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, runModule.TOURNAMENT_RUN_STATUS.FAILED);
  assert.match(result.errors.join(" "), /runner exploded/);
  assert.equal(result.state.rounds[0].matches[0].winner, null);
  assert.equal(result.calls.used, 0);
});

test("a corrupt match record stops the run instead of replaying the match", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-match-corrupt-"));
  const store = new storeModule.ArenaStore({ dir });
  const state = createState();
  try {
    store.saveState(state);
    fs.mkdirSync(path.dirname(store.matchPath(state.id, "r1m1")), { recursive: true });
    fs.writeFileSync(store.matchPath(state.id, "r1m1"), "{not json");

    const result = await run(state, proposalsFor(state), makeProvider(), { store });

    assert.equal(result.ok, false);
    assert.equal(result.status, runModule.TOURNAMENT_RUN_STATUS.FAILED);
    assert.match(result.errors.join(" "), /unreadable/);
    assert.equal(result.calls.used, 0, "no call may be made before the corrupt record is reported");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
