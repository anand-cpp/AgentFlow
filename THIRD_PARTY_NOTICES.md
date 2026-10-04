# Third-Party Notices

AgentFlow is MIT licensed. It retains and redistributes code from the projects
below. Their licenses and terms continue to apply to their respective portions.

---

## 1. 9Router

**Source:** https://github.com/decolua/9router
**License:** MIT
**Copyright:** Copyright (c) 2024-2026 decolua and contributors
**Used for:** the routing and provider-translation engine in `open-sse/`

The contents of `open-sse/` are derived from 9Router. Modifications made in this
repository — chiefly removing hardcoded OAuth credentials in favour of
environment variables — are described in `PROJECT_ORIGIN.md`.

```
MIT License

Copyright (c) 2024-2026 decolua and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Third-party OAuth and API credentials

**Source:** 9Router (retained), Google APIs, iFlow, Windsurf/Codeium
**Used for:** authenticating with third-party model providers

9Router's source and history contained hardcoded third-party credentials. They
were replaced with environment variables during import:

| Provider | Variables |
|---|---|
| Google | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` |
| Antigravity | `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` |
| iFlow | `IFLOW_OAUTH_CLIENT_ID` / `IFLOW_OAUTH_CLIENT_SECRET` |
| Windsurf | `WINDSURF_OAUTH_CLIENT_ID` / `WINDSURF_OAUTH_CLIENT_SECRET` / `WINDSURF_FIREBASE_API_KEY` |

Credential shapes removed: Google OAuth client id/secret, iFlow OAuth
client id/secret, Windsurf OAuth client id, and a Windsurf Firebase web API key.

No third-party credential value is present in this repository's history.
`scripts/scan-secrets.mjs` runs in CI to keep it that way.

Firebase web API keys are lower-risk than OAuth client secrets — they are
designed to ship in client bundles and are constrained by Firebase security
rules rather than treated as secrets. A hardcoded one still pins this fork to
upstream's Firebase project, so it is operator-supplied here too.

Using Google-hosted providers requires accepting the
[Google APIs Terms of Service](https://developers.google.com/terms) and
supplying your own credentials. Without them, `aflow doctor` reports these
providers as unconfigured.

---

## 3. Architecture references

Neither of these is redistributed here. They were studied to inform design
decisions, and no source code was copied.

| Project | License | Use |
|---|---|---|
| [opencode](https://github.com/anomalyco/opencode) | MIT, © 2025 opencode | Permission-rule model, tool schemas, config layering |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT, © 2026 DeepSeek | Tool-execution pipeline, approval and cleanup patterns |

---

## 4. Excluded by policy

No Qwen code, model weights, prompts, vendor datasets, or assets are included
in this repository. Provider *identifiers* may appear in the routing catalogue
where a catalogue enumerates available endpoints; that is configuration data
referencing a third-party service, not redistribution of Qwen material.

---

## 5. Runtime dependencies

**None.** The `aflow` CLI imports only Node builtins and its own files — no
third-party runtime packages, and therefore no lockfile.

Earlier drafts declared `chalk`, `confbox`, `undici`, and `uuid`; none were
actually imported, so all four were removed. Keeping unused dependencies would
have meant shipping a supply-chain surface with nothing to show for it.

`open-sse/` also has no third-party runtime imports; HTTP is native `fetch`.

*If a dependency is ever added, record it here with its license and pin the
version.*

---

*Nothing here grants additional rights to any provider, and nothing here is a
grant of trademark rights. Provider names and trademarks belong to their
respective owners.*