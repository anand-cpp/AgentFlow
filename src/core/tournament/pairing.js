// Single-elimination pairing for Arena tournaments.
//
// This module only decides *who fights whom*. It makes no model calls and keeps
// no state: the bracket owner is tournament-state.js, and giving the pairing
// rules their own pure module is what makes "seeded pairings are reproducible"
// a test rather than a promise.
//
// Shape of a round: entrants are shuffled deterministically, an odd entrant out
// gets a bye, and the rest are paired in order. A bye is recorded as a real
// match with `bye: true` and a pre-decided winner, so the round-completion
// check does not need a special case -- and so the bye is visible in the report
// instead of quietly disappearing from the bracket.

import { seededShuffle } from "./random.js";

export const PAIRING_VERSION = 1;

/** Smallest power of two greater than or equal to n (n >= 1). */
export function nextPowerOfTwo(n) {
  const value = Math.max(1, Math.trunc(Number(n) || 0));
  let power = 1;
  while (power < value) power *= 2;
  return power;
}

/** The stable id for the i-th match of a round. */
export function matchId(round, index) {
  return `r${Number(round)}m${Number(index) + 1}`;
}

/**
 * Pair one round.
 *
 * @param {Array<string>} entrantIds  candidates still alive, in bracket order
 * @param {{ round?: number, seed?: number|string }} [options]
 * @returns {{
 *   round: number,
 *   seed: number|string,
 *   entrants: string[],
 *   bye: string|null,
 *   matches: Array<{
 *     id: string, round: number, index: number,
 *     a: string, b: string|null, bye: boolean,
 *     status: "pending"|"completed", winner: string|null
 *   }>
 * }}
 */
export function pairRound(entrantIds, { round = 1, seed = 0 } = {}) {
  if (!Array.isArray(entrantIds)) {
    throw new TypeError("pairing: entrantIds must be an array");
  }
  const entrants = entrantIds.map((id) => String(id));
  if (entrants.length < 2) {
    throw new RangeError(`pairing: a round needs at least two entrants, got ${entrants.length}`);
  }
  if (new Set(entrants).size !== entrants.length) {
    throw new Error("pairing: duplicate entrant id in the round");
  }

  const roundNumber = Math.trunc(Number(round));
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new RangeError(`pairing: round must be a positive integer, got ${String(round)}`);
  }

  // The round is part of the seed so round 2 does not reuse round 1's order.
  const order = seededShuffle(entrants, `${seed}:round:${roundNumber}`);
  const bye = order.length % 2 === 1 ? order.pop() : null;
  const matches = [];

  for (let i = 0; i < order.length; i += 2) {
    const index = matches.length;
    matches.push({
      id: matchId(roundNumber, index),
      round: roundNumber,
      index,
      a: order[i],
      b: order[i + 1],
      bye: false,
      status: "pending",
      winner: null,
    });
  }

  if (bye) {
    const index = matches.length;
    matches.push({
      id: matchId(roundNumber, index),
      round: roundNumber,
      index,
      a: bye,
      b: null,
      bye: true,
      status: "completed",
      winner: bye,
    });
  }

  return { round: roundNumber, seed, entrants: order, bye, matches };
}

/**
 * The winners a completed round advances, in bracket order.
 *
 * @param {{ matches: Array<{ winner: string|null }> }} round
 * @returns {string[]}
 */
export function winnersOf(round) {
  const matches = Array.isArray(round?.matches) ? round.matches : [];
  return matches.map((m) => m.winner).filter(Boolean);
}

/** True when every match in the round has a recorded winner. */
export function isRoundComplete(round) {
  const matches = Array.isArray(round?.matches) ? round.matches : [];
  return matches.length > 0 && matches.every((m) => Boolean(m.winner));
}

export default {
  PAIRING_VERSION,
  nextPowerOfTwo,
  matchId,
  pairRound,
  winnersOf,
  isRoundComplete,
};
