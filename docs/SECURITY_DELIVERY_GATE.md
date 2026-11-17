# Security Delivery Gate

AgentFlow never falsely claims software is secure. The delivery gate evaluates whether work can be delivered based on actual scan results and test outcomes.

## Delivery Classifications

| Classification | Meaning |
|---|---|
| **VERIFIED** | Applicable scans completed, tests passed, no unresolved confirmed findings violate the release policy |
| **BLOCKED_SECURITY** | Unresolved critical or high findings exist |
| **BLOCKED_INCOMPLETE** — Required scanners, tests, or environments were unavailable |
| **VERIFIED_WITH_RISKS** | Documented findings have explicit authorized exceptions with expiration dates |
| **NOT_SECURITY_VERIFIED** | No sufficient evidence exists |

## Default Strict Release Policy

The following must ALL be true for VERIFIED status:

- [ ] No unresolved confirmed CRITICAL vulnerabilities
- [ ] No unresolved confirmed HIGH vulnerabilities
- [ ] No known exposed active secrets
- [ ] No unresolved critical security misconfigurations
- [ ] No unreviewed malicious skill or plugin
- [ ] No failed required security scan
- [ ] No unverified security patch
- [ ] No failed mandatory regression test

For medium and low findings, the configured release policy applies. Accepted risks are documented and reported transparently.

## Evaluation Logic

The `SecurityOrchestrator.evaluateDeliveryGate()` method:

1. Checks for unresolved critical/high findings (critical + high - remediated)
2. Verifies scanner coverage for the requested profile
3. Checks accepted risks
4. Returns a status, eligibility flag, and reasons

A scanner that was unavailable appears as `BLOCKED` or `NOT_RUN`, never `PASS`.

## Delivery Gate in CLI

```
aflow security verify           — Evaluate the delivery gate
aflow security verify --profile deep  — Evaluate with specific profile
```

Returns exit code 0 if eligible, 1 if blocked.

## Truthful Reporting

AgentFlow does NOT claim:
- 100% secure
- Impossible to hack
- Zero vulnerabilities across all possible attack surfaces
- Fully scanned when some scanners did not execute
