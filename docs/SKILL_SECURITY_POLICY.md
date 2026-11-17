# Skill Security Policy

Before AgentFlow installs, downloads, activates, imports, executes, or trusts any external agent skill, the skill must pass through the NVIDIA SkillSpector security gate.

## Skill States

| State | Meaning |
|---|---|
| DISCOVERED | Skill source identified and recorded |
| AWAITING_SECURITY_SCAN | Waiting for SkillSpector scan |
| SCANNING | Scan in progress |
| SCAN_FAILED | Scan could not complete |
| SECURITY_FINDINGS | Scan found security issues |
| APPROVAL_REQUIRED | Awaiting explicit user approval |
| APPROVED_FOR_SANDBOX | Approved for isolated testing |
| SANDBOX_TESTING | Undergoing sandbox validation |
| VERIFIED | Fully verified and safe to activate |
| REJECTED | Rejected due to security findings |
| BLOCKED | Blocked from installation/activation |

## Skill Security Gate Process

1. **Resolve source** — Identify the skill source repository and commit
2. **Inspect files** — Review skill files for obvious issues
3. **Run SkillSpector** — Execute NVIDIA SkillSpector scan
4. **Parse report** — Parse the structured scan report
5. **Identify findings** — Classify severity and confidence
6. **Scan for** — Prompt injection, instruction override, data exfiltration, credential theft, dangerous shell commands, arbitrary code execution, privilege escalation, malicious lifecycle hooks, unsafe file operations, excessive tool permissions, tool poisoning, MCP poisoning, dependency substitution, supply-chain attacks, hidden downloads, network callbacks, memory poisoning, system prompt extraction, unsafe output handling
7. **Decide** — Determine whether the skill can proceed to isolated testing
8. **Require approval** — Explicit approval according to configured skill trust policy
9. **Record decision** — Record in the audit log

## Scan-for Threats

SkillSpector scans for:

- **Prompt injection** — Malicious prompts that override system instructions
- **Instruction override** — Attempts to change agent behavior
- **Data exfiltration** — Unauthorized data transmission
- **Credential theft** — Stealing API keys, tokens, passwords
- **Dangerous shell commands** — `rm -rf`, `curl \| sh`, etc.
- **Arbitrary code execution** — `eval()`, `exec()`, unsafe deserialization
- **Privilege escalation** — Attempts to gain elevated access
- **Malicious lifecycle hooks** — Hooks that run malicious code on install/activate
- **Unsafe file operations** — Unrestricted file read/write/delete
- **Excessive tool permissions** — Requesting more tools than needed
- **Tool poisoning** — Corrupting tool definitions
- **MCP poisoning** — Malicious MCP server configurations
- **Dependency substitution** — Replacing dependencies with malicious versions
- **Supply-chain attacks** — Compromised dependency sources
- **Hidden downloads** — Downloading code without user knowledge
- **Network callbacks** — Calling external servers
- **Memory poisoning** — Corrupting agent memory
- **System prompt extraction** — Attempts to leak system prompts
- **Unsafe output handling** — Output that could execute code

## Skill Installation Policy

- A skill must **never** become active merely because it downloaded successfully
- High-risk or malicious findings must **block** installation
- A failed or incomplete scan must **never** be represented as successful verification
- Findings must **never** be silently suppressed
- The scanned skill must **not** influence the security scanner's instructions or analysis

## Sandbox Execution

SkillSpector is a scanner, not a sandbox. After a skill passes the scanning gate:

- Test in an isolated environment
- Restrict filesystem access
- Restrict network access
- Restrict credentials
- Restrict available tools
- Apply resource limits
- Monitor unexpected behavior

A clean scan is **not** permission for unrestricted execution.

## Skill States in CLI

The `/skills` command family manages skills:

```
/skills scan <source>     — Scan a skill source with SkillSpector
/skills inspect <id>      — Inspect a skill's details and scan status
/skills approve <id>      — Approve a skill for sandbox testing
/skills reject <id>       — Reject a skill
/skills status            — Show all skills and their states
```

These commands integrate with the existing AgentFlow CLI command architecture.

## No Automatic Installation

No external skill is installed automatically without applying this policy. The user must explicitly approve each skill after it passes the security gate.
