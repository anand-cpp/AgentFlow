# Arena-skill Analysis

**Source:** https://github.com/Jakeschincariol/arena-skill  
**Commit read:** `df07b8e` — "The Arena skill: 100 sub-agents, one task, one survivor" (main, 26 Sep 2026)  
**Read-only reference:** no code was cloned or copied into AgentFlow; ideas only.

## What it is (one paragraph, honest)

The Arena skill is a Claude Code skill: when a user is unhappy with an answer, `/arena` spins up N sub-agents (default 100, `--quick` for 16), gives every one the exact same task plus a different strategy card (reasoning mode × workflow × strategy), and runs them through a single-elimination tournament bracket. Competitors attack each other's solutions, defend and revise, and a judge sub-agent scores each match on a written rubric until one solution survives. The winner, the attacks it survived, and its card are returned. It never touches the user's files — everything lives in `.arena/`. It needs Claude Code (sub-agents via the Agent tool) and Python 3.8+, standard library only, MIT licensed, no signup, no API key, nothing to pip install.

## Architecture summary

| File | Role |
|------|------|
| `skills/arena/bracket.py` | Tournament state machine. Standard-library Python. Manages one `arena.json` state file so the orchestrator never loses track, even if context is compacted mid-run. |
| `skills/arena/SKILL.md` | Orchestration steps + the exact prompt brief every sub-agent receives (competitor / attacker / defender / judge / final templates). |
| `skills/arena/strategies.json` | 15 reasoning modes, 12 workflows, 12 strategies = 2,160 distinct cards. Dealt so no card repeats and modes/workflows/strategies are balanced. |
| `skills/arena/rubric.md` | Judging criteria: correctness 30, completeness 25, robustness 20, specificity 15, clarity 10 (total 100). |
| `tests/test_bracket.py` | Runs a full 100-agent tournament through the CLI with random winners. |

**Data flow (per run):**
1. **Spawn** — N sub-agents, one call each, identical task text + own strategy card; each writes its solution to disk.
2. **Per round** — attack (2 per match) → defend (2 per match) → judge (1 per match) → `collect` → `advance` (eliminate losers, pair survivors).
3. **Final** (optional) — blind judge compares champion with a baseline answer the user rejected.
4. State lives in `arena.json`; every `bracket.py` command reads/writes it, so progress survives compaction.

**Determinism:** same seed → same cards and same bracket (not the same answers; models are not deterministic). Odd pools give one bye, never to the same agent twice while others wait. Pairing avoids matching two agents with the same reasoning mode where possible.

**Cost model:** 100 agents = 7 rounds, 595 sub-agent calls, 70 waves of 10. `--quick` = 16 agents, 4 rounds, 91 calls.

## License + language + deps posture

| Property | Value | AgentFlow impact |
|----------|-------|------------------|
| Language | Python 3.8+ | AgentFlow is Node.js; Python is a foreign runtime |
| Dependencies | Standard library only (`argparse, json, math, os, random, re, sys, time`) | No pip installs — good, but still a Python runtime dep |
| License | MIT | Permissive; compatible with AgentFlow's MIT |
| Runtime needs | Claude Code sub-agents (`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, waves of 10) | AgentFlow is a CLI, not an AI coding assistant with sub-agents |
| Telemetry | None | Compatible |
| GPU / paid APIs | None | Compatible |

## IDEAS WE TAKE (mapped to AgentFlow modules/files)

| Idea | AgentFlow mapping | File(s) |
|------|-------------------|---------|
| Role/persona matrix for debaters (15 reasoning modes × 12 workflows × 12 strategies, dealt so no card repeats) | Tribunal Forge assigns personas (elegance / performance / defensive / etc.) per proposal, drawn from a config, no hardcoded cloud models | `src/core/tribunal/stage-forge.js` (persona config) |
| Single-elimination bracket bookkeeping (alive/eliminated per round, bye handling, state in one JSON file) | Tribunal round/progress tracking persists to disk so a run survives interruption | `src/core/tribunal/tribunal-state.js` (existing `createTribunalState`) |
| Prompt scaffolds for attacker vs defender (specific briefs, format, severity labels FATAL/MAJOR/MINOR) | Tribunal Crucible attacker personas and Trial prosecutor use structured briefs with severity | `src/core/tribunal/stage-crucible.js`, `src/core/tribunal/stage-trial.js` |
| Audit event vocabulary (verdicts, scores, attacks survived, reasoning) | Tribunal JSONL audit stream with a documented event schema | `src/core/tribunal/tribunal-audit.js` (new, Phase C item C6) |
| Fail-closed arithmetic ("a fatal solution cannot beat a non-fatal one"; exact tie → fewer standing attacks → higher correctness → judge's pick) | Oracle confidence gate ≥ 0.95 stays strict; P0/P1 findings block VERIFIED; failures emit audit + draft | `src/core/tribunal/stage-oracle.js` (existing gate) |
| Wave-based sub-agent execution (respect concurrency limits) | Tribunal stage execution respects a concurrency cap per stage | `src/core/tribunal/stage-runner.js` (existing runner) |

## IDEAS WE REJECT (with reason)

| Idea | Reason |
|------|--------|
| Python tooling (`bracket.py`, Python 3.8+) | Would add a foreign runtime dependency. AgentFlow is zero-runtime-dependency Node built-ins only. |
| 100 sub-agents / Claude Code `Agent` tool | AgentFlow is a terminal CLI, not an AI coding assistant that spawns sub-agents. No `Agent` tool exists in this codebase. |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` / waves of 10 | N/A — AgentFlow does not launch sub-agent tool calls. |
| `.arena/` on-disk scratch for hundreds of solution files | AgentFlow already uses `.agentflow/` for sessions/blackboard/keys; different purpose, no need for a second scratch root. |
| `python3 -m unittest discover` | AgentFlow uses `node:test` via `scripts/run-tests.mjs`. |
| MIT-licensed code verbatim copy | License is fine, but the code is Python for a completely different host (Claude Code). Re-implement the *idea* in AgentFlow style instead of copying. |

## Risks and non-goals

- **Scope:** Arena is a *user-facing competition feature* for a coding assistant. AgentFlow's tribunal is an *internal adversarial review engine* for proposals. They share the "attack → defend → judge → verdict" shape but serve different users. Do not try to make AgentFlow spawn 100 sub-agents.
- **Determinism:** Arena notes "the same seed gives the same cards and bracket, not the same answers." AgentFlow's tribunal already notes its confidence is "consistent and reproducible for a given run, but not a calibrated probability." Keep that honesty.
- **Security:** Arena writes sub-agent output into `.arena/` and warns that a rogue sub-agent could write elsewhere. AgentFlow already enforces workspace containment and redaction; carry that forward into any tribunal artifact writing.

## Bottom line

Arena-skill is worth **adapting ideas from**, not porting. The transferable concepts are the persona/matrix approach, bracket state persistence, structured attacker/defender/judge briefs with severity labels, audit-event vocabulary, and fail-closed judging. All of these can be re-implemented in Node within `src/core/tribunal/` without adding any runtime dependency.
