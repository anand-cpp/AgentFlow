# Security Disclosure Status

Last updated: 2026-10-04

Upstream repository:
decolua/9router

PRIVATE REPORTING:
AVAILABLE TO OUTSIDE REPORTER

PRIVATE REPORTING FROM THIS ENVIRONMENT:
BLOCKED - authenticated GitHub web session is unavailable

REASON:
GitHub's private vulnerability report form exists and is enabled, but this
environment has no authenticated browser session and `gh` is not authenticated.

DOCUMENTED SECURITY POLICY:
NOT FOUND

Report identifier:
NONE - no submission was created

GitHub Support request:
BLOCKED

Support reference:
NONE - no ticket was created

Credential rotation:
NOT VERIFIED

CREDENTIALS:
STILL LIVE / NOT ROTATED

PUBLIC ISSUE:
NOT CREATED

PUBLIC ADVISORY:
NOT PUBLISHED

GitHub alert:
OPEN (secret-scanning alert #1, resolution: none)

SECURITY GATE:
BLOCKED

Feature work:
NOT STARTED

---

## Status distinction that matters

The reporting **route exists and is enabled**. What is blocked is **automated
submission from this machine**, not the availability of private reporting. An
earlier revision of this file said only "Private vulnerability report: BLOCKED",
which could be read as claiming no private route exists. That reading was wrong
and is corrected here.

To be explicit: an outside reporter can file a private report for
`decolua/9router`. Doing so requires only a signed-in GitHub browser session.

## Evidence that the route is real

Verified 2026-10-04. A control experiment was used to distinguish a real but
auth-gated route from a nonexistent one:

| Route | Result |
| --- | --- |
| `/decolua/9router/security` | HTTP 200, no redirect, contains "Report a vulnerability" |
| `/decolua/9router/security/advisories/new` | redirects to `/login?return_to=...` |
| `/decolua/9router/zzz-not-a-real-page-9f2a` (control) | HTTP 404 |
| `/decolua/9router/security/advisories/zzz-nope-4b7c/edit` (control) | HTTP 404 |

The controls return 404 rather than redirecting, so the login redirect on the
advisory route demonstrates the route exists and is gated behind authentication,
rather than being a generic catch-all.

Further confirmation:

- The public `/security` page links "Report a vulnerability" to
  `https://github.com/decolua/9router/security/advisories/new`.
- `GET /repos/decolua/9router/private-vulnerability-reporting` returns
  `{"enabled": true}`.
- `https://github.com/decolua/9router/security/advisories` returns HTTP 200.
  (An earlier revision probed the misspelled path `/security/advories`, which
  returns 404; the correct listing path is `/security/advisories`.)

For public repositories GitHub renders this content at `/security` rather than as
a "Security" tab in the repository navigation, which is why the affordance is not
always visible from the file listing.

## Why automated submission is blocked from this environment

- The GitHub CLI is not authenticated: `gh auth status` reports "You are not
  logged into any GitHub hosts".
- No Chrome or Edge cookie store exists on this machine, so no reusable
  authenticated browser session is available.
- No REST endpoint lets an outside reporter create a private vulnerability
  report. The `security-advisories` endpoints require write access to the
  repository; our collaborator permission on `decolua/9router` is `403` (none),
  and that path would publish an advisory rather than file a private report.

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

1. Sign in to GitHub in a browser, open
   `https://github.com/decolua/9router/security`, click "Report a
   vulnerability", and submit `UPSTREAM_DISCLOSURE.md`. This is the maintainer's
   own sanctioned private channel and the recommended route.
2. Ask decolua to revoke/rotate all six credentials currently exposed at their
   HEAD plus the two inherited values. Only the credential owner can do this,
   and it is the step that actually removes the risk.
3. Submit `GITHUB_SUPPORT_REQUEST.md` through
   `https://support.github.com/contact` from a signed-in browser session, to
   request garbage collection of the retained objects. This is lower priority
   than rotation: the retained objects are worthless once the values are
   invalid.
4. Keep alert #1 open until rotation is confirmed. Do not disable the
   `secrets-exposure` CI gate before then.

Repository setting changed while auditing: `allow_squash_merge` was `true` and is
now `false`, so merge commits and rebase-and-merge preserve commit history.

## Preserved artifacts

Held outside the repository because they contain third-party security detail and
must not be committed:

- `C:\Users\anand\AppData\Local\Temp\aflow\UPSTREAM_DISCLOSURE.md`
- `C:\Users\anand\AppData\Local\Temp\aflow\GITHUB_SUPPORT_REQUEST.md`