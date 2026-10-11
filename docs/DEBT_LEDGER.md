# Technical Debt Ledger

Known debt, tracked so it is decided rather than rediscovered. Each entry carries
the rule it violates, why it is left alone, and the trigger that makes it worth
paying down. A ledger entry is a decision, not a promise: `src/core/` stays
lint-clean and typecheck-clean at all times, and anything that would change
observable behaviour ships only with a test and a changelog line.

## src/core runtime.js — dead `maxDepth` metadata

### [src/core/agents/runtime.js:448]-[rule 5: no public-output change without sign-off]

- Issue: the run result's `maxDepth` field is built before the agent is resolved,
  so `agent ? agent.bounds.maxDepth : null` always evaluates to `null`. The limit
  is still enforced internally (`AgentBoundError` at runtime.js:485), so the
  dead value is metadata only — but `aflow agents run` results are currently
  lying about it.
- Why deferred: fixing it changes the shape of run results (a field that was
  always `null` becomes a number), which is a public-output change and requires
  a test and an explicit sign-off rather than a drive-by edit.
- Fix trigger: the next person who reads `result.maxDepth` from a run result, or
  the next change to the run result envelope.

## Whole-repo typecheck — 272 errors outside `src/core/`

### [tsconfig]-[Debt Burndown Phase 1 scope: src/core only]

- Issue: `npx tsc --noEmit` reports 272 errors outside `src/core/` — in
  `src/cli/`, `src/commands/`, `src/tui/`, `test/`, `scripts/` and `bin/`. The
  same JSDoc-annotation technique that cleared `src/core/` (126 errors → 0)
  applies there.
- Why deferred: Phase 1's agreed scope is `src/core/` only; the test-suite
  errors sit in `test/` files and were left untouched.
- Fix trigger: starting Debt Burndown Phase 2, or any point where a new source
  file in scope imports a currently-typed-`any` function from outside the scope.

## ORIGINAL src/core lint — resolved in this phase

Cleared in this phase (whole-repo 247 lint errors down to 0 across scope; the
`src/core/` subset went from 8 to 0 in `6e7a2236` and the JSDoc commits). Kept
here so the ledger shows what was paid down: re-written or removed TODO/FIXME
comments (`no-warning-comments`), and mechanical `no-useless-catch`,
`prefer-const`, `no-process-exit` and `no-empty` fixes.