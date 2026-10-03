# License Audit — AgentFlow (proposed) / 9Router (upstream)

**Audit date:** 2026-10-03
**Auditor scope:** licensing and provenance risk only. Not legal advice.

---

## 1. Licenses actually present

| File | License | Copyright line | Status |
|---|---|---|---|
| `LICENSE` (repo root) | MIT | `Copyright (c) 2024-2026 decolua and contributors` | Upstream. **Must be retained.** |
| `cli/LICENSE` | MIT | `Copyright (c) 2026 9Router Contributors` | Upstream, duplicate coverage for the `cli/` package. |
| Destination `anand-cpp/AgentFlow` `LICENSE` | MIT | `Copyright (c) 2026 anand-cpp` | Pre-existing on destination `main`. |

No `NOTICE`, `COPYING`, or `THIRD_PARTY_NOTICES` file exists anywhere in the upstream repository.

---

## 2. Verdict on the primary foundation: 9Router

**License: MIT. Permissive. Safe to derive from, with attribution.**

MIT permits use, modification, distribution, sublicensing, and sale, provided the copyright notice
and permission notice are retained in all copies or substantial portions. There is no
copyleft obligation, no source-disclosure trigger, and no field-of-use restriction.

### Obligations if 9Router code is retained

1. Retain `Copyright (c) 2024-2026 decolua and contributors` — in the root `LICENSE` and in
   `THIRD_PARTY_NOTICES.md`.
2. Retain the full MIT permission text and warranty disclaimer.
3. Mark material changes. *(Recommendation: do this in `PROJECT_ORIGIN.md` and a header note in
   `CHANGELOG.md` v0.1.0 rather than by editing upstream copyright lines — editing the line itself
   would violate directive §0.3.)*
4. Do not imply upstream authorship of new work, and do not imply new authorship of upstream work.

### The duplicated `cli/LICENSE`

`cli/LICENSE` is MIT with a *different* copyright holder (`9Router Contributors`) than the root
(`decolua and contributors`). Both are permissive and compatible. Recommendation: consolidate to a
single root `LICENSE` plus `THIRD_PARTY_NOTICES.md` that records both notices verbatim, and delete
the duplicate — **after** its text is captured in the notices file. Do not delete before capturing.

---

## 3. Destination repository: `anand-cpp/AgentFlow`

Verified via the public GitHub API:

- `full_name`: `anand-cpp/AgentFlow`
- `fork`: **false**
- `parent`: **null**
- `visibility`: `public`
- `default_branch`: `main`
- `license`: `MIT`
- `size`: 0 KB
- `created_at`: `2026-10-03T17:40:15Z`

Contents: exactly one file, `LICENSE` (MIT, `Copyright (c) 2026 anand-cpp`).
History: exactly one commit, `3c700fe` — *"Initial commit"*, authored by
`anand-cpp <anand2007.amd@gmail.com>`.

**Confirmed: standalone, not a fork.** No `parent`, no `source`. Good.

### License structure decision

The destination already carries MIT with the user's copyright. Because substantial MIT-licensed
upstream code will be retained, a single LICENSE file holding only `Copyright (c) 2026 anand-cpp`
would be **misleading** — it would imply sole authorship of a codebase containing decolua's work.

Recommended structure:

```
LICENSE                   Project's own terms. Add an explicit
                          "contains MIT-licensed upstream code — see THIRD_PARTY_NOTICES.md"
                          pointer in the header block. Keep MIT for compatibility.
THIRD_PARTY_NOTICES.md    Verbatim reproduction of every upstream copyright +
                          permission notice, per-component, with file paths.
PROJECT_ORIGIN.md         Retained / modified / replaced / newly-written, per subsystem.
UPSTREAM_INSPIRATION.md   Architectural ideas studied. Code incorporated: none, or itemised.
CHANGELOG.md              v0.1.0 entry stating derivation and material changes.
```

This satisfies MIT's notice-retention requirement without erasing anyone, and satisfies directive
§0.1–§0.4.

---

## 4. Reference projects

### OpenCode — https://github.com/anomalyco/opencode

**Status: architectural study only. No code incorporated. No dependency added.**

Not yet verified in this audit phase. **Action required:** confirm the license before any code
level engagement, and record the finding here. If OpenCode's license were copyleft (or had a
non-compete rider), the *study* would still be fine but *code reuse* would not be. Do not copy
first and check later.

### DeepSeek Harness — https://github.com/deepseek-ai/deepseek-harness

**Status: architectural study only. No code incorporated. No dependency added.**

Not yet verified in this audit phase. **Action required:** same as OpenCode — confirm license before
any code-level engagement.

### Qwen — https://github.com/QwenLM/Qwen

**Status: INTENTIONALLY EXCLUDED.**

No Qwen source code, model weights, prompts, assets, prompts, or implementation are or will be
incorporated. No Qwen-specific dependency will be added. Qwen is not a foundation of this project
and will not be claimed as one.

Note: this exclusion has a functional consequence that must be documented honestly — several
upstream 9Router providers serve Qwen-derived models (`qwen3-coder-next`, `qwen3-max-*`,
`qwen/qwen3-embedding-8b`). *Using a provider that serves someone else's model* is not the same as
*incorporating that project's code*. The distinction must be stated explicitly in `PROJECT_ORIGIN.md`
so a reader does not infer Qwen code inclusion from the presence of a `qwen-*` model id.

---

## 5. Blocking issues

**None.**

9Router is unambiguously MIT with no copyleft, no CLA, no model-weights clause, and no
field-of-use restriction. The MIT license of the `cli/` package is compatible with the root MIT.

---

## 6. Open items

| # | Item | Severity | Action |
|---|---|---|---|
| 1 | OpenCode license unverified | Medium | Verify before any code-level engagement; record in `UPSTREAM_INSPIRATION.md` |
| 2 | DeepSeek Harness license unverified | Medium | Same |
| 3 | Destination LICENSE vs. retained upstream code | **High** | Must not ship as sole-authorship MIT; add notices structure per §3 |
| 4 | 350+ npm dependencies, no `THIRD_PARTY_NOTICES` | Medium | Upstream ships no dependency notices. Generate for the derived product; MIT deps need only attribution, but transitive notice hygiene is expected of a real OSS project |
| 5 | `better-sqlite3` optional native dep | Low | Permissive (MIT). Document build-toolchain implication in install docs |
| 6 | `systray2` / tray binaries | Low | Only relevant if tray is retained; it is slated for removal from the product surface |

---

## 7. Secret scan — preflight

| Check | Result |
|---|---|
| `.env` tracked by git | **No** — ignored via `.gitignore:37` (`.env*`), verified with `git check-ignore -v` |
| `.env.example` tracked | Yes — contains placeholders only (`change-me`, `endpoint-proxy-api-key-secret`) |
| Local `.env` contents | Real randomly-generated `JWT_SECRET` + `API_KEY_SECRET`, a locally-set `INITIAL_PASSWORD` (value deliberately not recorded here). Correctly ignored. **Must never be force-added.** |
| Untracked runtime logs | `start.log` (1996 B), `start.err.log` (0 B). Scanned: no secrets (one false positive on the substring "Token" inside a filename `backgroundTokenRefresh.js`). Not covered by any `.gitignore` pattern — must be removed or ignored before first commit. |

No credentials, tokens, or private keys were found in tracked files.