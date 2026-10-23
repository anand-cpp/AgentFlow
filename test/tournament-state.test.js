// Arena state machine (src/core/tournament/tournament-state.js).
//
// These tests are the resume contract: every transition is exercised on plain
// JSON, with no model calls, so "interrupt after the last match and resume"
// can be asserted rather than hoped for.

import test from "node:test";
import assert from "node:assert/strict";

const t = await import("../src/core/tournament/tournament-state.js");
const strategies = await import("../src/core/tournament/strategies.js");

const TASK = "Fix the flaky router test without weakening its assertion";

function candidates(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `cand-${i + 1}`, model: `model-${i + 1}` }));
}

function make(n = 8, overrides = {}) {
  return t.createTournamentState({
    task: TASK,
    candidates: candidates(n),
    seed: 42,
    id: "arena_test",
    now: 1_700_000_000_000,
    ...overrides,
  });
}

function playRound(state, pick = (match) => match.a) {
  let next = state;
  const round = next.rounds[next.rounds.length - 1];
  for (const match of round.matches) {
    if (match.winner) continue;
    next = t.applyMatchResult(next, {
      matchId: match.id,
      winnerId: pick(match),
      verdict: { rubric: "test", match: match.id },
    });
  }
  return t.closeRound(next);
}

test("creating a tournament deals distinct cards and pairs round one", () => {
  const state = make(8);

  assert.equal(state.version, t.TOURNAMENT_VERSION);
  assert.equal(state.id, "arena_test");
  assert.equal(state.status, t.TOURNAMENT_STATUS.RUNNING);
  assert.equal(state.candidates.length, 8);
  assert.equal(state.rounds.length, 1);
  assert.equal(state.rounds[0].matches.length, 4);

  const cards = state.candidates.map((c) => c.card.id);
  assert.equal(new Set(cards).size, 8, "cards must be distinct");

  assert.deepEqual(state.progress, {
    round: 1,
    rounds: 1,
    matchesCompleted: 0,
    matchesTotal: 4,
    candidatesAlive: 8,
    champion: null,
  });

  assert.equal(t.validateTournamentState(state).ok, true);
});

test("creation is deterministic for a fixed id and seed", () => {
  assert.deepEqual(make(8), make(8));
});

test("custom cards must be complete and distinct", () => {
  const deck = strategies.dealCards(3, { seed: 1 });
  const withCards = deck.map((card, i) => ({ id: `c${i + 1}`, card }));

  const ok = t.createTournamentState({ task: TASK, candidates: withCards, seed: 1 });
  assert.equal(ok.candidates.length, 3);

  assert.throws(
    () =>
      t.createTournamentState({
        task: TASK,
        candidates: [withCards[0], { id: "c2", card: withCards[0].card }, withCards[2]],
      }),
    /distinct/,
  );

  assert.throws(
    () => t.createTournamentState({ task: TASK, candidates: [withCards[0], { id: "c2" }] }),
    /all carry a strategy card or none/,
  );
});

test("invalid tournaments are rejected before any work starts", () => {
  assert.throws(() => make(8, { task: "   " }), /non-empty task/);
  assert.throws(() => make(1), /at least two candidates/);
  assert.throws(() => make(8, { mode: "gigantic" }), /unknown tournament mode/);
  assert.throws(
    () =>
      t.createTournamentState({
        task: TASK,
        candidates: [{ id: "same" }, { id: "same" }],
      }),
    /duplicate candidate id/,
  );
});

test("recording a match eliminates the loser and keeps the winner alive", () => {
  const state = make(8);
  const [first] = state.rounds[0].matches;
  const next = t.applyMatchResult(state, {
    matchId: first.id,
    winnerId: first.a,
    verdict: { scores: { a: 80, b: 70 } },
  });

  assert.equal(next.rounds[0].matches[0].winner, first.a);
  assert.equal(next.rounds[0].matches[0].status, "completed");
  assert.equal(next.rounds[0].matches[0].verdict.scores.a, 80);
  assert.equal(next.candidates.find((c) => c.id === first.a).status, t.CANDIDATE_STATUS.ALIVE);
  assert.equal(next.candidates.find((c) => c.id === first.b).status, t.CANDIDATE_STATUS.ELIMINATED);
  assert.equal(next.progress.matchesCompleted, 1);
  assert.equal(next.progress.candidatesAlive, 7);

  // Pure: the input state is untouched.
  assert.equal(state.rounds[0].matches[0].winner, null);
  assert.equal(state.candidates.find((c) => c.id === first.b).status, t.CANDIDATE_STATUS.ALIVE);
});

