# Hackathon Mode — Distributed Multi-Computer Agent Coordination

## Overview

Hackathon Mode is a distributed coordination system built on top of AgentFlow's
existing four operating modes (Plan → Build → Orchestrate → Auto). It enables
independently running AgentFlow instances (each on its own computer, with its own
model/provider, credentials, filesystem, and local AgentRuntime) to collaborate on
a single project under leader-controlled Git and security permissions.

Hackathon Mode is **not** part of the Tab-based mode cycle. It is opened through
the Ctrl+P command palette.

## Architecture

### Leader
The leader is the authoritative coordinator. It:
- Creates and manages the session
- Receives the project idea and generates architecture/task graph
- Registers and authenticates workers
- Assigns and reassigns tasks with dependency management
- Maintains durable session state
- Runs the Integration Supervisor (planned, Phase 3)
- Authorizes promotion to `main`

The leader's own development AgentRuntime registers as a normal worker in the
task system — no artificial exemption from task ownership or integration checks.

### Workers
Each worker runs on a separate computer with:
- Its own AgentFlow process and AgentRuntime
- Its own configured model/provider (API keys are NOT transferred between computers)
- Its own local repository checkout and filesystem
- Its own local permission policy
- Its own assigned task contract and branch identity
- An authenticated connection to the coordinator

### Session State
Sessions are persisted durably on the leader using atomic writes and file locking.
Worker state is persisted locally on each worker for crash recovery. No credentials
or secrets are stored.

## Entry Points

### TUI (Ctrl+P)
Press Ctrl+P to open the command palette, then select "Hackathon Mode" —
"Coordinate agents across multiple computers". This opens the Hackathon workspace.

### CLI
```
aflow hackathon start "<idea>"       # start a new session as leader
aflow hackathon join <session-code>  # join as a worker (TUI)
aflow hackathon status <session>     # show session state
aflow hackathon workers <session>    # list workers
aflow hackathon tasks <session>      # list tasks
aflow hackathon stop <session>       # cancel all tasks
aflow hackathon report <session>     # progress report
```

Flags: `--leader-id`, `--workspace`.

## Task Lifecycle

`PENDING → ASSIGNED → ACCEPTED → RUNNING → COMPLETED`

Exception states: `BLOCKED`, `FAILED`, `CANCELLED`, `EXPIRED`.

All transitions are validated. A worker must not report completion without the
required test evidence. Self-reported completion is marked as pending supervisor
verification (not independently verified).

## Leases

Tasks are leased to workers with a TTL (default 10 minutes). Leases can be renewed.
Expired leases make tasks eligible for safe reassignment. Workers that disconnect
keep their leases (offline work is allowed and reconciled on reconnection).

## Event Protocol

16 event types cover worker lifecycle and task execution:

`WORKER_REGISTERED`, `WORKER_CONNECTED`, `WORKER_DISCONNECTED`,
`WORKER_HEARTBEAT`, `WORKER_RECONNECTED`,
`TASK_DISPATCHED`, `TASK_ACCEPTED`, `TASK_STARTED`, `TASK_PROGRESS`,
`TASK_BLOCKED`, `TASK_COMPLETED`, `TASK_FAILED`, `TASK_CANCELLED`,
`LEASE_RENEWED`, `LEASE_EXPIRED`, `TASK_REASSIGNED`

Events carry unique IDs, sequence numbers, session/worker/task identity, and
timestamps. Duplicate events and out-of-order delivery are detected and handled.

## Transport

Phase 2 implements LocalTransport — real in-process communication between
coordinator and worker through an in-memory message bus. No network listeners are
exposed. LAN and internet transports (WebSocket, relay) are planned for later
phases and are NOT implemented in Phase 2.

## Security

- Authenticated worker identity via short-lived, scoped invitation tokens
- Invitation revocation supported
- Fail-closed: unauthenticated workers are rejected
- No provider API keys transferred between computers
- No unrestricted remote shell or filesystem access
- Worker reports treated as untrusted data
- Secret redaction in all persisted state and logs (redactVerified)
- Approval gates for integration and main promotion (delivery gate)
- Nonce-based replay protection
- Event validation and message-size limits (64 KiB)

## Delivery Gate

Hackathon Mode integrates with AgentFlow's SecurityOrchestrator delivery gate.
Integration and main-branch promotion are blocked until security scans have run
with acceptable findings (consistent with Auto Mode's security gate requirement).

## Concurrency

Bounded concurrency: `maxConcurrentTasks` (default 8) and `maxConcurrentWorkers`
(default 16). Dependent tasks wait for prerequisite completion. Failed tasks do
not block unrelated tasks.

## Configuration Limits

| Setting | Default |
|---|---|
| maxConcurrentTasks | 8 |
| maxConcurrentWorkers | 16 |
| leaseTtlMs | 600000 (10 minutes) |
| heartbeatIntervalMs | 30000 (30 seconds) |
| heartbeatTimeoutMs | 90000 (90 seconds) |
| maxRetries | 3 |
| taskTimeoutMs | 600000 (10 minutes) |
| message size limit | 65536 bytes (64 KiB) |

## Status

Phase 2 complete: coordinator/worker execution runtime with parallel task
orchestration, authentication, leases, heartbeats, reconnection/recovery, event
protocol, delivery gate integration, CLI, and comprehensive test coverage.

Integration Supervisor, Git branch integration, internet relay, and Ctrl+P TUI
are planned for later phases.

## Test Coverage

- Session creation, worker registration, task dispatch, lifecycle transitions
- Concurrent task execution with 2 independent workers
- Dependency enforcement
- Heartbeats, lease renewal/expiry, reassignment
- Worker disconnect/reconnect and state reconciliation
- Authentication, replay protection, task ownership
- Secret redaction
- Session persistence and recovery
- CLI commands
- Event log integration

## Branch

`feature/operating-modes` (stacked on `feat/secure-engineering-system`)

## CI Baseline

Inherited pre-existing failures: lint in unrelated files, secrets-exposure from
upstream 9Router credentials. Hackathon Mode introduces no new lint errors or
test failures.