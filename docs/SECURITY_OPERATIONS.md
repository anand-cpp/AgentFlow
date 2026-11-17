# Security Operations

## Tool Management

AgentFlow works with limited resources. External security scanners are optional:

- **Tool discovery** — Detects which scanners are available
- **Version checks** — Verifies scanner versions
- **Capability detection** — Determines what each scanner can do
- **Optional installation** — Scanners are not forced on users
- **Scanner profiles** — QUICK, STANDARD, DEEP, RELEASE
- **Resource limits** — Timeout and memory limits per scanner
- **Execution timeouts** — Prevents hanging scans
- **Caching** — Caches scan results where appropriate
- **Parallel scanning** — Runs scanners in parallel where safe
- **Offline support** — Works without network where possible
- **Graceful degradation** — Missing scanners are reported, not faked

Before installing external tools:
- Inspect official sources
- Verify release provenance
- Pin versions where practical
- Check licenses
- Check integrity
- Avoid arbitrary installation scripts
- Obtain user approval for system-level installations

## Security Event Logging

All security events are recorded:

- Scan start/completion
- Scanner version and configuration
- Target scope
- Findings
- Suppressions
- Patch attempts
- Test results
- Rescan results
- User approvals
- Rejections
- Delivery decisions

Sensitive data is redacted. Raw credentials are never logged.

## Security Reports Directory

Security reports are stored in a safe retention directory. Secrets and raw sensitive scan outputs are **never** committed.

## Security Center UI

The TUI inspector panel displays:

- Current security posture
- Active scan status
- Scanner coverage
- Open findings
- Severity distribution
- Newly introduced findings
- Patched findings
- Pending verification
- Last successful deep scan
- Last successful release scan
- Tool availability

Users can drill into vulnerability evidence, file/line location, root cause, remediation, patch diff, and rescan comparison.

The UI distinguishes actual verified data from estimated risk scores. No fabricated 100/100 security score is displayed.

## False Positive Management

Security baselines support:

- Finding fingerprints
- Accepted risk records with justification, approver, expiration
- Review history
- New vs. previously known vs. resolved vs. reintroduced findings
- Expired exceptions

Baselines are protected from unreviewed modifications. Fail when the baseline unexpectedly suppresses too many findings.
