// Deterministic randomness for Arena pairing and card dealing.
//
// A tournament that cannot be replayed is a tournament nobody can debug: "why
// did candidate 7 get eliminated in round 2" has to be answerable from the
// seed, not from a re-run that pairs everyone differently. Every random choice
// in the Arena therefore goes through this module and is derived from the run
// seed plus a purpose string.
//
// mulberry32 is used rather than Math.random because it is small, fast, and
// seedable. It is not cryptographic and must never be used for anything
// security-sensitive -- it only orders candidates.

/**
 * Fold a seed of any shape into a 32-bit unsigned integer.
 *
 * Numeric seeds pass through (truncated); strings are hashed with FNV-1a so
 * `--seed 42` and `--seed "arena"` both work and both replay identically on
 * every platform.
 *
 * @param {number|string} seed
 * @returns {number}
 */
export function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) return Math.trunc(seed) >>> 0;
  const text = String(seed ?? "").trim();
  // A CLI seed arrives as the string "42"; it must select the same tournament
  // as the numeric seed 42, or `--seed 42` and `seed: 42` disagree.
  if (/^-?\d+$/.test(text)) return Number(text) >>> 0;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A seeded PRNG returning floats in [0, 1).
 *
 * @param {number|string} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let state = hashSeed(seed);
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle over a copy. The input is never mutated, because the
 * caller often passes the canonical candidate list and reusing it later is
 * exactly how a bracket ends up with a candidate in two matches.
 *
 * @template T
 * @param {Array<T>} list
 * @param {number|string} seed
 * @returns {Array<T>}
 */
export function seededShuffle(list, seed) {
  const out = [...list];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export default { hashSeed, mulberry32, seededShuffle };
