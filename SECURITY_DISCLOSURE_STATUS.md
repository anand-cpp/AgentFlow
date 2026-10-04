# Security Disclosure Status

Last updated: 2026-10-04

Upstream repository:
decolua/9router

Private vulnerability report:
BLOCKED

Report identifier:
NONE - no submission was created

GitHub Support request:
BLOCKED

Support reference:
NONE - no ticket was created

Credential rotation:
NOT VERIFIED

GitHub alert:
OPEN (secret-scanning alert #1, resolution: none)

Security gate:
BLOCKED

Feature work:
NOT STARTED

---

## Why both submissions are blocked

### Private vulnerability report

GitHub private vulnerability reporting is **enabled** on `decolua/9router`
(verified: `GET /repos/decolua/9router/private-vulnerability-reporting` ->
`{"enabled":true}`). The reporting form exists but is only usable from an
authenticated GitHub web session:

- `https://github.com/decolua/9router/security/advisories/new` redirects to
  `https://github.com/login?return_to=...` (HTTP 200 on the login page, zero
  `textarea` elements present).
- The GitHub CLI is not authenticated: `gh auth status` reports "You are not
  logged into any GitHub hosts".
- No Chrome or Edge cookie store exists on this machine, so no reusable browser
  session is available.
- There is no REST endpoint that lets an outside reporter create a private
  vulnerability report. The `security-advisories` endpoints require write access
  to the repository; our collaborator permission on `decolua/9router` is `403`
  (none), and that would publish an advisory rather than file a private report.

No public issue was opened and no public advisory was published. Substituting a
public disclosure would restate the credentials and was not done.

### GitHub Support request

GitHub provides no support-ticket REST API. `https://support.github.com/contact`
returns HTTP 200 but is an interactive UI, and submitting it also requires an
authenticated web session that does not exist in this environment.

No support ticket number exists. No success is being claimed.

## Verified facts

- Both inherited credentials remain publicly retrievable from the fork's
  pre-purge objects, confirmed with authenticated API reads:
  - `6b38c80d` and `fadc9b78`, `open-sse/providers/registry/windsurf.js` line 40
    (`firebaseApiKey`, 39 chars, `AIza` prefix)
  - `6b38c80d` and `fadc9b78`, `open-sse/providers/registry/iflow.js` line 42
    (`clientSecret`, 32 chars, no known prefix)
- Anonymous API reads returned HTTP 403 during this session, but that was
  IP-wide unauthenticated rate-limit exhaustion (`GET /rate_limit` ->
  `remaining: 0/60`), not object removal. A control request to the definitely
  public `/commits/main` returned the same 403, confirming the cause. The objects
  were anonymously readable before the quota was exhausted.
- Ref-level cleanup succeeded: `origin` publishes only `main`, a fresh clone
  contains zero credential literals, and `git log --all -S` finds none.
- Upstream `decolua/9router` current HEAD (`master`, pushed 2026-10-01) still
  contains six live-looking credentials of the same class:
  - `GOCSPX-` prefixed, 35 chars, ~4.6 bits/char entropy, in
    `open-sse/providers/registry/antigravity.js`,
    `open-sse/providers/registry/gemini-cli.js`,
    `open-sse/providers/registry/gemini.js`, and
    `open-sse/providers/shared.js` (two values)
  - one 32-char high-entropy `clientSecret` in
    `open-sse/providers/registry/iflow.js`
  None are placeholders. This is an ongoing upstream exposure, not only a
  historical one.

## Artifact safety

`UPSTREAM_DISCLOSURE.md` and `GITHUB_SUPPORT_REQUEST.md` were checked
programmatically against all 13 distinct real credential values harvested from
the fork's pre-purge objects and from upstream's current HEAD. Zero real values
appear in any artifact. Verification compares values in memory and prints only
counts.

## Required human actions

1. Sign in to GitHub in a browser, then submit
   `UPSTREAM_DISCLOSURE.md` via
   `https://github.com/decolua/9router/security/advisories/new`.
   This is the only supported private-reporting route.
2. Submit `GITHUB_SUPPORT_REQUEST.md` through
   `https://support.github.com/contact` from a signed-in browser session, to
   request garbage collection of the retained objects.
3. Ask decolua to revoke/rotate all six credentials currently exposed at their
   HEAD plus the two inherited values. Only the credential owner can do this.
4. Keep alert #1 open until rotation is confirmed. Do not disable the
   `secrets-exposure` CI gate before then.

Repository setting changed while auditing: `allow_squash_merge` was `true` and is
now `false`, so merge commits and rebase-and-merge preserve commit history.

## Preserved artifacts

Held outside the repository because they contain third-party security detail and
must not be committed:

- `C:\Users\anand\AppData\Local\Temp\aflow\UPSTREAM_DISCLOSURE.md`
- `C:\Users\anand\AppData\Local\Temp\aflow\GITHUB_SUPPORT_REQUEST.md`