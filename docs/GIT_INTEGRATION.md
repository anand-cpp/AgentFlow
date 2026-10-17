# Git integration

AgentFlow reads and drives a git working tree from the terminal and from inside a
chat. It is a thin, careful wrapper: it shells out to the `git` on your `PATH`,
parses git's structured output rather than its human-readable prose, and validates
every path and branch name before it reaches argv.

This document is the reference for **what the git layer does, how it is exposed,
and what it refuses to do**. The implementation lives in
[`src/core/git/`](../src/core/git/); the shared command dispatcher is
[`src/commands/git.js`](../src/commands/git.js).

## Design rules

- **Zero runtime dependencies.** `src/core/git/*` uses `node:child_process` and
  the standard library only. No `simple-git`, no `isomorphic-git`, no native
  addon.
- **No shell, ever.** Every git call is `execFile`/`spawn` with an argument
  vector. There is no `child_process.exec` and no shell string, so a path or ref
  cannot break out through a shell.
- **Validated inputs.** A user path is rejected if it is absolute, contains a
  `..` segment, or contains shell metacharacters or newlines; the resolved path
  is then proven to land inside the workspace root (`resolveInRoot`). Branch
  names are allow-listed and their structural hazards (`-` prefix, `..`, `@{`,
  leading/trailing `/`, `.lock`) refused. Refs get the same treatment.
- **Workspace-scoped.** Every operation runs with the repository root as its
  working directory. Nothing walks outside it.
- **`.gitignore` is respected.** Staging never adds an ignored file unless the
  caller explicitly forces it.
- **Fail gracefully.** A missing git, a non-repository, and a bare repository
  are three distinct, reported conditions — not crashes.
- **Nothing rewrites history.** No push, no force-delete, no rebase, no reset
  `--hard`. Commit, branch, stage, stash and conflict resolution are the only
  writes, and each is behind an explicit verb.

## Two front doors

The same dispatcher serves both:

```sh
aflow git <subcommand> [options]     # the CLI command
```

and, inside a chat session:

```
/git <subcommand>
```

`aflow git` and `/git` share `dispatchGit`, so they behave identically. The only
difference is that the CLI can target another repository with `--project PATH`
and can emit `--json`.

## Subcommands

| Subcommand | What it does |
|---|---|
| `status` | branch, upstream ahead/behind, staged, unstaged, untracked, unmerged |
| `log [N] [--path FILE]` | recent commits; `N` sets the limit (default 20) |
| `diff [--staged] [--stat] [path...]` | unified diff, or a per-file summary with `--stat` |
| `branch` | list branches, marking the current one |
| `show [ref]` | one commit's metadata and patch (default `HEAD`) |
| `blame <file>` | per-line attribution |
| `stage <path...>` | stage paths (never ignored files unless forced) |
| `unstage <path...>` | unstage paths |
| `commit [--message TEXT]` | commit the staged changes; message generated from the diff when omitted |
| `stash [list\|save\|pop\|show\|drop] [N]` | list and manage stashes |
| `conflicts [list\|resolve <path> <ours\|theirs\|both>\|abort]` | inspect and resolve a merge |

Read-only inspection is safe to run anywhere; the writes (`stage`, `commit`,
`branch`, `stash`, `conflicts resolve`) are the workflow actions that belong in a
terminal. Exit codes: `0` ok, `1` a git failure, `2` usage.

### Examples

```sh
aflow git status
aflow git log 5 --path src/core/git/stash.js
aflow git diff --stat
aflow git stage src/core/git/status.js
aflow git commit --message 'fix(git): correct stash no-op detection'
aflow git stash save 'half-done refactor'
aflow git conflicts resolve src/core/git/diff.js both
```

## Agent tools

A model reaches git only through ten tools, assembled in
[`src/core/git/tools.js`](../src/core/git/tools.js) and registered with the rest
of the real tools. Each is a thin adapter: it resolves the workspace, runs the
operation, and returns a bounded, redacted result. **No tool checks a policy of
its own** — the permission waterfall in
[`src/core/agents/tools.js`](../src/core/agents/tools.js) decides, exactly as for
every other tool.

| Tool | Scope | Input |
|---|---|---|
| `git.status` | read | `untracked` (normal\|all\|no) |
| `git.diff` | read | `staged`, `ref`, `paths`, `contextLines`, `stat` |
| `git.log` | read | `limit`, `path`, `author`, `since`, `until`, `grep`, `ref` |
| `git.show` | read | `ref` (required), `diff` |
| `git.blame` | read | `path` (required), `start`, `end` |
| `git.stage` | write | `files`, `all`, `unstage`, `force` |
| `git.branch` | write | `action` (list\|create\|switch\|delete\|rename), `name`, `from`, `newName`, `force` |
| `git.commit` | write | `message`, `all`, `amend`, `signoff` |
| `git.stash` | write | `action` (list\|save\|apply\|pop\|drop\|show\|clear), `message`, `index`, `includeUntracked`, `keepIndex` |
| `git.conflicts` | write | `action` (list\|resolve\|abort), `path`, `resolution` |

Because there is no dedicated git scope, **a model granted only `read` can
inspect a repository but cannot change it** — a write tool call is denied before
it runs.

## Structured output, not prose

The parsers read git's machine-facing formats so a subject containing a comma, a
`|`, or a newline cannot corrupt the parse:

- `status` uses `--porcelain=v2`, whose `u` entries already carry the base/ours/
  theirs blob ids that conflict resolution needs.
- `diff` uses `--numstat` for the summary and a standard unified diff for the
  patch.
- `log`, `blame` and `stash list` use a `--format` with explicit NUL and
  record-separator bytes (git's own `%x00` / `%x1e` escapes), so fields survive
  any punctuation.

## What it will not do

There is deliberately no verb here for `push`, `fetch`, `pull`, `rebase`,
`reset --hard`, or a forced branch delete. The git layer reads history and makes
local, reviewable changes; moving work to a remote stays a decision you make in
your own terminal.
