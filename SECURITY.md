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

## Credential leak in published history — objects purged, rotation outstanding

GitHub raised a public secret scanning alert (`Google API Key`) against
`open-sse/providers/registry/windsurf.js`. The source file was clean at `HEAD`,
but the key existed in the two commits that imported the provider engine before
it was scrubbed. A second finding, an iFlow OAuth client secret in
`open-sse/providers/registry/iflow.js`, was in the same commits.

**This has since been purged from published history.** The table below records
the pre-purge state, because the old commit ids are what appear in the alert and
in any third party's clone:

| Ref | Pre-purge commits containing the key | Post-purge |
| --- | --- | --- |
| `origin/main` | `6b38c80d` (import), `274bf6c3` (scrub) | rewritten — `ca597252`, `9e7fa037` |

Verify what is actually published:

    node scripts/scan-secrets.mjs --history

### What was purged, and how the list was derived

Four literals were replaced across two files:

| File | Field | Note |
| --- | --- | --- |
| `registry/windsurf.js` | `firebaseApiKey` | the key GitHub flagged |
| `registry/windsurf.js` | `clientId` | OAuth client id — public by design |
| `registry/iflow.js` | `clientSecret` | a real secret |
| `registry/iflow.js` | `clientId` | OAuth client id — public by design |

The list came from diffing the import commit against the scrub commit, **not**
from the scanner. That distinction is the whole point: the scanner's rule for
Google OAuth secrets matches a `GOCSPX-` prefix, and the iFlow secret carries no
prefix, so the scanner never flagged that value by shape. Trusting the scanner's
own output to define the purge list would have left a live credential behind
while reporting success. The two `clientId` values are not secrets; they were
purged anyway, since removing them costs nothing and they fingerprint upstream.

Rewrite performed with `git filter-repo --replace-text` over `main`, after
verifying a full-history bundle backup and that the three feature branches were
all already merged. `--force-with-lease` pinned the expected pre-purge tip so the
push could not clobber an unexpected intervening commit.

### Verification — the clone is clean, the platform is not

Verified:

- A **fresh clone** of the rewritten `origin/main` contains 14 commits, and a
  literal search for all four values across every one of them returns zero hits.
- `node scripts/scan-secrets.mjs --history` reports clean over the fresh clone.
- The tip tree is byte-identical to the pre-purge tip — the rewrite changed
  history only, never content.
- The three stale feature branches, which also carried the pre-purge commits,
  were deleted from `origin`. Only `main` is published.

**Not verified — and in fact false.** A clean clone is *not* evidence that the
credentials are gone. This repository is public, and GitHub still serves the
pre-purge commits and their blobs through the REST API:

    GET /repos/anand-cpp/AgentFlow/commits/6b38c80d          -> 200
    GET /repos/anand-cpp/AgentFlow/contents/open-sse/providers/registry/windsurf.js?ref=6b38c80d
        -> 200, and the response contains the live Firebase key

This is reproducible with no authentication at all. The git protocol refuses to
fetch those object ids, which is what made the purge look successful; the API
does not, because force-pushing rewrites *refs* and does not delete objects.
The credentials have been publicly recoverable since the commit was pushed.

Do not treat "the clone is clean" as remediation. Check the API.

### Still outstanding — and why the alert stays open

1. **Rotate the credentials. Treat this as urgent.** They belong to a third
   party, so only their owner can invalidate them, and the values are readable
   by anyone on the internet right now. Purging our copy never revoked them.
2. **Ask GitHub Support to garbage-collect the unreachable objects.** Ref
   rewrites are not sufficient on their own; only the platform can drop the
   blobs. Reference the pre-purge commit ids above.
3. **GitHub alert `#1` is deliberately left `open`.** Every resolution reason
   GitHub offers would be a false statement: the credential has not been
   revoked, is not a test fixture, and *is* a real secret. Closing it would
   erase the only signal that steps 1 and 2 are still pending.

Disclosure to upstream `decolua` is drafted and must be sent by a maintainer; the
private vulnerability reporting flow for another repository is web-only and has
no API.

### Why a working-tree scan did not catch it

The scanner reported `clean` on a repository that contained the key. Two
independent reasons, and the first is the important one:

1. **It only read the working tree.** `git ls-files` cannot see an object that
   was committed and later replaced. The rule that should have fired was
   present and correct - `AIza` plus exactly 35 characters is the real shape,
   and it matches. It simply never read the blob that held the key, because by
   the time the scanner first ran the file had already been scrubbed.
2. **Its only validation was a fixture written to match its own regex.** That
   is circular. It proved the code ran, not that it detected anything real.

GitHub's own push protection did not catch it either. The earlier claim in this
file - that push protection caught the OAuth leak - was wrong, and has been
corrected.

### What changed

- `scripts/scan-secrets.mjs` gained `--history`, which scans every blob
  reachable from `refs/remotes/origin/*`. Blobs are deduplicated by object id,
  so a file unchanged across many commits is read once.
- Ref scoping is deliberate: this repository also carries local `master` and
  `upstream/*` tracking refs mirroring 9Router's full history, which contain
  over a thousand credential-shaped strings in documentation that were never
  published here. Scanning every ref buried the two real findings in noise.
- `test/scan-secrets.test.js` asserts each rule against a fixture of the real
  shape and length, including the exact 39-character Google key, and asserts
  that `--history` finds a secret which was scrubbed from `HEAD`. Fixtures are
  assembled from fragments at runtime so the test file holds no credential
  literal and needs no allowlist exemption.
- Line numbers in findings were always reported as `1`; they are now correct.
- CI runs `--history` in a separate job with `fetch-depth: 0`.

### What is still required

Rotation and GitHub-side garbage collection — see
[Still outstanding](#still-outstanding--and-why-the-alert-stays-open) above.

### The monitor that would have caught it

Nothing in this repository would have told us the credential was still public.
`scripts/scan-secrets.mjs` reported clean, correctly: by the time it ran, the
credential was not in any reachable blob. The gap was not a weak rule, it was
the absence of the right *question*.

`scripts/check-exposure.mjs` asks it. For each entry in
[`config/exposure.json`](config/exposure.json) — a commit id, a path, and a
credential *shape*, never a value — it requests the object from the public REST
API with **no token** and fails the build if the object is still retrievable. It
runs on every push to `main` and hourly on a cron.

Three properties are deliberate:

- **It never handles a credential value.** `config/exposure.json` stores no
  values, and retrieved content is inspected in memory. A finding reports the
  ref, the path and the rule name. Not the matched text, not truncated — a
  truncated secret is still a secret, and this file is committed.
- **It fails closed.** A rate limit, a 403 or a dropped connection reports
  `UNKNOWN` and exits non-zero. Reading a network error as "not exposed" would
  turn CI green while the credential stayed public, which is the exact failure
  this monitor exists to prevent.
- **It is expected to fail right now.** `main` is red because the credential is
  live. That is the correct signal. Making this job `continue-on-error` would
  restore the false all-clear that let the exposure go unnoticed — do not do it.

A shape-independent rule was also added to the scanner. The iFlow secret that
leaked carried no distinguishing prefix, so no shape-based rule could name it; it
was caught only because the field happened to be called `clientSecret`. Entropy
of the value now does the work, scoped to secret-named assignments so that
hashes and base64 fixtures do not turn into noise. `test/exposure.test.js` builds
every credential-shaped string it needs from fragments, which is why that file
is scanned honestly rather than allowlisted.

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