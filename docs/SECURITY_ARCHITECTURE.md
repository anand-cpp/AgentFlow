# Security Architecture

AgentFlow's security architecture is built on the principle that **the model is untrusted**. All model output, tool results, and fetched files are treated as data, not instructions. Permissions are enforced by allowlist, not by prompt text, and approvals fail closed when there is no TTY.

## Security Layers

### 1. Redaction Chokepoint (`src/core/redact.js`)

All output and persistence passes through a single redaction chokepoint. Masks by field name **and** by value shape (bearer tokens, `sk-*`, `GOCSPX-*`, JWTs, `ghp-*`). A credential-shaped value that survives redaction is refused rather than stored.

### 2. Workspace Containment (`src/core/agents/workspace.js`)

Filesystem tools are resolved to a physical path before a run. The root cannot be widened from inside the agent loop. Fail-closed: if containment cannot be confirmed, the tool is denied.

### 3. Fail-Closed Approvals (`src/core/agents/tools.js`)

No TTY → deny. Tool permission waterfall: deny → scope approval → allow → ask → deny. Guards are monotonic (may only deny, never allow). Attempt is logged before dispatch.

### 4. Plugin Sandbox (`src/core/plugins/loader.js`)

Activation runs CommonJS in a `node:vm` sandbox whose `require` allows exactly `node:events`. ESM enters only through the trusted `import()` path. Every registration is namespaced `plugin__<id>__*`.

### 5. Security Orchestrator (`src/security/orchestrator.js`)

Coordinates scanner execution, findings deduplication, and delivery gating. Four scan profiles:

| Profile | Scanners | Purpose |
|---|---|---|
| QUICK | semgrep, osv-scanner | Fast feedback during development |
| STANDARD | semgrep, osv-scanner, trivy | After feature implementation |
| DEEP | semgrep, osv-scanner, trivy | Before presenting completed work |
| RELEASE | semgrep, osv-scanner, trivy | Before release/deployment |

### 6. Scanner Adapter Contract (`src/security/scanners/base.js`)

Every scanner implements a uniform interface: `id`, `name`, `version`, `supportedArtifactTypes`, `checkPreconditions()`, `execute(target, options)`, `parseOutput(output, options)`. Outputs are normalized into AgentFlow's `Finding` format with severity, confidence, CWE/CVE, reachability, and exploitability fields.

### 7. Findings Engine (`src/security/findings/engine.js`)

Deduplicates findings across scanners by fingerprint. Tracks verification status: unverified, verified, remediated, rejected, false_positive, accepted_risk. Provides severity distribution, scanner coverage, and delivery gate evaluation.

### 8. Delivery Gate (`src/security/orchestrator.js`)

Evaluates whether work can be delivered:

- **VERIFIED** — scans passed, no unresolved critical/high findings
- **BLOCKED_SECURITY** — unresolved critical/high findings exist
- **BLOCKED_INCOMPLETE** — required scanners unavailable
- **VERIFIED_WITH_RISKS** — documented accepted risks
- **NOT_SECURITY_VERIFIED** — no sufficient evidence

Default strict release policy: no unresolved critical/high, no exposed secrets, no unreviewed malicious skill/plugin, no failed required scan, no unverified patch, no failed regression test.

## Scanner Adapters

| Scanner | Purpose | Status |
|---|---|---|
| Semgrep | SAST — injection, auth, crypto, path traversal | Adapter implemented |
| OSV-Scanner | Dependency vulnerabilities from lockfiles | Adapter implemented |
| Trivy | Filesystem, secrets, IaC, dependencies | Adapter implemented |
| CodeQL | Data-flow analysis (language dependent) | Not yet integrated |
| TruffleHog | Secret scanning in Git history | Not yet integrated |
| ZAP | DAST for authorized web targets | Not yet integrated |
| Garak | AI security evaluation | Not yet integrated |

Scanners that are unavailable appear as `BLOCKED` or `NOT_RUN`, never `PASS`.

## Skill Security Gate

External agent skills must pass through NVIDIA SkillSpector before installation or activation. Skill states: DISCOVERED → AWAITING_SECURITY_SCAN → SCANNING → SCAN_FAILED → SECURITY_FINDINGS → APPROVAL_REQUIRED → APPROVED_FOR_SANDBOX → SANDBOX_TESTING → VERIFIED → REJECTED → BLOCKED. A skill must never become active merely because it downloaded successfully.

## Security Event Logging

All scan starts, completions, findings, suppressions, patch attempts, test results, rescan results, user approvals, rejections, and delivery decisions are recorded. Sensitive data is redacted; raw credentials are never logged.
