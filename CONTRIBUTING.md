# Contributing to AgentFlow

Thanks for your interest in contributing. This document explains how to set up
your environment, the conventions we follow, and how to get your changes merged.

## Quick Start

```bash
# Clone
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow

# Verify Node version (project requires Node >=20)
node --version

# Run the test suite (no install required for tests)
npm test

# Install dev tooling (lint, typecheck)
npm install

# Run AgentFlow locally
node bin/aflow.js --help
```

## Development Workflow

1. **Fork and branch.** Create a branch off `main`:
   - `feat/<short-description>` for new features
   - `fix/<short-description>` for bug fixes
   - `docs/<short-description>` for documentation
   - `chore/<short-description>` for maintenance

2. **Make focused commits.** One concern per commit. Use conventional commit
   messages:
   - `feat(scope): description`
   - `fix(scope): description`
   - `docs(scope): description`
   - `chore(scope): description`
   - `refactor(scope): description`
   - `test(scope): description`

3. **Verify before pushing:**
   ```bash
   npm test          # all tests must pass
   npm run lint      # no lint errors
   npm run typecheck # no type errors
   ```

4. **Open a pull request** against `main` with a clear description of the
   change and why it is needed.

## Code Conventions

- **Zero runtime dependencies.** Production code must use only the Node.js
  standard library, so the test suite runs without an install step. Dev
  dependencies (lint, typecheck) are acceptable.
- Every module ships with JSDoc type annotations (checked via `npx tsc --noEmit`).
- Prefer optional fields in option-bag `@param` annotations and enforce required
  inputs with runtime validators (e.g. `asString(value, field, { required: true })`).
  A JSDoc field marked required on a parameter with a `= {}` default becomes a
  false TS2741 error at the declaration.
- A fix that changes observable behaviour ships with a test and a changelog line.
- **ESM only.** The project is `"type": "module"`. Use `import`/`export`.
- **Node >=20.** Do not use APIs introduced after Node 20 without a guard.
- **Test with `node:test`.** Tests live in `test/` and use the built-in test
  runner via `scripts/run-tests.mjs`.
- **Document design decisions.** Non-obvious choices get a comment explaining
  *why*, not *what*.
- **No secrets in source.** Every commit is scanned by `scripts/scan-secrets.mjs`.

## Technical Debt

Known debt is tracked in [`docs/DEBT_LEDGER.md`](docs/DEBT_LEDGER.md). Each
entry states the rule it violates, why it is deferred, and what would make it
worth paying down. `src/core/` must stay lint-clean and typecheck-clean; debt
outside that scope is logged in the ledger rather than silently carried.

## Project Structure

```
bin/            CLI entry point
src/cli/        Command router, output, UI
src/core/       Engine: runtime, sessions, blackboard, routing, tribunal
src/core/tribunal/  5-stage Tribunal engine (Forge, Crucible, Merge, Trial, Oracle)
src/commands/   Command implementations
scripts/        Test runner, secret scanner, tooling
test/           Test suite (node:test)
docs/           Architecture and reference documentation
AUDIT/          Provenance and audit trail
```

## Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

## Questions

Open an issue or start a discussion. We are happy to help.
