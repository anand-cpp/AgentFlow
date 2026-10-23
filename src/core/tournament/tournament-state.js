// Arena tournament state machine.
//
// This module owns the bracket: what the tournament is, which candidates are
// alive, which match is next, and what a match result does to the bracket. It
// is deliberately free of model calls, file IO, and CLI concerns, which is what
// makes interruption/resume testable -- the only thing that survives a crash is
// this JSON, so the state has to be complete and it has to validate itself.
//
// Two rules are enforced here rather than trusted to callers:
//
//   * Every transition is explicit. Recording a winner, closing a round, and
//     declaring a champion are separate calls. There is no "run" method that
//     decides who won; the judge produces a verdict, the caller records it.
//   * Persisted state is validated on load. A bracket that references a
//     candidate that does not exist, or advances a loser, is rejected instead
//     of being repaired silently.
//
// Large artifacts (proposals, attacks, judge rationale) are not stored here.
// Candidates carry *references* into the session store, so the state file stays
// small enough to read on every step of a long tournament.

import { randomUUID } from "node:crypto";

import { PAIRING_VERSION, isRoundComplete, pairRound, winnersOf } from "./pairing.js";
import { STRATEGY_CARD_VERSION, cardsAreUnique, dealCards } from "./strategies.js";

export const TOURNAMENT_VERSION = 1;

export const TOURNAMENT_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

export const CANDIDATE_STATUS = Object.freeze({
  ALIVE: "alive",
  ELIMINATED: "eliminated",
  CHAMPION: "champion",
});

export const TOURNAMENT_MODES = Object.freeze({
  QUICK: "quick",
  STANDARD: "standard",
  INTENSIVE: "intensive",
});

/**
 * Tournament sizes, named by what they cost rather than by how impressive they
 * sound. `maxRounds` is a guard rail: a run that exceeds it is a bug, not a
 * bigger tournament.
 */
export const MODE_PRESETS = Object.freeze({
  quick: { agents: 8, maxRounds: 4, maxAttacks: 1 },
  standard: { agents: 16, maxRounds: 5, maxAttacks: 2 },
  intensive: { agents: 32, maxRounds: 6, maxAttacks: 3 },
});

const STATUS_VALUES = new Set(Object.values(TOURNAMENT_STATUS));
const CANDIDATE_STATUS_VALUES = new Set(Object.values(CANDIDATE_STATUS));
const MODE_VALUES = new Set(Object.values(TOURNAMENT_MODES));

export class TournamentStateError extends Error {
  constructor(message, code = "invalid_tournament_state") {
    super(message);
    this.name = "TournamentStateError";
    this.code = code;
  }
}

function clone(state) {
  return structuredClone(state);
}

function candidateIds(state) {
  return new Set((state?.candidates ?? []).map((c) => c.id));
}

function currentRound(state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  return rounds.length ? rounds[rounds.length - 1] : null;
}

/**
 * Progress is derived, never hand-maintained. Storing it as well would create a
 * second source of truth that a resumed run could disagree with.
 *
 * @param {object} state
 */
export function tournamentProgress(state) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : [];
  const round = rounds.length ? rounds[rounds.length - 1].round : 1;
  const matches = rounds.flatMap((r) => r.matches ?? []);
  const completed = matches.filter((m) => m.winner).length;
  const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
  return {
    round,
    rounds: rounds.length,
    matchesCompleted: completed,
    matchesTotal: matches.length,
    candidatesAlive: candidates.filter((c) => c.status !== CANDIDATE_STATUS.ELIMINATED).length,
    champion: state?.champion ?? null,
  };
}

function refreshProgress(state) {
  state.progress = tournamentProgress(state);
  return state;
}

/**
 * Create a tournament from a task and a candidate list.
 *
 * Candidates may be strings, `{ id, model }` objects, or objects that already
 * carry a `card`. If no cards are supplied the deck is dealt here, which is the
 * normal path: candidates differ by strategy, not by hand-written prompts. If
 * cards *are* supplied they must all be present and distinct -- a bracket where
 * two competitors share a card is not a competition, it is a duplicate run.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {Array<string|object>} input.candidates
 * @param {string} [input.mode]
 * @param {number|string} [input.seed]
 * @param {string} [input.id]
 * @param {number} [input.now]
 * @param {object} [input.config]
 */
