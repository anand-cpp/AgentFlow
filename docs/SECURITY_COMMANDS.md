# Security Commands

AgentFlow integrates security orchestration into the existing CLI command architecture.

## `aflow security`

Main security command with subcommands:

| Command | Description |
|---|---|
| `security scan [profile]` | Run a security scan (quick\|standard\|deep\|release) |
| `security findings` | List all security findings |
| `security critical` | List critical findings |
| `security high` | List high findings |
| `security history` | Show scan history |
| `security rescan [profile]` | Clear findings and re-scan |
| `security verify` | Evaluate the delivery gate |
| `security report` | Generate a security report |
| `security tools` | Check scanner tool availability |

### Flags

| Flag | Description |
|---|---|
| `--target PATH` | Target directory to scan (default: cwd) |
| `--timeout-ms MS` | Scanner timeout in milliseconds |
| `--profile NAME` | Scan profile for verify command |

## `aflow todo`

Persistent task tracking for development tasks:

| Command | Description |
|---|---|
| `todo show [--list ID]` | Show a task list |
| `todo add <title>` | Add a task to a list |
| `todo complete <id>` | Mark a task complete |
| `todo retry <id>` | Reset a task to pending |
| `todo generate <type>` | Generate a task list (general\|frontend\|backend\|skill\|container) |
| `todo list` | List all task lists |

### Flags

| Flag | Description |
|---|---|
| `--list ID` | Task list ID (default: default) |
| `--task ID` | Task ID for complete/retry |
| `--title TITLE` | Task title for add |

## Skill Commands

| Command | Description |
|---|---|
| `/skills scan <source>` | Scan a skill source with SkillSpector |
| `/skills inspect <id>` | Inspect a skill's details and scan status |
| `/skills approve <id>` | Approve a skill for sandbox testing |
| `/skills reject <id>` | Reject a skill |
| `/skills status` | Show all skills and their states |

## Example Workflow

```bash
# 1. Generate a task list for a backend task
aflow todo generate backend

# 2. Run a security scan
aflow security scan standard --target .

# 3. View findings
aflow security findings

# 4. Evaluate delivery gate
aflow security verify

# 5. Generate a report
aflow security report
```
