# Autonomous Remediation

AgentFlow's remediation orchestrator follows a bounded repair loop:

```
SCAN → TRIAGE → PATCH → TEST → RESCAN → COMPARE
```

## Remediation Strategy

For every confirmed vulnerability:

1. **Understand** the vulnerability — read the finding, rule ID, CWE/CVE
2. **Identify root cause** — determine why the vulnerability exists
3. **Smallest correct fix** — minimal change that resolves the issue
4. **Dependency update check** — can a version bump fix it?
5. **Source-code change check** — is code modification required?
6. **Compatibility check** — breaking changes, transitive effects
7. **Isolated patch branch** — create a worktree or branch
8. **Apply patch** — apply the fix
9. **Targeted tests** — run tests for the affected area
10. **Regression tests** — run the full test suite
11. **Re-scan** — run relevant security scanners
12. **Compare results** — compare with the original baseline
13. **Verify resolution** — confirm the vulnerability is resolved
14. **Prepare for review** — patch ready for human review

## Dependency Vulnerabilities

Uses Renovate-style dependency management:

- Dependency inventory
- Vulnerability update PRs
- Lockfile updates
- Version updates
- Release notes
- CI verification

**Preference:** Smallest compatible secure version. Do not blindly upgrade to newest major version. Check breaking changes and transitive effects.

## Source-Code Vulnerabilities

Semgrep autofix is used when:
- The applicable rule has a deterministic fix
- The fix is relevant to the code
- Tests validate the behavior

For complex changes, an isolated AI remediation agent is invoked.

## Patch Safety

Every AI-generated security patch is treated as **untrusted until verified**:

- Applied in isolated worktrees or containers
- User secrets are never exposed to remediation agents
- Patch agents have no unrestricted shell or network access
- Patches are **not** automatically merged or pushed
- High-risk behavioral changes require approval
- Production systems are **not** automatically modified

## Remediation Loop Limits

The repair loop is bounded:
- Configurable iteration limit
- Configurable resource limit
- Never loops indefinitely
- Findings are never suppressed just to make the dashboard green

If a finding remains after the loop:
- Identify why the patch failed
- Inspect regression failures
- Attempt a different safe fix if appropriate
- Escalate to human review when necessary

## Remediation Commands

The `/security fix` command initiates remediation for a finding. The `/security verify` command evaluates whether the delivery gate is satisfied after remediation.
