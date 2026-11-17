# Minimal Engineering Architecture

AgentFlow's engineering philosophy follows a strict implementation ladder. Before any code is written, every feature or component must pass this decision sequence:

1. **Does this feature or component actually need to exist?** — If not, do not create it.
2. **Does the existing codebase already provide the functionality?** — Reuse it.
3. **Can the standard library solve the problem?** — Prefer Node builtins only.
4. **Does the platform already provide the functionality?** — Prefer native platform capabilities.
5. **Is an appropriate dependency already installed?** — Reuse it.
6. **Can a small implementation solve the requirement?** — Prefer the simplest correct implementation.
7. **Only then introduce new abstractions, dependencies, or architecture.**

## Zero Runtime Dependencies

AgentFlow production code uses **zero runtime dependencies**. Only Node.js builtins (`node:fs`, `node:child_process`, `node:path`, `node:crypto`, etc.) are used. Dev tooling (ESLint, TypeScript, esbuild, postject) is pinned via lockfile and excluded from published files.

## Implementation Ladder in Practice

| Decision | Rule |
|---|---|
| New file needed? | Only if no existing module covers the capability |
| External dependency? | Only if no stdlib solution exists and no installed dep covers it |
| New abstraction? | Only if a small implementation cannot solve it |
| LOC golfing? | Never at the expense of maintainability, auth, authz, validation, error handling, or tests |

## Security Controls Never Removed

Code minimization never removes:
- Authentication and authorization
- Input and output validation
- Trust-boundary checks
- Error handling
- Data integrity
- Transaction safety
- Accessibility
- Security controls
- Regression tests
- Audit logging
- User permission requirements

## Measurement

Code changes, token consumption, cost, and execution time are measured where instrumentation permits. Repeatable AgentFlow-specific benchmarks are created before making performance claims. No guaranteed improvement percentages are advertised without benchmark reproduction.

## Architecture Layers

```
src/
  cli/            — argv parsing, command registry, output + ANSI colour
  commands/       — one module per top-level command (security, todo, tui, etc.)
  config/         — layered configuration resolution
  core/           — domain logic (routing, gateway, sessions, blackboard, agents, tribunal)
  security/       — security orchestration (scanners, findings, remediation, todo, policies)
  tui/            — hand-rolled ANSI terminal UI (workspace, themes, command palette)
open-sse/         — inherited 9Router routing/translation engine (MIT)
test/             — Node built-in test runner suite
```

## Existing Capabilities Reused

- **Router** (`src/core/routing.js`) — health-aware fallback cascade, failure classification, provider health
- **Gateway** (`src/core/gateway.js`) — OpenAI-compatible HTTP client with timeout and cancel
- **Sessions** (`src/core/sessions.js`) — durable per-project session store, atomic writes
- **Blackboard** (`src/core/blackboard.js`) — durable project workflow state
- **Tribunal** (`src/core/tribunal/`) — five-stage adversarial review pipeline
- **Agent Runtime** (`src/core/agents/runtime.js`) — bounded model↔tool iteration loop
- **Permissions** (`src/core/agents/tools.js`) — fail-closed tool permission waterfall
- **Redaction** (`src/core/redact.js`) — credential redaction chokepoint
- **PageRank Map** (`src/core/map/`) — repository structural map
- **MCP** (`src/core/mcp/`) — Model Context Protocol client
- **LSP** (`src/core/lsp/`) — Language Server Protocol client
- **Plugins** (`src/core/plugins/`) — sandboxed plugin system

## Security Layer (New)

```
src/security/
  scanners/         — scanner adapter base + Semgrep, OSV, Trivy adapters
  orchestrator.js   — scan profile orchestration, delivery gate evaluation
  findings/engine.js — finding deduplication, severity analysis, verification tracking
  todo.js           — persistent task tracking engine
  policies/         — security policies (skill trust, release, remediation)
  remediation/      — remediation orchestration (planned)
  reports/          — security report generation (planned)
  sandbox/          — isolated execution environment (planned)
  inventory/        — dependency inventory (planned)
  events/           — security event logging (planned)
```
