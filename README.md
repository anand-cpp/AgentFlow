# AgentFlow

**One CLI for every model you can reach.**

Most AI gateways hand you an API key and a list of models and call that done.
AgentFlow is built around the question nobody else answers: *which of these
models actually works right now?*

Free-tier endpoints advertise themselves in catalogues and then return empty
responses, 404s, or expired OAuth. AgentFlow probes them, tells you the truth,
and gives you a fallback cascade that runs on a live signal instead of a promise.

```
$ aflow doctor

GATEWAY
  http://localhost:20127   v0.5.95   reachable   790 models advertised

LIVE PROBES
  oc/muse-spark-1.3-contributor-free   ok        412ms
  ocz/deepseek-v4-flash-free           error     no active credentials
  bzl/auto:free                        error     no active credentials

  790 advertised · 1 of 3 probed returned content

1 warning, 2 errors
```

That distinction — **advertised** versus **working** — is the product.

---

## Status

Early. The CLI, routing engine, and dashboard are in place and tested. The
agent runtime, tool registry, and plugins are not built yet.

| Area | State |
|---|---|
| Routing engine (`open-sse/`) | Imported from 9Router, 89 providers |
| CLI commands | Working, 304 tests passing |
| Live reachability probing | Working |
| TUI dashboard | Working |
| Sessions | Working — durable per-project work units |
| Blackboard | Working — durable per-project workflow state |
| Agent runtime | Not started |
| Tools, permissions, plugins | Not started |
| Standalone gateway | Runs via 9Router's server; bundled gateway in progress |

See [`AUDIT/FEATURE_AUDIT.md`](AUDIT/FEATURE_AUDIT.md) for the full
capability comparison and [`AUDIT/ARCHITECTURE_AUDIT.md`](AUDIT/ARCHITECTURE_AUDIT.md)
for what was kept, rewritten, and dropped.

---

## Install

Requires **Node.js 20 or newer**. **Zero runtime dependencies** — the CLI uses
only Node builtins, so there is nothing to audit or keep patched.

```bash
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow
node bin/aflow.js doctor
```

To get `aflow` on your PATH:

```bash
npm link
```

```bash
aflow init        # write a starter .agentflow.json
aflow doctor      # check the gateway and probe providers
```

`aflow init` writes the config file only. It never writes an API key — pass
that via `AGENTFLOW_API_KEY` or leave it unset to probe anonymously.

---

## Commands

| Command | What it does |
|---|---|
| `aflow doctor` | Gateway health plus live reachability probes |
| `aflow models` | Catalogue grouped by provider; `--probe` to test which work |
| `aflow status` | Cheap health check, safe for a status bar |
| `aflow config` | Resolved config, and which layer each value came from |
| `aflow init` | Write a starter project config |
| `aflow sessions` | Persistent sessions: start, resume, inspect, annotate |
| `aflow blackboard` | Durable per-project workflow state: tasks, decisions, blockers, next action |
| `aflow route` | Run a prompt through the fallback cascade, with a receipt |
| `aflow logs` | Read the structured event log |
| `aflow dashboard` | Interactive terminal dashboard |

Every command takes `--json` for machine-readable output, so AgentFlow scripts
cleanly instead of asking you to parse a table.

### Sessions

A session is one unit of work that outlives the process, so the next command —
or the next agent — continues instead of starting from zero.

```bash
aflow sessions new "fix the routing cascade" --model oc/muse
aflow sessions note ses_20261004T071530123Z_a1b2c3 "cascade now falls through" --as coder
aflow sessions resume                    # picks up the current session
aflow sessions inspect ses_20261004T071530123Z_a1b2c3 --entries 0
```

Sessions are stored one JSON file per session under the platform state directory
(`AGENTFLOW_STATE_DIR`, or the XDG/`LOCALAPPDATA` equivalent). Each file is
written to a temporary file and renamed over the target, so a process killed
mid-write leaves the previous version intact rather than a truncated one. A file
that fails to parse is reported as corrupt and left untouched — a damaged session
may be the only surviving record of real work, so the store will not overwrite it
to tidy things up.

Entries cover conversation turns, tool calls and results, routing decisions,
errors, agent attribution, and Blackboard references. Concurrent appends from
several agents take a lock and re-read inside it, so parallel work does not lose
entries.

Everything written passes through the same redaction as the event log, and a
credential-shaped value that survives redaction is refused rather than stored.

### Blackboard

Sessions record what happened *in* a run. The Blackboard records what the project
is *for* — the goal, what is open, why a decision was made, what is blocked, what
already failed, and what should happen next. That is the state an agent needs when
it restarts mid-task and finds an empty context window.

```bash
aflow blackboard goal "ship durable state" --objective "finish the milestone"
aflow blackboard task add "implement the store" --detail "corruption safe"
aflow blackboard task t1 --status in_progress
aflow blackboard block "waiting on upstream merge" --task t1 --severity high
aflow blackboard test unit --passed 304 --failed 0 --command "npm test"
aflow blackboard implemented "added store and cli" \
  --files src/core/blackboard.js,src/commands/blackboard.js --commit abc1234
aflow blackboard next "open the PR"
aflow blackboard show                      # goal, open work, blockers, checkpoints
```

`show` is the recovery path: it prints the goal, the next action, work in progress,
open work, blockers, bugs, open questions, active decisions, and the recent
checkpoints, in one screen.

