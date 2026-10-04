# Security Policy

## Reporting a vulnerability

Email **security@anand-cpp.dev**. Please include reproduction steps and
affected versions. Do not open a public issue for an unfixed vulnerability.

For a credential leak in **upstream 9Router**, report it to
decolua privately rather than to AgentFlow — we cannot fix another project's
secrets, but we will coordinate disclosure.

---

## What AgentFlow handles

| Asset | Handling |
|---|---|
| API keys (`AGENTFLOW_API_KEY`) | Read from env only, never written to config, masked in all output |
| OAuth tokens | Never stored in plain text; masked in all output |
| Gateway URLs | Printed as-is, these are not secrets |
| Error payloads | Redacted before display — these routinely embed credentials |

## Redaction

`src/core/redact.js` is the single chokepoint. Values reaching a terminal, a
log, or JSON output pass through it first. It masks by two independent means:

1. **Field name** — `apiKey`, `token`, `secret`, `authorization`, … regardless
   of value shape.
2. **Pattern** — credential-shaped strings (`sk-…`, `GOCSPX-…`, JWTs, bearer
   tokens, `ghp_…`) regardless of field name.

Both are applied, because real leaks arrive under either shape and often both.
`redactDeep` tracks visited objects, so a circular provider error payload cannot
crash the CLI mid-diagnostic.

### Verifying it holds

```bash
aflow config --json   # apiKey must render as "***"
npm test              # includes redaction regression tests
```

Fixtures in the test suite are synthetic by policy. A real credential must
never be committed as a test value — revoke it, then replace it.

---

## Trust boundaries

### Gateway

The gateway is **not trusted**. AgentFlow connects to it over HTTP, which may
be plaintext even on `localhost`. It may be a 9Router instance, a third-party
aggregator, or anything else listening on that port.

- Gateway responses are re-parsed and validated, not trusted as-is.
- A malicious gateway can influence which provider you talk to and what you are
  shown. It cannot read your API key unless you send it, which AgentFlow only
  does to the configured base URL.
- Do not point AgentFlow at an untrusted base URL with a real key attached.

### Providers

Third-party providers see your prompts, keys, and OAuth tokens. Their terms
govern that data, not AgentFlow's. Google-hosted providers additionally require
accepting the Google APIs Terms of Service.

### Model output

Model output is **untrusted data**, not instruction. Content from a model, a
tool result, a fetched web page, or a repository file may contain text crafted
to cause tool calls. Permission prompts are the boundary — see the tool and
permission design notes in
[`AUDIT/DEEPSEEK_HARNESS_STUDY.md`](AUDIT/DEEPSEEK_HARNESS_STUDY.md) for the
fail-closed approval model being adopted.

---

## Known issues

### Hardcoded third-party credentials in imported 9Router code — fixed here

9Router shipped hardcoded third-party credentials in its source and git
history. **All four are fixed in AgentFlow** — Google and Antigravity OAuth
clients, an iFlow OAuth client, and a Windsurf Firebase API key are now read
from environment variables, and no credential value exists in this
repository's history.

Upstream still needs to rotate them. If you depend on these providers, assume
the values were compromised and obtain your own credentials.

`scripts/scan-secrets.mjs` runs in CI against every tracked file to keep it that
way. It is shape-and-context based, not entropy analysis, and is tuned to avoid
false positives — a scanner that cries wolf gets switched off.

### How the leak was found

Worth recording, because the process generalises: the first pass scanned for
*known* credential shapes (Google OAuth patterns) and came back clean. The
second pass asked the open-ended question — "what in here is a credential
someone should not commit?" — and found a real iFlow secret and a Firebase key
that the targeted scan had missed.

Shape-matching tells you what you already suspected. Broad sweeps find what you
did not think to look for. Do both.

### `master` retains upstream history — never push it

This repository's `master` branch preserves the full upstream 9Router history,
including the credential-bearing commits. GitHub push protection correctly
rejects it. Only `main` is published; `master` is retained locally for
provenance and must never be pushed.

---

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` | Yes |

This project is pre-1.0. Treat the CLI's output format as unstable, and pin
the version in anything automated.

---

## Hardening notes for contributors

- Never log a full request body. Redact first, then log.
- Never commit a credential as a fixture, even a revoked one.
- Keep `src/core/redact.js` the only path from data to output. If you find a
  second path, close it.
- Fail closed. An unreadable permission decision is a denial, not an approval.
- Escape the terminal when printing model or tool output — untrusted text can
  carry ANSI escapes.