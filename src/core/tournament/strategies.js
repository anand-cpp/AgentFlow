// Strategy cards for Arena mode.
//
// Every competitor gets the same task and a different card: one way of
// reasoning, one workflow, one thing to optimise. The card is the only input
// that differs, so the card text has to change how the model attacks the
// problem -- "be creative" would not; "assume the bug is a missing precondition
// and prove it" does.
//
// The catalogue lives in code rather than JSON because it is part of the
// orchestration contract. A run records the card id *and* STRATEGY_CARD_VERSION,
// so a verdict produced under one catalogue stays interpretable after the
// catalogue changes.
//
// Concept adapted from the MIT-licensed arena-skill project
// (https://github.com/Jakeschincariol/arena-skill). The card text here is
// written for coding tasks and is original to AgentFlow.

import { seededShuffle } from "./random.js";

export const STRATEGY_CARD_VERSION = 1;

/** How a candidate is told to think about the task. */
export const REASONING_MODES = Object.freeze([
  {
    id: "first-principles",
    name: "First principles",
    how: "Strip the task to the facts and constraints nobody can argue with. Rebuild the answer from those, and keep an existing convention only if it earns its place again.",
  },
  {
    id: "inversion",
    name: "Inversion",
    how: "List every way this change could fail in production. Build the answer that makes each failure impossible, then check you have not made the code brittle in the process.",
  },
  {
    id: "decomposition",
    name: "Decomposition",
    how: "Split the task into independently verifiable pieces. Solve the piece with the highest uncertainty first, and state explicitly what each piece assumes about the others.",
  },
  {
    id: "empirical",
    name: "Empirical",
    how: "Reproduce or measure before changing anything. Base every claim on an observed input, stack trace, test failure, or benchmark rather than on what the code looks like it does.",
  },
  {
    id: "call-path",
    name: "Call-path tracing",
    how: "Follow the data and control flow from the entry point to the failing behaviour. Fix the earliest point where the invariant is actually violated, not the last place it becomes visible.",
  },
  {
    id: "invariants",
    name: "Invariants",
    how: "Name the invariants the system must preserve, then design the change so each invariant is either enforced by code or checked by a test. An invariant nobody checks is a wish.",
  },
  {
    id: "simplification",
    name: "Subtraction",
    how: "Look for the requirement, branch, or abstraction that can be deleted rather than added. Prefer the smallest design that satisfies the stated task, and justify every new moving part.",
  },
  {
    id: "analogy",
    name: "Analogy",
    how: "Find a solved problem with the same shape elsewhere in this codebase or a well-known system. Port the pattern, then list every place the analogy breaks and handle those explicitly.",
  },
  {
    id: "red-team",
    name: "Red team",
    how: "Assume the obvious solution is wrong. Attack your own first idea with concrete counterexamples and adversarial inputs before committing to a final approach.",
  },
  {
    id: "git-archaeology",
    name: "History",
    how: "Read the recent changes, tests, and comments around the affected code. Ask what regressed and why the current shape exists before proposing a different one.",
  },
]);

/** How a candidate is told to sequence the work. */
export const WORKFLOWS = Object.freeze([
  {
    id: "reproduce-first",
    name: "Reproduce first",
    how: "Get a failing case on the record before proposing a fix. The final answer must explain how the failure was reproduced and how the fix makes it pass.",
  },
  {
    id: "survey-first",
    name: "Survey first",
    how: "Read every file the task plausibly touches before writing anything. Report the current behaviour, then make one coherent change rather than a sequence of guesses.",
  },
  {
    id: "test-first",
    name: "Test first",
    how: "Write the assertions that define done, then implement until they pass. Say which tests are new, which are pre-existing, and what they actually prove.",
  },
  {
    id: "spike-then-harden",
    name: "Spike then harden",
    how: "Find the shortest path that demonstrably works, then harden it: error paths, edge cases, cleanup. Mark clearly what is proven and what is still a stub.",
  },
  {
    id: "minimal-diff",
    name: "Minimal diff",
    how: "Treat every edited line as a cost. Change the least code that satisfies the task, and do not refactor unrelated code on the way through.",
  },
  {
    id: "interface-first",
    name: "Interface first",
    how: "Define the public shape -- function signatures, data structures, CLI flags -- before the implementation. Show that callers can use it without reaching inside.",
  },
  {
    id: "migration-path",
    name: "Migration path",
    how: "Assume existing callers and persisted state must keep working. Describe the compatibility story, the fallback for old data, and how a rollback would work.",
  },
  {
    id: "verify-last",
    name: "Verify last",
    how: "Finish with an explicit verification pass: run the checks, read the output, and report failures honestly. A claim of success without a command and its result is not evidence.",
  },
]);