export function createTournamentState({
  task,
  candidates,
  mode = TOURNAMENT_MODES.QUICK,
  seed = 0,
  id = null,
  now = Date.now(),
  config = {},
} = {}) {
  const taskText = String(task ?? "").trim();
  if (!taskText) throw new TournamentStateError("a tournament requires a non-empty task", "missing_task");

  if (!MODE_VALUES.has(mode)) {
    throw new TournamentStateError(
      `unknown tournament mode: ${String(mode)} (expected one of ${[...MODE_VALUES].join(", ")})`,
      "unknown_mode",
    );
  }

  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length < 2) {
    throw new TournamentStateError(
      `a tournament needs at least two candidates, got ${list.length}`,
      "too_few_candidates",
    );
  }

  const suppliedCards = list.filter((c) => c && typeof c === "object" && c.card).map((c) => c.card);
  const hasAnyCard = suppliedCards.length > 0;
  if (hasAnyCard && suppliedCards.length !== list.length) {
    throw new TournamentStateError(
      "candidates must either all carry a strategy card or none; partial cards would make the bracket ambiguous",
      "partial_cards",
    );
  }
  if (hasAnyCard && !cardsAreUnique(suppliedCards)) {
    throw new TournamentStateError("strategy cards must be distinct within a tournament", "duplicate_cards");
  }

  const dealt = hasAnyCard ? suppliedCards : dealCards(list.length, { seed });

  const seen = new Set();
  const normalized = list.map((entry, index) => {
    const source = typeof entry === "string" ? { id: entry } : entry ?? {};
    const candidateId = String(source.id ?? `cand-${index + 1}`);
    if (seen.has(candidateId)) {
      throw new TournamentStateError(`duplicate candidate id: ${candidateId}`, "duplicate_candidate");
    }
    seen.add(candidateId);

    const card = dealt[index];
    return {
      id: candidateId,
      model: source.model ?? null,
      status: CANDIDATE_STATUS.ALIVE,
      card: {
        version: card.version ?? STRATEGY_CARD_VERSION,
        id: card.id,
        reasoning: card.reasoning,
        workflow: card.workflow,
        optimization: card.optimization,
      },
      artifacts: {},
    };
  });

  const tournamentId = String(id ?? `arena_${randomUUID()}`);
  const first = pairRound(normalized.map((c) => c.id), { round: 1, seed });

  const state = {
    version: TOURNAMENT_VERSION,
    id: tournamentId,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    status: TOURNAMENT_STATUS.RUNNING,
    task: taskText,
    config: {
      mode,
      seed,
      agentCount: normalized.length,
      maxRounds: Number(config.maxRounds ?? MODE_PRESETS[mode].maxRounds),
      maxAttacks: Number(config.maxAttacks ?? MODE_PRESETS[mode].maxAttacks),
      concurrency: Number(config.concurrency ?? 1),
      paidAllowed: config.paidAllowed === true,
      cardVersion: STRATEGY_CARD_VERSION,
      pairingVersion: PAIRING_VERSION,
    },
    candidates: normalized,
    rounds: [
      {
        round: 1,
        entrantCount: normalized.length,
        matches: first.matches,
      },
    ],
    champion: null,
    progress: null,
  };

  refreshProgress(state);
  const check = validateTournamentState(state);
  if (!check.ok) {
    throw new TournamentStateError(`created state is invalid: ${check.errors.join("; ")}`, "invalid_state");
  }
  return state;
}