The split with git is deliberate:

```
git         what the code is
blackboard  what we were doing to it
```

Only references are recorded — a path, a sha, a command, a url — never file
contents. A Blackboard that copied source would go stale the moment the file
changed and would then contradict git about the same thing.

State is scoped to the current directory, so running it inside a repo picks up
that repo's record with no flag; `--project` points somewhere else. It lives under
the platform state directory as one `<id>.state.json` per project, written
atomically, alongside an append-only `<id>.events.jsonl` timeline of checkpoints.
The timeline is never replayed into state — it is an independent record, which is
what makes it useful when the state file is damaged.

Every mutating command creates the Blackboard on demand, so there is no
initialisation step to forget. Credentials are redacted before either file is
written, and a value that survives redaction is refused rather than stored.

Pass `--json` for machine-readable output, as with every command.

### Dashboard

`aflow dashboard` opens a full-screen TUI — no web server, no browser.

| Key | Action |
|---|---|
| `r` | Refresh |
| `p` | Re-run live probes |
| `q` | Quit |

It renders straight to the terminal with no TUI dependency, so it works over
SSH, in tmux, and in CI logs. Piping to a non-TTY prints a single snapshot
instead of trying to draw frames nobody can see.

---

## Configuration

Precedence, low to high:

```
defaults < global config file < project config file < AGENTFLOW_* env < flags
```

Project configs are discovered by walking up from the working directory.
When more than one exists, **the nearest file wins**.

| Variable | Config key |
|---|---|
| `AGENTFLOW_BASE_URL` | `baseUrl` |
| `AGENTFLOW_API_KEY` | `apiKey` |
| `AGENTFLOW_DEFAULT_MODEL` | `defaultModel` |
| `AGENTFLOW_PROBE_TIMEOUT_MS` | `probeTimeoutMs` |
| `AGENTFLOW_THEME` | `theme` |
| `AGENTFLOW_JSON` | `json` |
| `AGENTFLOW_QUIET` | `quiet` |
| `AGENTFLOW_VERBOSE` | `verbose` |
| `AGENTFLOW_NO_COLOR` | `noColor` |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. Unrecognised
values fall back to the default rather than being coerced — `AGENTFLOW_JSON=maybe`
leaves JSON off instead of guessing.

A malformed config file is reported as a diagnostic and skipped; lower
precedence layers still apply, so a typo never makes the CLI unusable.

`aflow config` shows the winner and its source, which turns "why is it
behaving like that" into a one-line answer:

```bash
aflow config --json | jq '.baseUrl, .sources'
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Healthy |
| `1` | A check failed (gateway down, probes erroring) |
| `2` | Usage error — bad flags, unknown subcommand, missing argument |
| `127` | Unknown command |

Scripts can branch on these instead of scraping output. `2` always means the
command line was wrong and the printed usage is the fix; `1` means the command
was understood but the work did not succeed.

---

## Security

AgentFlow prints gateway URLs, provider IDs, and error payloads — which often
contain API keys and OAuth tokens. Every value that reaches a terminal or a log
passes through `src/core/redact.js` first, which masks credentials both by
sensitive field name and by pattern.

```bash
aflow config      # apiKey renders as *** in both text and --json
```

The 9Router engine shipped hardcoded third-party credentials in its source and
history — Google and Antigravity OAuth clients, an iFlow OAuth client, and a
Windsurf Firebase key. All were replaced with environment variables during
import:

| Provider | Variables |
|---|---|
| Google | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` |
| Antigravity | `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` |
| iFlow | `IFLOW_OAUTH_CLIENT_ID` / `IFLOW_OAUTH_CLIENT_SECRET` |
| Windsurf | `WINDSURF_OAUTH_CLIENT_ID` / `WINDSURF_OAUTH_CLIENT_SECRET` / `WINDSURF_FIREBASE_API_KEY` |

`aflow doctor` reports these as unconfigured rather than pretending they work,
and `scripts/scan-secrets.mjs` runs in CI so no credential gets committed.

If you rely on these providers, read [`SECURITY.md`](SECURITY.md) first.

---

## Provenance

AgentFlow is a clean-room rewrite built on MIT-licensed work. Nothing was
copied from projects whose licenses prohibit it, and no model weights, prompts,
or vendor assets are included.

| Source | License | Use |
|---|---|---|
| [decolua/9router](https://github.com/decolua/9router) | MIT | Routing engine in `open-sse/`, adapted |
| [opencode](https://github.com/anomalyco/opencode) | MIT | Architecture study only |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Architecture study only |

Qwen code, weights, prompts, and assets are excluded by policy.

Full derivation chain, file-level provenance, and modification log:
[`PROJECT_ORIGIN.md`](PROJECT_ORIGIN.md). Audits in [`AUDIT/`](AUDIT/).

---

## Development

```bash
npm test          # 43 tests, no network required
```

Tests cover config precedence and walk-up discovery, argument parsing,
command registration, TUI frame rendering, and credential redaction. They do
not hit the network — live probing is exercised by `aflow doctor` against a
running gateway.

---

## License

MIT. 9Router is MIT, copyright © 2024-2026 decolua and contributors.

Retained third-party obligations: 9Router, Google OAuth client identifiers, and
Google API terms remain subject to their own terms — including the
Google APIs Terms of Service. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).