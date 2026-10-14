# Changelog

All notable changes to AgentFlow are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Full-screen TUI (terminal interface beyond the line-oriented chat loop)
- Repository map / code-graph view
- Git integration (history, diff, and commit workflows in-session)
- Plugin loader for third-party agents and tools

## [0.3.0] - 2026-10-14

### Added
- Interactive chat loop (`aflow chat`) with a slash-command surface, including
  `/agent <task>` which routes a bounded agent task through the live session
- Provider setup wizard (`aflow setup`) with guided credential entry, and
  automatic loading of provider keys from the keys file
- Six new hosted providers, bringing the supported set to twelve: Cloudflare,
  Hugging Face, Together, Fireworks, DeepInfra, SambaNova (alongside Groq,
  Gemini, Cerebras, Mistral, OpenRouter, and local Ollama)
- Cross-provider failover continuation on catastrophic provider failure (t8):
  `continueSession` with failure classification (`CONTINUATION_FAILURE_BRIDGE`)
  and ContextPacket assembly for the new provider
- Dispatch tracer recording unsettled non-idempotent tool calls, so a
  continuation only re-attempts work whose outcome is genuinely unknown
- Continuation reachability in CLI runs (t9): a held `require_approval` is
  surfaced to the approval waterfall (`continuation.approval_requested` /
  `continuation.approved`) instead of stopping silently, and fails closed when
  non-interactive
- Blocking lint and typecheck CI stages
- CHANGELOG.md following Keep a Changelog format
- CONTRIBUTING.md with development workflow
- CODE_OF_CONDUCT.md based on Contributor Covenant
- .editorconfig for consistent formatting and ESLint flat config for code quality

### Changed
- README.md rewritten to match implementation reality
- Single source of truth for the version string (derived from package.json)
- Gateway provider auto-detection from configured credentials

### Fixed
- Symlink name loss during filesystem tool operations
- `const` reassignment bug in the routing path
- `--daemon` flag swallowing the arguments that followed it
- Continuity test helper failing typecheck
- AgentRuntime passed its clock *function* (not a timestamp) as `now` to
  `continueSession`, so a real default-clock run threw "Invalid time value" and
  never continued; the t8 tests missed it because their stub clock stringified
  to a parseable date

### Security
- Upstream credentials (GHSA-35rj-mq32-7gcj) remain the responsibility of
  decolua/9router. The secrets-exposure CI job is intentionally red until
  upstream rotation is confirmed.

## [0.2.0] - 2026-10-11

### Added
- Complete 5-stage Tribunal Engine: Forge, Crucible, Merge, Trial, Oracle
- Zero-dependency OpenAI-compatible gateway server (src/core/gateway-server.js)
- OpenAI SSE translation layer for Ollama responses
- API key authentication with safety guards (loopback bind refusal 
  without key when exposed)
- Remote provider routing: Groq, Gemini, Cerebras, Mistral, OpenRouter
- Multi-provider model aggregation via GET /v1/models
- ProviderHealth circuit breaker wired into AgentRuntime
- Automatic candidate re-ranking on transient failures (t7 Part 1)
- `aflow tribunal run` and `aflow tribunal history` commands
- `aflow fight` alias for tribunal
- `aflow --tribunal` flag
- `aflow server start/stop/status` commands
- ANSI Fight Card terminal renderer for tribunal results
- Session and Blackboard persistence of tribunal runs
- ARCHITECTURE.md with current implementation state

### Changed
- All foundational documentation rewritten from scratch to match 
  implementation reality
- PROJECT_ORIGIN.md updated to reflect actual built subsystems
- README.md expanded with Tribunal, Server, and current test counts

### Deferred
- t8 (continueSession on catastrophic failure) — blocked on 
  feature/context-continuity branch
- CLI-level re-merge in Trial retry loop (decision d4)
- Cross-provider prosecution in Trial (single-provider for now)

### Security
- Upstream credentials (GHSA-35rj-mq32-7gcj) remain the responsibility 
  of decolua/9router. The secrets-exposure CI job is intentionally 
  red until upstream rotation is confirmed.

## [0.1.0] - 2026-10-03

### Added
- Initial AgentFlow fork from 9router baseline
- CLI command surface: aflow with 10+ commands
- Agent runtime with 8 built-in agents (planner, coder, reviewer, 
  debugger, tester, researcher, security, release)
- Session store with atomic writes
- Blackboard store with append-only timeline
- Credential redaction with fail-closed persistence
- Tool permission system (workspace containment, shell guardrails)
- ProviderHealth engine (not yet wired to runtime)
- Routing engine with failure classification
- Dashboard with hand-rolled ANSI rendering
- CI with Node 20/22/24 matrix
- Secret scanning in CI
- Tribunal Stage 1 (self-adversarial review)