test("a winner outside the match is refused", () => {
  const state = make(8);
  const [first] = state.rounds[0].matches;
  assert.throws(
    () => t.applyMatchResult(state, { matchId: first.id, winnerId: "cand-8" }),
    /is not one of/,
  );
});

test("a decided match cannot be decided twice", () => {
  const state = make(8);
  const [first] = state.rounds[0].matches;
  const once = t.applyMatchResult(state, { matchId: first.id, winnerId: first.a });
  assert.throws(
    () => t.applyMatchResult(once, { matchId: first.id, winnerId: first.b }),
    /already has a winner/,
  );
});

test("closing an unfinished round is refused and names the pending matches", () => {
  const state = make(8);
  assert.throws(() => t.closeRound(state), /round 1 is not finished; pending: r1m1, r1m2, r1m3, r1m4/);
});

test("closing a finished round pairs the survivors", () => {
  const state = make(8);
  const next = playRound(state);

  assert.equal(next.rounds.length, 2);
  assert.equal(next.rounds[1].round, 2);
  assert.equal(next.rounds[1].matches.length, 2);
  assert.equal(next.progress.round, 2);
  assert.equal(next.progress.candidatesAlive, 4);

  const entrants = next.rounds[1].matches.flatMap((m) => [m.a, m.b]);
  assert.equal(new Set(entrants).size, 4);
  for (const id of entrants) {
    assert.equal(next.candidates.find((c) => c.id === id).status, t.CANDIDATE_STATUS.ALIVE);
  }
});

test("an eight-candidate tournament runs to a single champion", () => {
  let state = make(8);
  let guard = 0;
  while (state.status === t.TOURNAMENT_STATUS.RUNNING) {
    state = playRound(state, (match) => match.b);
    guard += 1;
    assert.ok(guard < 10, "bracket failed to converge");
  }

  assert.equal(state.status, t.TOURNAMENT_STATUS.COMPLETED);
  assert.equal(state.rounds.length, 3);
  assert.ok(state.champion);
  assert.equal(state.progress.champion, state.champion);

  const champion = state.candidates.find((c) => c.id === state.champion);
  assert.equal(champion.status, t.CANDIDATE_STATUS.CHAMPION);
  assert.equal(
    state.candidates.filter((c) => c.status === t.CANDIDATE_STATUS.CHAMPION).length,
    1,
  );
  assert.equal(
    state.candidates.filter((c) => c.status === t.CANDIDATE_STATUS.ELIMINATED).length,
    7,
  );
  assert.equal(t.validateTournamentState(state).ok, true);
  assert.throws(() => t.closeRound(state), /completed tournament/);
});

test("an odd field carries a bye through to the next round", () => {
  let state = make(5);
  assert.equal(state.rounds[0].matches.length, 3);

  const byeMatch = state.rounds[0].matches.find((m) => m.bye);
  assert.ok(byeMatch);
  assert.equal(byeMatch.winner, byeMatch.a);

  const next = playRound(state);
  assert.equal(next.rounds.length, 2);
  assert.equal(next.rounds[1].matches.length, 2);

  const entrants = next.rounds[1].matches.flatMap((m) => [m.a, m.b]).filter(Boolean);
  assert.ok(entrants.includes(byeMatch.a), "the bye entrant must survive into round 2");
  assert.equal(entrants.length, 3);
});

test("a decided final match survives interruption and resumes without replay", () => {
  let state = make(2);
  const [final] = state.rounds[0].matches;
  state = t.applyMatchResult(state, { matchId: final.id, winnerId: final.a });

  // Exactly the crash point: verdict durable, round not closed.
  const resumed = t.parseTournamentState(t.serializeTournament(state));
  assert.equal(resumed.status, t.TOURNAMENT_STATUS.RUNNING);
  assert.throws(
    () => t.applyMatchResult(resumed, { matchId: final.id, winnerId: final.b }),
    /already has a winner/,
    "resume must not replay a completed match",
  );

  const finished = t.closeRound(resumed);
  assert.equal(finished.status, t.TOURNAMENT_STATUS.COMPLETED);
  assert.equal(finished.champion, final.a);
});