/** What the candidate is told to optimise when trade-offs appear. */
export const OPTIMIZATIONS = Object.freeze([
  {
    id: "correctness",
    name: "Correctness",
    how: "When two designs both work, prefer the one with fewer ways to be silently wrong.",
  },
  {
    id: "minimal-surface",
    name: "Smallest surface",
    how: "When two designs both work, prefer the one that touches fewer files, exports, and dependencies.",
  },
  {
    id: "robustness",
    name: "Robustness",
    how: "When two designs both work, prefer the one that behaves predictably on empty, malformed, duplicated, and concurrent input.",
  },
  {
    id: "performance",
    name: "Performance",
    how: "When two designs both work, prefer the one that avoids needless passes, allocations, or network calls -- but do not trade correctness for speed.",
  },
  {
    id: "maintainability",
    name: "Maintainability",
    how: "When two designs both work, prefer the one a new contributor can read, test, and change without a guide.",
  },
  {
    id: "observability",
    name: "Observability",
    how: "When two designs both work, prefer the one whose failures are visible: structured errors, events, and useful diagnostics instead of silent fallbacks.",
  },
]);

/** The three dimensions a card is drawn from, in dealing order. */
export const STRATEGY_DIMENSIONS = Object.freeze([
  { key: "reasoning", values: REASONING_MODES },
  { key: "workflow", values: WORKFLOWS },
  { key: "optimization", values: OPTIMIZATIONS },
]);

/** @param {{ id: string }} entry */
function entryId(entry) {
  return String(entry?.id ?? "");
}

/**
 * The stable identifier for a card. Derived from its three components rather
 * than assigned, so two runs that deal the same components record the same id.
 *
 * @param {string} reasoningId
 * @param {string} workflowId
 * @param {string} optimizationId
 */
export function cardId(reasoningId, workflowId, optimizationId) {
  return `${reasoningId}::${workflowId}::${optimizationId}`;
}

/**
 * The full catalogue in a deterministic order. 10 x 8 x 6 = 480 distinct
 * cards, enough for the largest supported tournament without a repeat.
 */
export function buildDeck() {
  const deck = [];
  for (const reasoning of REASONING_MODES) {
    for (const workflow of WORKFLOWS) {
      for (const optimization of OPTIMIZATIONS) {
        deck.push({
          version: STRATEGY_CARD_VERSION,
          id: cardId(reasoning.id, workflow.id, optimization.id),
          reasoning,
          workflow,
          optimization,
        });
      }
    }
  }
  return deck;
}

/**
 * Deal `count` distinct cards, deterministically.
 *
 * The shuffled deck is bucketed by reasoning mode and dealt round-robin, one
 * card per bucket per pass. That gives two properties worth having:
 *
 *   * no card is ever dealt twice within a tournament (the caller's hard
 *     requirement), and
 *   * when there are at least as many cards as reasoning modes, every mode is
 *     used before any mode is used twice -- so a bracket never ends up with ten
 *     variations of "first principles".
 *
 * @param {number} count
 * @param {{ seed?: number|string, deck?: Array<object> }} [options]
 * @returns {Array<object>}
 */
export function dealCards(count, { seed = 0, deck = null } = {}) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`strategy cards: count must be a positive integer, got ${String(count)}`);
  }
  const full = Array.isArray(deck) ? deck : buildDeck();
  if (n > full.length) {
    throw new RangeError(
      `strategy cards: cannot deal ${n} distinct cards; the deck has ${full.length}. ` +
        "Reduce --agents or add cards to the catalogue.",
    );
  }

  const buckets = new Map();
  for (const card of seededShuffle(full, seed)) {
    const key = entryId(card.reasoning);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(card);
  }
  const queues = [...buckets.values()];
  const dealt = [];

  while (dealt.length < n) {
    let progressed = false;
    for (const queue of queues) {
      if (dealt.length >= n) break;
      const card = queue.shift();
      if (card) {
        dealt.push(card);
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  return dealt;
}

/**
 * True when every card in the list is distinct. Used by state validation, not
 * just by tests: a resumed tournament must not be allowed to continue with a
 * bracket that violates its own diversity rule.
 *
 * @param {Array<{ id?: string }>} cards
 */
export function cardsAreUnique(cards) {
  const seen = new Set();
  for (const card of cards) {
    const id = typeof card === "string" ? card : card?.id;
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * Render a card as prompt text. Kept here so every Arena prompt describes a
 * card the same way, and so a test can assert the text actually carries the
 * strategy rather than a label.
 *
 * @param {{ reasoning?: object, workflow?: object, optimization?: object }} card
 */
export function describeCard(card) {
  const reasoning = card?.reasoning ?? {};
  const workflow = card?.workflow ?? {};
  const optimization = card?.optimization ?? {};
  return [
    `Reasoning mode: ${reasoning.name ?? "unspecified"} -- ${reasoning.how ?? ""}`,
    `Workflow: ${workflow.name ?? "unspecified"} -- ${workflow.how ?? ""}`,
    `Optimise for: ${optimization.name ?? "unspecified"} -- ${optimization.how ?? ""}`,
  ].join("\n");
}

export default {
  STRATEGY_CARD_VERSION,
  REASONING_MODES,
  WORKFLOWS,
  OPTIMIZATIONS,
  STRATEGY_DIMENSIONS,
  cardId,
  buildDeck,
  dealCards,
  cardsAreUnique,
  describeCard,
};
