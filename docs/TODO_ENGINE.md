# TODO Engine

AgentFlow's TODO engine provides persistent task tracking for development tasks. Every development task generates a relevant task checklist that adapts to the task type.

## Task Status Values

| Status | Meaning |
|---|---|
| pending | Task not yet started |
| in_progress | Task is being worked on |
| blocked | Task is blocked |
| completed | Task is completed |
| skipped | Task was skipped |
| failed | Task failed |

## Task Categories

| Category | Meaning |
|---|---|
| requirements | Requirements gathering and inspection |
| implementation | Feature implementation |
| testing | Running tests |
| security | Security scans and validation |
| remediation | Fixing vulnerabilities |
| verification | Final verification |
| delivery | Delivery and release |

## Task Verification Modes

| Mode | Meaning |
|---|---|
| manual | Manual completion |
| auto_test | Verified by automated tests |
| security_scan | Verified by security scan |
| finding_resolved | Verified by security finding resolution |
| finding_remediated | Verified by security finding remediation |

## Task List Generation by Type

| Task Type | Tasks |
|---|---|
| general | Inspect requirements, inspect existing implementation, implement feature, run tests, run security scans, fix vulnerabilities, re-scan, verify output |
| frontend | Inspect requirements, inspect components, implement frontend, validate inputs, run frontend tests, run SAST, scan dependencies, verify build, complete security review |
| backend | Inspect API architecture, validate auth, validate authz, validate input, implement endpoint, run integration tests, run SAST, run dependency scans, verify error handling |
| skill | Discover source, inspect repository, run SkillSpector, review findings, obtain approval, test in sandbox, verify permissions, activate |
| container | Inspect Dockerfile, check base image, scan image, check secrets, check configs, verify startup, re-scan image |

## Task Completion Rules

A task is **not** considered complete merely because an agent claims success. Completion requires:

- **Manual tasks:** Human verification
- **Auto test tasks:** Passing automated tests
- **Security scan tasks:** Scanner completed without blocking findings
- **Finding resolved tasks:** Security finding marked as verified/remediated
- **Finding remediated tasks:** Security finding patched and re-scanned clean

## Task Dependencies

Tasks can depend on other tasks. A task cannot start until its dependencies are completed.

## CLI Commands

```
aflow todo show [--list ID]     Show a task list
aflow todo add <title>          Add a task
aflow todo complete <id>        Mark complete
aflow todo retry <id>           Reset to pending
aflow todo generate <type>      Generate a task list
aflow todo list                 List all task lists
```

## TUI Integration

The persistent right-side inspector panel displays the active task list with progress percentage, checkboxes, and real-time updates. On narrow terminals, a dedicated TODO view is available.

## Persistent State

Task state persists across sessions. Every task has a source event and a verifiable completion condition.
