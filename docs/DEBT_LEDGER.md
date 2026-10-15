# Technical Debt Ledger

Known debt, tracked so it is decided rather than rediscovered. Each entry carries
the rule it violates, why it is left alone, and the trigger that makes it worth
paying down. A ledger entry is a decision, not a promise: the active codebase —
everything outside the inherited `open-sse/` routing engine — stays lint-clean
and typecheck-clean at all times, and anything that would change observable
behaviour ships only with a test and a changelog line.

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

## `open-sse/` routing engine — excluded from lint and typecheck

### [eslint.config.js, tsconfig.json]-[inherited code, outside the owned surface]

- Issue: `open-sse/**` is listed in the ESLint `ignores` and excluded from
  `tsconfig.json`, so its ~203 lint findings and any type problems are
  unchecked by `npm run lint` / `npm run typecheck`. The engine was imported and
  adapted from 9Router (`README.md:41`); it is not code this project authored.
- Why deferred: the burndown targets the code we own and can safely refactor.
  Bringing the vendored engine up to our style means either drifting from
  upstream or doing a larger port, neither of which is a lint fix. It stays
  excluded, and the exclusion is recorded here rather than left implicit.
- Fix trigger: the first behaviour change we need inside `open-sse/`, or the
  decision to replace it with a first-party routing engine.

## src/core lint and typecheck — resolved in Phase 1

Cleared in Phase 1: the `src/core/` lint subset went from 8 to 0 (`6e7a2236`
and the JSDoc commits), and `src/core/` typecheck went from 126 to 0. Kept here
so the ledger shows what was paid down: re-written or removed TODO/FIXME
comments (`no-warning-comments`), and mechanical `no-useless-catch`,
`prefer-const`, `no-process-exit` and `no-empty` fixes.

## Whole-repo lint and typecheck — resolved in Phase 2

Phase 2 cleared everything this project owns. The 272 non-`src/core/` typecheck
errors recorded above (over `src/cli/`, `src/commands/`, `src/tui/`, `test/`,
`scripts/` and `bin/`) went to 0 with JSDoc annotations and casts that never
weakened a test assertion; the remaining 37 active lint errors went to 0 with
mechanical fixes in `576eeacc` and the JSDoc commits. `bin/aflow.js` (a reported
but stale working-tree stat) was left untouched. `npm run lint`,
`npm run typecheck` and `npm test` (993 tests, 992 pass, 1 Windows skip) are all
clean. The one deferred item surfaced by the sweep is the `open-sse/` exclusion
above.

## CLI argument parser — unknown flags are silently accepted

### [src/cli/index.js:41 `parseArgv`]-[rule 2: validate at the boundary]

- Issue: `parseArgv` records any `--flag` / `-f` token it sees, so a typo such as
  `aflow status --bogus` is accepted and ignored — the command runs as though the
  flag were absent. `GLOBAL_FLAGS` (`index.js:20`) names the global flags but is
  never consulted to reject anything. Command-level *positional* validation is
  strict (an unknown subcommand returns the usage error, exit 2), but unknown
  flags are not validated anywhere.
- Why deferred: rejecting unknown flags requires each command to declare its full
  flag surface, including boolean flags. `defineCommand` (`registry.js:9`) declares
  only `valueFlags`; there is no boolean-flag list, so a strict validator added
  today would reject legitimate flags (`--daemon`, `--record`, `--check`) that no
  command declares. Introducing that surface touches all 16 command modules and
  the parser at once — too wide to change safely in a pass that must keep the
  whole suite green. Logged here rather than left as an implicit behaviour.
- Fix trigger: the next report of a flag being silently ignored, or any change to
  `defineCommand` that adds a boolean-flag declaration.