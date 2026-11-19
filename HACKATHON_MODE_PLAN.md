# Hackathon Mode — Architecture & Implementation Plan

## Status
- **Branch:** `feature/operating-modes` at `39ecbfe` (matches remote HEAD)
- **Merge base:** `646835f` on `feat/secure-engineering-system` (stacked PR)
- **Baseline:** 2152 tests pass, 0 fail, 2 skipped; 133 pre-existing lint errors (none in my files)
- **CI:** security-scan PASS; test FAIL (pre-existing lint in unrelated files)

## Architecture Decision

Hackathon Mode is a **distributed coordination system** layered on top of existing
AgentFlow subsystems. It does NOT replace the existing four-mode Tab cycle.

### Reused subsystems (not rebuilt)
- `SessionStore` / `src/core/sessions.js` — durable session state
- `BlackboardStore` / `src/core/blackboard.js` — project workflow state, tasks, decisions
- `EventLog` / `src/core/events.js` — structured audit trail
- `AgentRuntime` / `src/core/agents/runtime.js` — bounded agent execution
- `ModeRegistry` / `ModeRuntime` / `ModePolicy` — existing mode policy enforcement
- `SecurityOrchestrator` / `src/security/orchestrator.js` — delivery gate, scan coverage
- `persist.js` — atomic writes, file locking, versioned records
- `command-palette.js` — Ctrl+P UI surface (Hackathon Mode added as a palette entry)

### New modules (under `src/core/hackathon/`)
| Module | Responsibility |
|---|---|
| `session.js` | HackathonSession: creation, leader identity, durable state, lifecycle |
| `auth.js` | Invitation tokens, worker authentication, revocation, short-lived credentials |
| `transport.js` | WebSocket transport abstraction (LAN + relay for Internet) |
| `coordinator.js` | Leader-side: worker registry, task assignment, session state |
| `worker.js` | Worker-side: registration, heartbeat, task execution, progress reporting |
| `task-graph.js` | Task contracts, dependency graph, versioning |
| `scheduler.js` | Task scheduling with leases, worker capability matching |
| `integration-supervisor.js` | Integration Supervisor Agent: evidence, mismatch detection, risk register |
| `git-integration.js` | Isolated branches, remote SHA verification, file ownership, merge safety |

### CLI (`src/commands/hackathon.js`)
`aflow hackathon start | join <code> | status | workers | tasks | pause | resume | stop | report | integrate | approve | leave`

### TUI
Ctrl+P command palette entry: `Hackathon Mode` — "Coordinate agents across multiple computers"
- Opens Hackathon workspace (new, not in Tab cycle)
- Tab cycle unchanged: Plan → Build → Orchestrate → Auto → Plan

## Implementation Phases (atomic commits)

Phase 0 — Audit (complete)
Phase 1 — Secure coordinator & worker registration
Phase 2 — Task graph & parallel execution
Phase 3 — Integration Supervisor
Phase 4 — Git integration
Phase 5 — Internet transport (relay)
Phase 6 — TUI, CLI, recovery, hardening

## Security Principles
- Authenticated worker identities, short-lived invitation tokens
- Encrypted transport (WSS over TLS where available)
- Fail-closed: unauthenticated workers rejected
- No provider API keys transferred between computers
- No unrestricted remote shell or filesystem access
- Secret redaction in all persisted state and logs
- Approval gates for integration and main promotion

## Connectivity
- LAN: direct WebSocket connections between workers and coordinator
- Internet: authenticated coordination relay when direct connectivity unavailable
- Real network testing required; mocked transport only for unit tests

## Acceptance Criteria
Ctrl+P entry tested · Tab cycle preserved · Real session persisted · Independently
authenticated workers · Separate processes/working directories · LAN verified ·
Interface mismatch detected with evidence · Git isolation maintained · Leader approval
enforced · Main unchanged before approval · No new lint errors · No new test failures