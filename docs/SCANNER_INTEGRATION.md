# Scanner Integration

AgentFlow integrates external security scanners through a uniform adapter contract. Each scanner implements `ScannerAdapter` from `src/security/scanners/base.js`.

## Scanner Adapter Contract

Every scanner must implement:

| Method | Purpose |
|---|---|
| `id` | Unique scanner identifier |
| `name` | Human-readable name |
| `version` | Scanner version |
| `supportedArtifactTypes` | Types of artifacts the scanner can analyze |
| `checkPreconditions()` | Verify the scanner binary is available |
| `executeScanner(target, options)` | Run the scanner, return raw output |
| `parseOutput(output, options)` | Normalize output into `Finding[]` |

## Implemented Scanners

### Semgrep (`src/security/scanners/semgrep.js`)

- **Purpose:** SAST — SQL injection, XSS, auth defects, authz defects, insecure deserialization, command injection, path traversal, unsafe cryptography
- **Output format:** JSON (`--json`)
- **Default rules:** `p/owasp-top-ten`, `p/security-audit`
- **Excludes:** `node_modules`, `.git`, `dist`, `build`
- **Preconditions:** `semgrep --binary` must be on PATH
- **Available:** No (binary not installed in this environment)

### OSV-Scanner (`src/security/scanners/osv.js`)

- **Purpose:** Dependency vulnerability scanning from lockfiles
- **Supported lockfiles:** package-lock.json, requirements, Cargo.lock, go.sum, and others
- **Output format:** JSON (`--json`)
- **Preconditions:** `osv-scanner --binary` must be on PATH
- **Available:** No (binary not installed in this environment)

### Trivy (`src/security/scanners/trivy.js`)

- **Purpose:** Filesystem, dependency, secret, and IaC scanning
- **Scan modes:** fs, config, secret, image
- **Output format:** JSON (`--format json`)
- **Excludes:** `node_modules`, `.git`, `dist`, `build`
- **Preconditions:** `trivy --binary` must be on PATH
- **Available:** No (binary not installed in this environment)

## Finding Normalization

All scanner outputs are normalized into a `Finding` with:

| Field | Description |
|---|---|
| `id` | Unique finding identifier |
| `scannerId` | Scanner that found it |
| `ruleId` | Scanner rule/check ID |
| `cwe` | CWE identifier where available |
| `cve` | CVE identifier where applicable |
| `severity` | critical/high/medium/low/info |
| `confidence` | confirmed/likely/potential/false_positive/accepted_risk/unverified |
| `reachability` | Reachability assessment |
| `exploitability` | Exploitability assessment |
| `title` | Human-readable title |
| `description` | Description |
| `rootCause` | Root cause |
| `recommendedFix` | Recommended fix |
| `file` | Affected file path |
| `line` | Line number |
| `dependencyPath` | Dependency path for dep vulns |
| `evidence` | Evidence object |
| `verificationStatus` | unverified/verified/remediated/rejected/false_positive/accepted_risk |
| `rawReport` | Original scanner output |
| `scannerLocation` | File:line location |

## Adding a New Scanner

1. Create `src/security/scanners/<name>.js` extending `ScannerAdapter`
2. Implement `checkPreconditions()`, `executeScanner()`, `parseOutput()`
3. Register in `SecurityOrchestrator` via `registerScanner()`
4. Add to scan profiles in `getProfileScanners()`

## Tool Installation

External scanners are **not** installed automatically. Before installation:

- Inspect official sources
- Verify release provenance
- Pin versions where practical
- Check licenses
- Check integrity
- Avoid arbitrary installation scripts
- Obtain user approval for system-level installations

If a required scanner is unavailable for a selected profile, the delivery gate returns `BLOCKED_INCOMPLETE` — never `PASS`.
