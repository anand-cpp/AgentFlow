// Arena strategy cards (src/core/tournament/strategies.js).
//
// The property that matters is not "the catalogue is big"; it is that a
// tournament never hands two competitors the same card, and that the deal is
// reproducible from the seed. Both are asserted directly.

import test from "node:test";
import assert from "node:assert/strict";

const s = await import("../src/core/tournament/strategies.js");
const { seededShuffle } = await import("../src/core/tournament/random.js");

test("the deck is the full product of the three dimensions", () => {
  const deck = s.buildDeck();
  const expected =
    s.REASONING_MODES.length * s.WORKFLOWS.length * s.OPTIMIZATIONS.length;

  assert.equal(deck.length, expected);
  assert.equal(new Set(deck.map((card) => card.id)).size, expected);
  assert.ok(s.REASONING_MODES.length >= 8, "need enough reasoning modes for diversity");
  assert.ok(deck.length >= 100, "the largest supported tournament must not run out of cards");
});

test("every card carries all three dimensions and its catalogue version", () => {
  for (const card of s.buildDeck()) {
    assert.ok(card.reasoning?.id);
    assert.ok(card.workflow?.id);
    assert.ok(card.optimization?.id);
    assert.equal(card.version, s.STRATEGY_CARD_VERSION);
    assert.equal(
      card.id,
      s.cardId(card.reasoning.id, card.workflow.id, card.optimization.id),
    );
  }
});

test("dealing never repeats a card", () => {
  for (const count of [2, 5, 8, 16, 32, 100]) {
    const cards = s.dealCards(count, { seed: 7 });
    assert.equal(cards.length, count);
    assert.equal(new Set(cards.map((c) => c.id)).size, count, `duplicate card at count ${count}`);
  }
});

test("dealing is reproducible from the seed alone", () => {
  const a = s.dealCards(16, { seed: 42 }).map((c) => c.id);
  const b = s.dealCards(16, { seed: 42 }).map((c) => c.id);
  const c = s.dealCards(16, { seed: "42" }).map((c) => c.id);

  assert.deepEqual(a, b);
  assert.deepEqual(a, c, "numeric and string forms of the same seed must agree");
});

test("different seeds produce a different deal", () => {
  const a = s.dealCards(16, { seed: 1 }).map((c) => c.id);
  const b = s.dealCards(16, { seed: 2 }).map((c) => c.id);
  assert.notDeepEqual(a, b);
});

test("a deal spreads reasoning modes evenly before repeating one", () => {
  const count = s.REASONING_MODES.length * 4;
  const cards = s.dealCards(count, { seed: 11 });
  const tally = new Map();
  for (const card of cards) {
    tally.set(card.reasoning.id, (tally.get(card.reasoning.id) ?? 0) + 1);
  }

  assert.equal(tally.size, s.REASONING_MODES.length);
  assert.deepEqual([...new Set(tally.values())], [4]);
});

test("dealing more cards than the deck holds fails with an actionable error", () => {
  const size = s.buildDeck().length;
  assert.throws(
    () => s.dealCards(size + 1),
    /cannot deal \d+ distinct cards; the deck has \d+/,
  );
});

test("invalid counts are rejected", () => {
  for (const bad of [0, -1, 1.5, "many", null, undefined]) {
    assert.throws(() => s.dealCards(bad), /positive integer/);
  }
});

test("a custom deck is honoured and still deduplicated by dealing order", () => {
  const deck = s.buildDeck().slice(0, 3);
  const cards = s.dealCards(3, { seed: 3, deck });
  assert.equal(cards.length, 3);
  assert.equal(new Set(cards.map((c) => c.id)).size, 3);
});

test("describeCard renders the strategy, not just its labels", () => {
  const [card] = s.dealCards(1, { seed: 5 });
  const text = s.describeCard(card);

  assert.match(text, /^Reasoning mode: /);
  assert.match(text, /Workflow: /);
  assert.match(text, /Optimise for: /);
  assert.ok(text.includes(card.reasoning.how));
  assert.ok(text.includes(card.workflow.how));
  assert.ok(text.includes(card.optimization.how));
});

test("cardsAreUnique checks ids and rejects malformed entries", () => {
  const cards = s.dealCards(4, { seed: 9 });
  assert.equal(s.cardsAreUnique(cards), true);
  assert.equal(s.cardsAreUnique([...cards, cards[0]]), false);
  assert.equal(s.cardsAreUnique([{ id: "" }]), false);
  assert.equal(s.cardsAreUnique([{}]), false);
});

test("seededShuffle leaves its input untouched", () => {
  const input = [1, 2, 3, 4, 5];
  const shuffled = seededShuffle(input, 1);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.equal(shuffled.length, input.length);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), input);
});