test("serialize/parse round-trips and rejects corrupt state", () => {
  const state = make(8);
  const text = t.serializeTournament(state);
  const parsed = t.parseTournamentState(text);
  assert.deepEqual(parsed, state);

  assert.throws(() => t.parseTournamentState("{not json"), /not valid JSON/);

  const wrongVersion = structuredClone(state);
  wrongVersion.version = 99;
  assert.throws(() => t.parseTournamentState(wrongVersion), /unsupported state version/);
  assert.throws(() => t.serializeTournament(wrongVersion), /refusing to persist invalid state/);
});

test("validation reports broken references instead of repairing them", () => {
  const state = make(8);

  const ghost = structuredClone(state);
  ghost.rounds[0].matches[0].a = "cand-ghost";
  const ghostCheck = t.validateTournamentState(ghost);
  assert.equal(ghostCheck.ok, false);
  assert.ok(ghostCheck.errors.some((e) => e.includes("unknown candidate cand-ghost")));

  const doubleBooked = structuredClone(state);
  doubleBooked.rounds[0].matches[1].id = doubleBooked.rounds[0].matches[0].id;
  assert.ok(
    t.validateTournamentState(doubleBooked).errors.some((e) => e.includes("duplicate match id")),
  );

  const advancedLoser = structuredClone(state);
  advancedLoser.rounds.push({
    round: 2,
    entrantCount: 2,
    matches: [
      {
        id: "r2m1",
        round: 2,
        index: 0,
        a: "cand-1",
        b: "cand-2",
        bye: false,
        status: "pending",
        winner: null,
      },
    ],
  });
  assert.ok(
    t.validateTournamentState(advancedLoser).errors.some((e) =>
      e.includes("did not win round 1"),
    ),
  );

  const duplicateCards = structuredClone(state);
  duplicateCards.candidates[1].card = structuredClone(duplicateCards.candidates[0].card);
  assert.ok(
    t.validateTournamentState(duplicateCards).errors.some((e) =>
      e.includes("strategy cards repeat"),
    ),
  );

  const completedWithoutChampion = structuredClone(state);
  completedWithoutChampion.status = t.TOURNAMENT_STATUS.COMPLETED;
  assert.ok(
    t.validateTournamentState(completedWithoutChampion).errors.some((e) =>
      e.includes("must have a champion"),
    ),
  );
});

test("artifacts are stored as references, not payloads", () => {
  const state = make(4);
  const next = t.recordArtifact(state, {
    candidateId: "cand-1",
    kind: "proposal",
    ref: "session:ses_20260101T000000000Z_abcdef/entry:12",
  });

  assert.equal(next.candidates[0].artifacts.proposal, "session:ses_20260101T000000000Z_abcdef/entry:12");
  assert.equal(state.candidates[0].artifacts.proposal, undefined);
  assert.equal(JSON.stringify(next).includes("session:ses_"), true);

  assert.throws(
    () => t.recordArtifact(state, { candidateId: "nobody", kind: "proposal", ref: "x" }),
    /unknown candidate/,
  );
  assert.throws(() => t.recordArtifact(state, { candidateId: "cand-1", kind: "proposal" }), /ref is required/);
});

test("the judge model is part of the persisted tournament contract", () => {
  const state = make(4, { config: { judgeModel: "judge-model" } });
  assert.equal(state.config.judgeModel, "judge-model");
  assert.equal(t.validateTournamentState(state).ok, true);

  // Records written before the field existed remain valid; the CLI fills it in
  // on the next resume rather than failing the load.
  const legacy = make(4);
  assert.equal(legacy.config.judgeModel, null);
  assert.equal(t.validateTournamentState(legacy).ok, true);
});

test("a recorded judge that is not a usable model id is rejected", () => {
  const state = make(4, { config: { judgeModel: "judge-model" } });
  const broken = structuredClone(state);
  broken.config.judgeModel = "   ";

  const check = t.validateTournamentState(broken);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(" "), /config\.judgeModel/);
});

test("cancellation is recorded and stops further matches", () => {
  const state = make(4);
  const cancelled = t.cancelTournament(state, { reason: "user pressed ctrl-c" });

  assert.equal(cancelled.status, t.TOURNAMENT_STATUS.CANCELLED);
  assert.equal(cancelled.cancelReason, "user pressed ctrl-c");
  assert.equal(t.validateTournamentState(cancelled).ok, true);
  assert.throws(
    () => t.applyMatchResult(cancelled, { matchId: "r1m1", winnerId: cancelled.rounds[0].matches[0].a }),
    /cannot record a match on a cancelled tournament/,
  );
});