/**
 * Validate a state object before it is resumed or advanced.
 *
 * Returns every problem it finds rather than throwing on the first one: when a
 * run cannot be resumed, the operator needs the whole list to decide whether to
 * repair or restart.
 *
 * @param {unknown} state
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTournamentState(state) {
  const errors = [];
  const push = (message) => errors.push(message);

  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { ok: false, errors: ["state must be an object"] };
  }
  if (state.version !== TOURNAMENT_VERSION) {
    push(`unsupported state version ${String(state.version)} (expected ${TOURNAMENT_VERSION})`);
  }
  if (!state.id || typeof state.id !== "string") push("state.id must be a non-empty string");
  if (!STATUS_VALUES.has(state.status)) push(`unknown status: ${String(state.status)}`);
  if (!String(state.task ?? "").trim()) push("state.task must be non-empty");
  if (!state.config || typeof state.config !== "object") push("state.config must be an object");
  else {
    if (!MODE_VALUES.has(state.config.mode)) push(`unknown mode: ${String(state.config.mode)}`);
    if (!Number.isInteger(state.config.agentCount)) push("config.agentCount must be an integer");
  }

  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  if (candidates.length < 2) push("state.candidates must contain at least two candidates");
  const ids = new Set();
  for (const candidate of candidates) {
    const id = candidate?.id;
    if (!id || typeof id !== "string") {
      push("every candidate needs a string id");
      continue;
    }
    if (ids.has(id)) push(`duplicate candidate id: ${id}`);
    ids.add(id);
    if (!CANDIDATE_STATUS_VALUES.has(candidate.status)) {
      push(`candidate ${id} has unknown status: ${String(candidate.status)}`);
    }
    if (!candidate.card?.id) push(`candidate ${id} is missing a strategy card`);
  }
  if (candidates.length > 0 && !cardsAreUnique(candidates.map((c) => c.card ?? {}).filter((c) => c.id))) {
    push("strategy cards repeat within the tournament");
  }
  if (Array.isArray(state.candidates) && state.config?.agentCount !== state.candidates.length) {
    push("config.agentCount does not match the candidate list");
  }

  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  if (!rounds.length) push("state.rounds must contain at least the first round");

  const matchIds = new Set();
  const seenByRound = new Map();
  rounds.forEach((round, roundIndex) => {
    const expected = roundIndex + 1;
    if (round?.round !== expected) push(`round ${expected} is out of order (found ${String(round?.round)})`);
    const matches = Array.isArray(round?.matches) ? round.matches : [];
    if (!matches.length) push(`round ${expected} has no matches`);
    if (round?.entrantCount !== undefined && round.entrantCount < 2) {
      push(`round ${expected} has an invalid entrant count`);
    }

    const seen = new Set();
    for (const match of matches) {
      if (!match?.id || typeof match.id !== "string") push(`round ${expected} has a match without an id`);
      else if (matchIds.has(match.id)) push(`duplicate match id: ${match.id}`);
      else matchIds.add(match.id);

      if (match?.round !== expected) push(`match ${String(match?.id)} is filed under the wrong round`);
      if (!ids.has(match?.a)) push(`match ${String(match?.id)} references unknown candidate ${String(match?.a)}`);
      if (match?.b !== null && !ids.has(match?.b)) {
        push(`match ${String(match?.id)} references unknown candidate ${String(match?.b)}`);
      }
      if (match?.a === match?.b) push(`match ${String(match?.id)} pairs a candidate with itself`);
      if (seen.has(match?.a)) push(`candidate ${String(match?.a)} appears twice in round ${expected}`);
      seen.add(match?.a);
      if (match?.b) {
        if (seen.has(match.b)) push(`candidate ${String(match.b)} appears twice in round ${expected}`);
        seen.add(match.b);
      }

      if (match?.bye) {
        if (match.b !== null) push(`bye ${String(match.id)} must not have an opponent`);
        if (match.winner !== match.a) push(`bye ${String(match.id)} must advance its only entrant`);
        if (match.status !== "completed") push(`bye ${String(match.id)} must be completed`);
      } else {
        if (match?.winner && match.winner !== match.a && match.winner !== match.b) {
          push(`match ${String(match.id)} winner is neither entrant`);
        }
        if (match?.status === "completed" && !match.winner) {
          push(`match ${String(match.id)} is completed without a winner`);
        }
        if (match?.winner && match.status !== "completed") {
          push(`match ${String(match.id)} has a winner but is not completed`);
        }
      }
    }
    seenByRound.set(expected, seen);

    if (roundIndex > 0) {
      const previous = rounds[roundIndex - 1];
      const previousWinners = new Set(winnersOf(previous));
      for (const id of seen) {
        if (!previousWinners.has(id)) {
          push(`round ${expected} contains ${id}, who did not win round ${expected - 1}`);
        }
      }
    }
  });

  if (state.status === TOURNAMENT_STATUS.COMPLETED) {
    if (!state.champion) push("a completed tournament must have a champion");
    else if (!ids.has(state.champion)) push(`champion ${state.champion} is not a candidate`);
  } else if (state.champion) {
    push("only a completed tournament may have a champion");
  }
  // A decided final match with status "running" is a legitimate crash point:
  // the verdict is durable but closeRound() has not run yet. Resume closes the
  // round instead of replaying the match, so validation must accept it.

  return { ok: errors.length === 0, errors };
}

/**
 * Record one judged match. Pure: returns a new state and leaves the input alone.
 *
 * The winner must be one of the two entrants. A draw needs a tie-break before
 * it reaches this function -- the state machine will not guess, because a
 * silent coin-flip here is exactly the "orchestrator chose the winner" failure
 * the tournament is meant to prevent.
 *
 * @param {object} state
 * @param {{ matchId: string, winnerId: string, verdict?: object|null, now?: number }} input
 */
