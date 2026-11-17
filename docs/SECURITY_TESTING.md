# Security Testing

AgentFlow implements comprehensive tests for the security orchestration pipeline.

## Unit Tests

| Test Area | Description |
|---|---|
| Scanner adapters | Verify each scanner adapter executes and parses correctly |
| Output parsers | Verify finding normalization from scanner output |
| Finding normalization | Verify findings are correctly normalized |
| Severity mapping | Verify severity strings map correctly |
| Deduplication | Verify duplicate findings are merged |
| Baseline handling | Verify accepted risks and baselines |
| Policy evaluation | Verify release policy evaluation |
| Task generation | Verify task lists are generated correctly |
| Patch state transitions | Verify remediation state transitions |
| Delivery gating | Verify delivery gate decisions |

## Integration Tests

| Test Area | Description |
|---|---|
| Trivy execution | Verify Trivy scanner runs and produces findings |
| Semgrep execution | Verify Semgrep scanner runs and produces findings |
| OSV execution | Verify OSV-Scanner runs and produces findings |
| SkillSpector execution | Verify SkillSpector scan works |
| Scanner failures | Verify scanner failures are handled gracefully |
| Missing scanners | Verify unavailable scanners are reported as blocked |
| Malformed output | Verify malformed scanner output is handled |
| Timeouts | Verify scanner timeouts are handled |
| Patch creation | Verify patches are created in isolation |
| Rescan after patch | Verify re-scanning after remediation |
| Finding resolution | Verify findings can be marked resolved |
| Finding recurrence | Verify reintroduced findings are detected |

## Security Tests

Verify the following security properties:

1. **A malicious skill cannot install without passing the gate** — SkillSpector scan is required before activation
2. **An incomplete skill scan cannot pass** — Failed scans block installation
3. **An unapproved external skill cannot execute** — Approval is required
4. **A scanner cannot access arbitrary production targets** — Target scope is limited
5. **Secret values are redacted** — Raw secrets never appear in output
6. **A patch agent cannot bypass permissions** — Permissions are enforced
7. **A finding cannot be hidden by changing severity** — Severity changes are tracked
8. **A failed scan cannot produce successful delivery status** — Failed scans block delivery
9. **A vulnerability is not considered fixed until independently rechecked** — Re-scan required
10. **The TODO panel cannot claim completion without evidence** — Completion requires verification

## Test Fixtures

Tests use controlled fixtures and safe synthetic vulnerable samples. No real vulnerabilities are introduced into the codebase for testing.

## E2E Tests

Complete workflows:

1. User requests a feature
2. AgentFlow creates a TODO
3. AgentFlow inspects the codebase
4. AgentFlow implements the feature
5. Appropriate scanners execute
6. Findings are identified
7. Findings are patched in isolation
8. Tests execute
9. Security scanners execute again
10. Resolved findings are verified
11. Remaining findings are displayed
12. Delivery gate evaluates results
13. Final report is produced

Failed and blocked workflows are also tested.
