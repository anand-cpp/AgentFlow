// The Arena bracket driver.
//
// tournament-state.js owns the rules; this module runs them. It walks the open
// round, runs pending matches through the match runner, applies each validated
// winner, closes rounds, and stops the moment something cannot be decided
// honestly:
//
//   * a failed match stops the run instead of spending the rest of the budget
//     on a bracket that cannot be completed;
//   * an unresolved match stops the run with an explicit unresolved outcome --
//     no coin flip, no "first candidate wins" fallback;
//   * completed matches are skipped on resume, and per-match artifacts are
//     reused, so a resumed tournament does not pay twice for work it already
//     did.
//
// Concurrency is bounded (1-4 matches at a time). It is intentionally not
// unbounded: provider rate limits are real, and the bracket's cost estimate
// assumes matches are independent, not free.

import { DEFAULT_MAX_CALLS, runMatch, MATCH_STATUS } from "./match.js";
import {
  CANDIDATE_STATUS,
  TOURNAMENT_STATUS,
  applyMatchResult,
  closeRound,
  parseTournamentState,
} from "./tournament-state.js";

export const TOURNAMENT_RUN_STATUS = Object.freeze({
  COMPLETED: "completed",
  UNRESOLVED: "unresolved",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const MAX_CONCURRENCY = 4;

export function clampConcurrency(value) {
  const n = Math.trunc(Number(value) || 1);
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

function candidateRecord(state, id) {
  return (state.candidates ?? []).find((candidate) => candidate.id === id) ?? null;
}

function matchResultRecord(result, now) {
  return {
    matchId: result?.matchId ?? null,
    status: result?.status ?? MATCH_STATUS.FAILED,
    decision: result?.decision ?? null,
    matchResult: result?.matchResult ?? null,
    artifacts: result?.artifacts ?? null,
    errors: result?.errors ?? [],
    failures: result?.failures ?? [],
    calls: result?.calls ?? null,
    cancelled: result?.cancelled === true,
    at: new Date(now).toISOString(),
  };
}

/**
 * Run (or resume) a tournament until it has a champion, a failure, or an
 * explicit unresolved outcome.
 *
 * @param {object} input
 * @param {object} input.state                     validated or serialized tournament state
 * @param {Record<string, string>} input.proposals  candidate id -> proposal text
 * @param {Function} input.completeFn
 * @param {string} input.judgeModel
 * @param {object} [input.config]
 * @param {Function} [input.judgeCompleteFn]
 * @param {number} [input.concurrency]
 * @param {number} [input.maxCallsPerMatch]
 * @param {number} [input.maxAttacks]
 * @param {number} [input.maxRetries]
 * @param {number} [input.retryDelayMs]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.temperature]
 * @param {object} [input.tokens]
 * @param {AbortSignal} [input.signal]
 * @param {object} [input.store]                    ArenaStore-like { loadMatch, saveMatch, saveState }
 * @param {Function} [input.onMatch]                awaited with each completed match attempt
 * @param {Function} [input.onState]                awaited with each changed state
 * @param {Function} [input.matchRunner]            injectable for tests; defaults to runMatch
 * @param {Function} [input.now]
 */
export async function runTournament({
  state: initialState,
  proposals = {},
  completeFn,
  judgeModel,
  config = null,
  judgeCompleteFn = null,
  concurrency = 1,
  maxCallsPerMatch = DEFAULT_MAX_CALLS,
  maxAttacks = undefined,
  maxRetries = undefined,
  retryDelayMs = undefined,
  timeoutMs = undefined,
  temperature = undefined,
  tokens = undefined,
  signal = null,
  store = null,
  onMatch = null,
  onState = null,
  matchRunner = runMatch,
  now = () => Date.now(),
} = {}) {
  const clock = typeof now === "function" ? now : () => now;
  let state;
  try {
    state = parseTournamentState(initialState);
  } catch (err) {
    return {
      ok: false,
      status: TOURNAMENT_RUN_STATUS.FAILED,
      state: null,
      champion: null,
      matches: [],
      unresolved: [],
      errors: [err.message],
      calls: { used: 0, matches: 0 },
    };
  }

  const attempts = [];
  const errors = [];
  const unresolved = [];
  let callsUsed = 0;
  let matchesRun = 0;
  const persist = async (next) => {
    state = next;
    if (store) store.saveState(state);
    await onState?.(state);
  };

  if (state.status === TOURNAMENT_STATUS.COMPLETED) {
    return {
      ok: true,
      status: TOURNAMENT_RUN_STATUS.COMPLETED,
      state,
      champion: state.champion,
      matches: attempts,
      unresolved,
      errors,
      calls: { used: 0, matches: 0 },
    };
  }

  const runOne = async (match) => {
    const sideA = candidateRecord(state, match.a);
    const sideB = candidateRecord(state, match.b);
    const proposalA = proposals[match.a] ?? proposals[sideA?.id] ?? null;
    const proposalB = proposals[match.b] ?? proposals[sideB?.id] ?? null;

    if (!proposalA || !proposalB) {
      return {
        ok: false,
        status: MATCH_STATUS.FAILED,
        matchId: match.id,
        artifacts: null,
        decision: null,
        errors: [
          `match ${match.id}: missing proposal for ${!proposalA ? match.a : match.b}; cannot run a match without both answers`,
        ],
        failures: [],
        calls: { used: 0, max: 0 },
      };
    }

    let result;
    try {
      // A missing match file is normal. A corrupt one throws, which is caught
      // below: replaying a match because its record was quietly discarded would
      // spend money on work that may already have been done.
      const resumed = store?.loadMatch(state.id, match.id) ?? null;
      result = await matchRunner({
        task: state.task,
        match: { id: match.id, a: match.a, b: match.b },
        candidates: {
          a: { id: match.a, model: sideA?.model ?? null, proposal: proposalA, card: sideA?.card ?? null },
          b: { id: match.b, model: sideB?.model ?? null, proposal: proposalB, card: sideB?.card ?? null },
        },
        completeFn,
        judgeCompleteFn,
        judgeModel,
        config,
        maxAttacks: maxAttacks ?? state.config?.maxAttacks,
        maxCalls: maxCallsPerMatch,
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(tokens === undefined ? {} : { tokens }),
        signal,
        resume: resumed ? { artifacts: resumed.artifacts ?? null } : null,
        now: clock(),
      });
    } catch (err) {
      // A throwing runner or a corrupt artifact record is a failure to decide,
      // not a decision. Record it and stop rather than rejecting the whole
      // bracket with an unhandled exception.
      result = {
        ok: false,
        status: MATCH_STATUS.FAILED,
        matchId: match.id,
        artifacts: null,
        decision: null,
        errors: [`match ${match.id} failed unexpectedly: ${err?.message ?? String(err)}`],
        failures: [],
        calls: { used: 0, max: 0 },
      };
    }

    callsUsed += result?.calls?.used ?? 0;
    matchesRun += 1;

    if (store) {
      try {
        store.saveMatch(state.id, match.id, matchResultRecord(result, clock()));
      } catch (err) {
        // Keep the calls already spent in the accounting, but turn the result
        // into a failure so the bracket never advances on an unpersisted match.
        result = {
          ok: false,
          status: MATCH_STATUS.FAILED,
          matchId: match.id,
          artifacts: result?.artifacts ?? null,
          decision: null,
          errors: [
            ...(result?.errors ?? []),
            `could not persist match ${match.id}: ${err?.message ?? String(err)}`,
          ],
          failures: result?.failures ?? [],
          calls: result?.calls ?? null,
        };
      }
    }

    const record = matchResultRecord(result, clock());
    attempts.push(record);
    await onMatch?.({ match, record, result });
    return result;
  };

  while (state.status === TOURNAMENT_STATUS.RUNNING) {
    const round = state.rounds[state.rounds.length - 1];
    const pending = (round?.matches ?? []).filter((match) => !match.bye && !match.winner);

    if (!pending.length) {
      try {
        await persist(closeRound(state, { now: clock() }));
      } catch (err) {
        errors.push(`could not close round ${round?.round}: ${err.message}`);
        return {
          ok: false,
          status: TOURNAMENT_RUN_STATUS.FAILED,
          state,
          champion: null,
          matches: attempts,
          unresolved,
          errors,
          calls: { used: callsUsed, matches: matchesRun },
        };
      }
      continue;
    }

    const width = clampConcurrency(concurrency);
    for (let offset = 0; offset < pending.length; offset += width) {
      const batch = pending.slice(offset, offset + width);
      const results = await Promise.all(batch.map((match) => runOne(match)));

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const match = batch[index];

        if (result?.cancelled || (signal?.aborted && result?.status === MATCH_STATUS.CANCELLED)) {
          return {
            ok: false,
            status: TOURNAMENT_RUN_STATUS.CANCELLED,
            state,
            champion: null,
            matches: attempts,
            unresolved,
            errors,
            cancelled: true,
            calls: { used: callsUsed, matches: matchesRun },
          };
        }

        if (result?.status === MATCH_STATUS.UNRESOLVED) {
          unresolved.push({ matchId: match.id, decision: result.decision ?? null });
          return {
            ok: false,
            status: TOURNAMENT_RUN_STATUS.UNRESOLVED,
            state,
            champion: null,
            matches: attempts,
            unresolved,
            errors,
            calls: { used: callsUsed, matches: matchesRun },
          };
        }

        if (!result?.ok || !result.matchResult) {
          errors.push(
            ...(result?.errors?.length
              ? result.errors
              : [`match ${match.id} did not produce a winner`]),
          );
          return {
            ok: false,
            status: TOURNAMENT_RUN_STATUS.FAILED,
            state,
            champion: null,
            matches: attempts,
            unresolved,
            errors,
            calls: { used: callsUsed, matches: matchesRun },
          };
        }

        try {
          await persist(
            applyMatchResult(state, {
              matchId: match.id,
              winnerId: result.matchResult.winnerId,
              verdict: result.matchResult.verdict,
              now: clock(),
            }),
          );
        } catch (err) {
          errors.push(`could not record winner for ${match.id}: ${err.message}`);
          return {
            ok: false,
            status: TOURNAMENT_RUN_STATUS.FAILED,
            state,
            champion: null,
            matches: attempts,
            unresolved,
            errors,
            calls: { used: callsUsed, matches: matchesRun },
          };
        }
      }
    }
  }

  if (state.status === TOURNAMENT_STATUS.COMPLETED) {
    return {
      ok: true,
      status: TOURNAMENT_RUN_STATUS.COMPLETED,
      state,
      champion: state.champion,
      matches: attempts,
      unresolved,
      errors,
      calls: { used: callsUsed, matches: matchesRun },
    };
  }

  errors.push(`tournament ended in status ${String(state.status)}`);
  return {
    ok: false,
    status: TOURNAMENT_RUN_STATUS.FAILED,
    state,
    champion: null,
    matches: attempts,
    unresolved,
    errors,
    calls: { used: callsUsed, matches: matchesRun },
  };
}

/**
 * Compact, render-friendly summary of a tournament run.
 *
 * @param {object} run result of runTournament()
 */
export function summarizeRun(run) {
  const state = run?.state;
  const candidates = state?.candidates ?? [];
  const eliminated = candidates.filter((c) => c.status === CANDIDATE_STATUS.ELIMINATED).length;
  return {
    tournamentId: state?.id ?? null,
    status: run?.status ?? "failed",
    champion: run?.champion ?? null,
    mode: state?.config?.mode ?? null,
    seed: state?.config?.seed ?? null,
    agents: candidates.length,
    eliminated,
    rounds: (state?.rounds ?? []).map((round) => ({
      round: round.round,
      entrants: round.entrantCount,
      matches: (round.matches ?? []).map((match) => ({
        id: match.id,
        a: match.a,
        b: match.b,
        bye: match.bye === true,
        winner: match.winner ?? null,
        verdict: match.verdict?.verdict ?? null,
        reason: match.verdict?.reason ?? null,
      })),
    })),
    matchesRun: run?.matches?.length ?? 0,
    calls: run?.calls ?? { used: 0, matches: 0 },
    unresolved: run?.unresolved ?? [],
    errors: run?.errors ?? [],
  };
}

/**
 * Parse a stored judge artifact from a match record. Kept here so the resume
 * path and the tests agree about where artifacts live.
 */
export function artifactsOf(record) {
  if (!record || typeof record !== "object") return null;
  return record.artifacts ?? null;
}

export default {
  TOURNAMENT_RUN_STATUS,
  clampConcurrency,
  runTournament,
  summarizeRun,
  artifactsOf,
};