export function applyMatchResult(state, { matchId, winnerId, verdict = null, now = Date.now() } = {}) {
  if (state?.status !== TOURNAMENT_STATUS.RUNNING) {
    throw new TournamentStateError(`cannot record a match on a ${String(state?.status)} tournament`, "not_running");
  }
  const round = currentRound(state);
  if (!round) throw new TournamentStateError("tournament has no open round", "no_round");

  const match = (round.matches ?? []).find((m) => m.id === matchId);
  if (!match) {
    throw new TournamentStateError(`match ${String(matchId)} is not in the open round (${round.round})`, "unknown_match");
  }
  if (match.status === "completed") {
    throw new TournamentStateError(`match ${matchId} already has a winner`, "match_already_decided");
  }
  if (winnerId !== match.a && winnerId !== match.b) {
    throw new TournamentStateError(
      `match ${matchId}: winner ${String(winnerId)} is not one of ${match.a} / ${match.b}`,
      "invalid_winner",
    );
  }

  const next = clone(state);
  const target = next.rounds[next.rounds.length - 1].matches.find((m) => m.id === matchId);
  const loserId = winnerId === target.a ? target.b : target.a;
  target.winner = winnerId;
  target.status = "completed";
  target.verdict = verdict ?? null;
  target.completedAt = new Date(now).toISOString();

  const loser = next.candidates.find((c) => c.id === loserId);
  if (loser) loser.status = CANDIDATE_STATUS.ELIMINATED;

  next.updatedAt = new Date(now).toISOString();
  refreshProgress(next);
  return next;
}

/**
 * Close the open round and pair the survivors, or crown a champion.
 *
 * Refuses to run before every match is decided. That is not defensive
 * programming: advancing early would let a model-free code path invent a
 * winner, which is the one thing the bracket must never do.
 *
 * @param {object} state
 * @param {{ now?: number }} [options]
 */
