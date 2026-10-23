// Arena pairing (src/core/tournament/pairing.js).
//
// Pairing is the part of the bracket that is easiest to get subtly wrong: an
// odd field, a bye that silently vanishes, or a round that reshuffles on resume.
// These tests pin the observable contract.

import test from "node:test";
import assert from "node:assert/strict";

const p = await import("../src/core/tournament/pairing.js");

function ids(n) {
  return Array.from({ length: n }, (_, i) => `cand-${i + 1}`);
}

test("nextPowerOfTwo rounds up and never returns zero", () => {
  assert.equal(p.nextPowerOfTwo(1), 1);
  assert.equal(p.nextPowerOfTwo(2), 2);
  assert.equal(p.nextPowerOfTwo(3), 4);
  assert.equal(p.nextPowerOfTwo(16), 16);
  assert.equal(p.nextPowerOfTwo(17), 32);
  assert.equal(p.nextPowerOfTwo(0), 1);
});

test("an even field pairs cleanly with no bye", () => {
  const round = p.pairRound(ids(16), { round: 1, seed: 42 });

  assert.equal(round.matches.length, 8);
  assert.equal(round.bye, null);
  assert.deepEqual(
    round.matches.map((m) => m.id),
    ["r1m1", "r1m2", "r1m3", "r1m4", "r1m5", "r1m6", "r1m7", "r1m8"],
  );

  const seen = round.matches.flatMap((m) => [m.a, m.b]);
  assert.deepEqual(new Set(seen), new Set(ids(16)));
  for (const match of round.matches) {
    assert.equal(match.bye, false);
    assert.equal(match.status, "pending");
    assert.equal(match.winner, null);
    assert.notEqual(match.a, match.b);
  }
});

test("an odd field gives exactly one entrant a bye and advances it", () => {
  const round = p.pairRound(ids(5), { round: 1, seed: 3 });

  assert.equal(round.matches.length, 3);
  assert.ok(round.bye);
  const byeMatch = round.matches.find((m) => m.bye);
  assert.ok(byeMatch);
  assert.equal(byeMatch.a, round.bye);
  assert.equal(byeMatch.b, null);
  assert.equal(byeMatch.winner, round.bye);
  assert.equal(byeMatch.status, "completed");

  const seen = round.matches.flatMap((m) => (m.b ? [m.a, m.b] : [m.a]));
  assert.deepEqual(new Set(seen), new Set(ids(5)));
});

test("a 25-entrant round advances 13, matching the 25 -> 13 step", () => {
  const round = p.pairRound(ids(25), { round: 2, seed: 8 });

  assert.equal(round.matches.length, 13);
  assert.equal(round.matches.filter((m) => m.bye).length, 1);

  const resolved = {
    matches: round.matches.map((m) =>
      m.bye ? m : { ...m, status: "completed", winner: m.a },
    ),
  };
  assert.equal(p.winnersOf(resolved).length, 13);
});

test("pairing is reproducible from the seed", () => {
  const a = p.pairRound(ids(16), { round: 1, seed: 42 });
  const b = p.pairRound(ids(16), { round: 1, seed: 42 });

  assert.deepEqual(a, b);
});

test("different seeds produce different pairings", () => {
  const a = p.pairRound(ids(16), { round: 1, seed: 1 });
  const b = p.pairRound(ids(16), { round: 1, seed: 2 });
  assert.notDeepEqual(a, b);
});

test("the round is part of the seed, so round 2 does not repeat round 1", () => {
  const round1 = p.pairRound(ids(16), { round: 1, seed: 7 });
  const round2 = p.pairRound(ids(16), { round: 2, seed: 7 });
  assert.notDeepEqual(round1.entrants, round2.entrants);
});

test("duplicate entrants are rejected instead of producing a self-match", () => {
  assert.throws(
    () => p.pairRound(["a", "b", "a"], { round: 1 }),
    /duplicate entrant id/,
  );
});

test("a round needs at least two entrants", () => {
  assert.throws(() => p.pairRound([], { round: 1 }), /at least two entrants/);
  assert.throws(() => p.pairRound(["solo"], { round: 1 }), /at least two entrants/);
  assert.throws(() => p.pairRound(null), /must be an array/);
});

test("a round needs a real round number", () => {
  assert.throws(() => p.pairRound(ids(4), { round: 0 }), /positive integer/);
  assert.throws(() => p.pairRound(ids(4), { round: "two" }), /positive integer/);
});

test("isRoundComplete waits for every match, byes included", () => {
  const round = p.pairRound(ids(5), { round: 1, seed: 1 });
  assert.equal(p.isRoundComplete(round), false);

  const decided = {
    matches: round.matches.map((m) =>
      m.bye ? m : { ...m, status: "completed", winner: m.a },
    ),
  };
  assert.equal(p.isRoundComplete(decided), true);
  assert.equal(p.isRoundComplete({ matches: [] }), false);
});
