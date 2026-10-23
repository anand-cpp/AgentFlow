# Repository map

An Aider-style structural map of the workspace, ranked by PageRank over the
import/reference graph. Zero runtime dependencies, no language servers, no
tree-sitter: everything is regex heuristics and ~60 lines of linear algebra.

## Why

A model asked to change code performs measurably better when it already knows
the shape of the repo: which files everything imports, which symbols are load
bearing, where the current concern probably lives. Full file dumps waste the
budget; the map spends it on structure instead.

## Pipeline

```
walk (gitignore, caps, symlinks refused)
  → extract (per-language regex: symbols + imports)
    → resolve (import specifiers → real workspace files)
      → graph (file nodes, symbol nodes, external stubs)
        → pagerank (pure JS, weighted edges, personalization)
          → snapshot (.agentflow/repo-map.json)
            → context (token-budgeted `## Repository map` section)
```

### Walker — `src/core/map/walk.js`

Respects `.gitignore` per directory (nested files, negation, anchored and
unanchored patterns, directory rules), with git's own parity rule: a directory
excluded by rule cannot have a child re-included by `!`. Hard caps: 5000 files
(source extensions win the cut, docs next, then the rest — deterministic and
identical on Windows and Unix). `.git`, `node_modules`, `dist`, `build`,
`coverage`, `target`, `.agentflow` and other build/venv directories never
enter the walk. Symlinks are refused outright (no cycles, no escaping the
workspace), binaries are skipped by extension, and files over 1 MB are never
extracted.

### Extractor — `src/core/map/extract.js`

Line-based patterns per language family. Each file becomes
`{ file, language, symbols: [{ name, kind, line, exported }], imports: [{ raw, resolved }] }`
with `kind` one of `function | class | const | type | interface | method | module`.
JS/TS covers ES imports/exports, `require`, `module.exports`, interfaces and
type aliases; Python covers `def`/`class` with underscore-private export
semantics; Go covers packages, `import` blocks, types, methods and export-by-
capitalisation; Rust covers `use`, `pub fns`, structs/enums, traits, mods. A
generic guesser handles the rest. The extractor may miss a symbol; it never
crashes, and it may never lie about one.

### Import resolver and graph — `src/core/map/graph.js`

A raw specifier becomes ordered candidates (`./util.js` against the import-
ing file's directory; bare names and dotted Python/Go module paths become
flat candidates); the first candidate that is a real workspace file wins.
Unresolvable specifiers (npm packages, `node:path`, urls) become
`external:<raw>` stub nodes — they exist so nothing hangs off a void, but
with no inbound edges they rank negligible. File nodes carry
`A → B means "A references B"` edges; every file also defines its symbols
along low-weight (0.3) edges so importance propagates to them indirectly.

### PageRank — `src/core/map/pagerank.js`

Textbook iteration: damping 0.85, weighted outflow normalised per node,
dangling rank redistributed, uniform teleport, epsilon/convergence stop with
a bounded iteration count. Optional `biases` (a personalization vector) let a
caller boost files relevant to the current task without touching the graph.
Output is a `Map<nodeId, score>` sorted descending, scores summing to 1.

Scores are comparable across map sizes, which is what lets the packer render
them honestly and let "0.4%" mean the same thing everywhere.

### Builder and cache — `src/core/map/build.js`

`buildMap(root)` runs the pipeline and writes `.agentflow/repo-map.json`
atomically. `refreshMap(root)` re-walks and re-extracts **only** files whose
mtime+size differ from the cache; vanished files are dropped, new files are
extracted, and the graph/rank are recomputed (cheap) against the cached
units. `loadMap(root)` reads the cache — a corrupt, foreign-version, or
missing cache reads as absent and triggers a full rebuild. `mapFreshness(root)`
answers the doctor's question without extraction. Config knobs:
`mapEnabled` (default on), `mapMaxFiles`, `mapMaxPromptTokens`, `mapLanguages`
(a language-family allowlist), via `.agentflow.json`, `AGENTFLOW_*` env, or
flags.

### Context packer — `src/core/map/context.js`

`formatRepoMapForPrompt(map, { maxTokens, focusFiles, query })` turns the
snapshot into a budgeted block:

```
## Repository map
Ranked by structural importance. ★ = touched by the current task.

- src/core/chat.js — ChatError, DEFAULT_CONTEXT_BUDGET_CHARS, +5 more; referenced by 3
- src/core/gateway.js — ROLE, complete, streamComplete; referenced by 2
…
(truncated: 18 of 41 files shown)
```

The budget is accounted exactly over the final rendered string (4 chars ≈ 1
token), blank lines included: the packer packs greedily, and when the list is
cut it trades file slots for the truncation note until both fit. `focusFiles`
star-and-boost files the caller already cares about; a `query` multiplies the
rank of files whose paths or symbols match the keywords. File contents are
never emitted — symbols and structure only.

## Agents and runtime

- On every agent run (chat `runAgent`), the bridge warms the cache (cooldown
  2 s) and injects the section into the context packet, using the task text
  as the query. `mapEnabled: false` turns both off.
- The `repo-map` tool (`{ query, focus, maxTokens }`) re-ranks around a
  query mid-run. Read-scoped, permission-gated like any built-in.
- Every map failure degrades to "no map": an unreadable cache, a hostile
  filesystem, a formatting corner — never a failed run.

## CLI

```
aflow map [show]        ranked files with exported symbols
aflow map build         force a full rebuild
aflow map query <text>  keyword-personalized, prompt-shaped output
aflow map stats         files/nodes/edges, cache age, freshness, top 10
```

`/map <sub>` shares the dispatcher inside a session. `doctor` reports a
`repo-map` row — `ok` (fresh), `info` (missing or stale) — and never
hard-fails on it.

## Testing

`test/map/` covers the walker (gitignore semantics, caps, symlinks), the
extractor (per-language fixtures, totality on garbage), the graph
(resolution, degrees, stubs), PageRank (synthetic graphs with hand-provable
rankings, weight/damping/bias behaviour, mass conservation), the builder
(cache round-trip, incremental refresh, staleness), the packer (budget
invariants, focus/query boosts), the bridge (tool registration, cooldown,
injection), and the CLI (show/build/query/stats, slash parity).