export function closeRound(state, { now = Date.now() } = {}) {
  if (state?.status !== TOURNAMENT_STATUS.RUNNING) {
    throw new TournamentStateError(`cannot close a round on a ${String(state?.status)} tournament`, "not_running");
  }
  const round = currentRound(state);
  if (!round) throw new TournamentStateError("tournament has no open round", "no_round");
  if (!isRoundComplete(round)) {
    const pending = (round.matches ?? []).filter((m) => !m.winner).map((m) => m.id);
    throw new TournamentStateError(
      `round ${round.round} is not finished; pending: ${pending.join(", ")}`,
      "round_incomplete",
    );
  }

  const next = clone(state);
  const open = next.rounds[next.rounds.length - 1];
  const winners = winnersOf(open);
  const maxRounds = Number(next.config?.maxRounds ?? MODE_PRESETS.quick.maxRounds);

  next.updatedAt = new Date(now).toISOString();

  if (winners.length === 1) {
    const champion = winners[0];
    next.status = TOURNAMENT_STATUS.COMPLETED;
    next.champion = champion;
    next.completedAt = next.updatedAt;
    for (const candidate of next.candidates) {
      if (candidate.id === champion) candidate.status = CANDIDATE_STATUS.CHAMPION;
      else if (candidate.status !== CANDIDATE_STATUS.ELIMINATED) candidate.status = CANDIDATE_STATUS.ELIMINATED;
    }
    return refreshProgress(next);
  }

  if (next.rounds.length >= maxRounds) {
    throw new TournamentStateError(
      `tournament exceeded its ${maxRounds}-round budget with ${winners.length} candidates alive`,
      "round_budget_exceeded",
    );
  }

  const paired = pairRound(winners, { round: open.round + 1, seed: next.config.seed ?? 0 });
  next.rounds.push({
    round: paired.round,
    entrantCount: winners.length,
    matches: paired.matches,
  });
  return refreshProgress(next);
}

/**
 * Attach a reference to a large artifact held elsewhere (session entry, file).
 * The state deliberately stores the pointer, never the payload.
 *
 * @param {object} state
 * @param {{ candidateId: string, kind: string, ref: string, now?: number }} input
 */
export function recordArtifact(state, { candidateId, kind, ref, now = Date.now() } = {}) {
  const candidate = (state?.candidates ?? []).find((c) => c.id === candidateId);
  if (!candidate) throw new TournamentStateError(`unknown candidate: ${String(candidateId)}`, "unknown_candidate");
  const label = String(kind ?? "").trim();
  const pointer = String(ref ?? "").trim();
  if (!label) throw new TournamentStateError("artifact kind is required", "missing_artifact_kind");
  if (!pointer) throw new TournamentStateError("artifact ref is required", "missing_artifact_ref");

  const next = clone(state);
  const target = next.candidates.find((c) => c.id === candidateId);
  target.artifacts = target.artifacts && typeof target.artifacts === "object" ? target.artifacts : {};
  target.artifacts[label] = pointer;
  next.updatedAt = new Date(now).toISOString();
  return next;
}

/** Mark a run cancelled. Cancellation is recorded, never inferred. */
export function cancelTournament(state, { reason = null, now = Date.now() } = {}) {
  if (state?.status === TOURNAMENT_STATUS.COMPLETED) {
    throw new TournamentStateError("a completed tournament cannot be cancelled", "already_completed");
  }
  const next = clone(state);
  next.status = TOURNAMENT_STATUS.CANCELLED;
  next.cancelledAt = new Date(now).toISOString();
  next.cancelReason = reason ? String(reason) : null;
  next.updatedAt = next.cancelledAt;
  return refreshProgress(next);
}

/** JSON text for persistence. */
export function serializeTournament(state) {
  const check = validateTournamentState(state);
  if (!check.ok) {
    throw new TournamentStateError(`refusing to persist invalid state: ${check.errors.join("; ")}`, "invalid_state");
  }
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Parse persisted state and validate it before anything resumes from it.
 *
 * @param {string|object} value
 * @returns {object}
 */
export function parseTournamentState(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new TournamentStateError(`tournament state is not valid JSON: ${err.message}`, "invalid_json");
    }
  }
  const check = validateTournamentState(parsed);
  if (!check.ok) {
    throw new TournamentStateError(`tournament state is invalid: ${check.errors.join("; ")}`, "invalid_state");
  }
  return parsed;
}

export default {
  TOURNAMENT_VERSION,
  TOURNAMENT_STATUS,
  CANDIDATE_STATUS,
  TOURNAMENT_MODES,
  MODE_PRESETS,
  TournamentStateError,
  tournamentProgress,
  createTournamentState,
  validateTournamentState,
  applyMatchResult,
  closeRound,
  recordArtifact,
  cancelTournament,
  serializeTournament,
  parseTournamentState,
};
