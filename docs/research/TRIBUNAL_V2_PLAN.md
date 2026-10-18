# Tribunal v2 Plan

Maps the "Deep Technical Specification for Tribunal Mode" (5 stages:
Forge → Crucible → Merge → Trial → Oracle, with the Colosseum view, Oracle
confidence gate ≥ 0.95, JSONL audit, depth knob) onto the existing Tribunal
engine under `src/core/tribunal/`.

Source inspiration: arena-skill (https://github.com/Jakeschincariol/arena-skill,
commit `df07b8e`) — ideas only, no code copied, no Python dependency adopted.

## Existing tribunal engine (current state)

Five stages already exist, each as a thin orchestration layer over a tested
core module:

| Stage | File | Current behavior |
|-------|------|------------------|
| 1 Forge | `stage.js` + `self-review.js` | Self-adversarial review per candidate, bounded revisions (`maxRevisions`), downgrade policy in `confidence.js` |
| 2 Crucible | `stage-crucible.js` + `crucible.js` | Cross-examines each proposal across attack vectors (SQLi, etc.), aggregates findings, survival score |
| 3 Merge | `stage-merge.js` + `merge.js` | Survival gate, synthesizes a hybrid, SKIPPED / COMPLETED / INVALID_RESULT |
| 4 Trial | `stage-trial.js` + `trial.js` | Prosecution of the merge, bounded retry loop (`runTrialWithRetry`), ACQUITTED / CONVICTED_RETRY / CONVICTED_FINAL / MISTRIAL |
| 5 Oracle | `stage-oracle.js` + `oracle.js` | Confidence gate, VERIFIED / INSUFFICIENT_CONFIDENCE / REJECTED / ABORTED, battle report |

Pipeline: `runFullTribunal` in `stage-oracle.js` chains the five stages with
progress notification and early termination (crucible kills all → merge/trial/oracle
skip/abort).

Existing gaps relative to the v2 spec:
- No depth knob (quick / standard / deep / inquisition)
- No persona assignments in Forge (uses the candidate's own model)
- No executable-proof enforcement in Crucible (attacks carry no severity + payload requirement)
- No anti-Frankenstein check in Merge (no parse/lint gate on the merged artifact)
- No model-rotation guard in Trial (Adversary could equal Synthesizer)
- No JSONL audit stream
- No Colosseum TUI view
- No draft artifact on INSUFFICIENT_CONFIDENCE
- No depth-aware early termination

## Spec requirement → Current state → Delta → Implementation sketch → Test plan

| Spec requirement | Current state | Delta needed | Implementation sketch | Test plan |
|------------------|---------------|--------------|----------------------|-----------|
| **Forge persona assignment** — each proposal reviewed under an assigned persona (elegance / performance / defensive / security) from config, no hardcoded cloud models | Forge (`stage.js`) runs `runSelfReview` per candidate keyed off the candidate's own `model`; no persona concept | Add a persona registry (id, name, system-prompt modifier) loaded from config; assign one persona per proposal; pass persona into the self-review prompt | New `src/core/tribunal/personas.js`: `loadPersonas(config)`, `assignPersona(proposal, index, personas)`, `personaPromptModifier(persona)`. Forge passes `persona` into `runSelfReview` opts; `self-review.js` prepends the modifier to its system prompt | Unit test: personas load from config, assignment round-robins deterministically, modifier is non-empty string; integration: Forge result carries `personaId` per candidate |
| **Rule-of-executable-proof in Crucible** — attacks must carry severity (P0/P1/P2) + a concrete failing-test payload, or be auto-downgraded to P2 and not block the Oracle gate | Crucible (`crucible.js`) already produces attack reports with `severity` and a `survivalScore`; `crucible-schema.js` validates attack reports; no executable-proof requirement | Add validation: an attack without `severity` in {P0,P1,P2} or without a non-empty `proof`/`failingTest` payload is downgraded to P2 and excluded from blocking findings | In `crucible.js` `aggregateCrucibleFindings`: filter/normalize each attack — if missing severity or proof, set severity=P2 and mark `executableProof:false`; only P0/P1 with executable proof count as "blocking" for the Oracle gate | Unit test: attack missing severity → P2; attack missing proof → P2; attack with both → kept at stated severity; P2-only attacks don't block Oracle VERIFIED |
| **Anti-Frankenstein check in Merge** — merged artifact passes a cheap parse/lint gate before Trial | Merge (`merge.js`/`stage-merge.js`) synthesizes a hybrid and validates its schema; no syntactic/lint sanity gate on the artifact | Add a `lintMergeArtifact` check: parse as JSON if it claims to be JSON, else basic textual sanity (balanced braces, no obvious truncation); non-parsable → INVALID_RESULT | New `src/core/tribunal/merge-sanity.js`: `sanityCheck(artifact)` → `{ ok, reason }`. `runMerge` calls it before returning COMPLETED; failure → INVALID_RESULT with raw preserved | Unit test: valid JSON → ok; truncated JSON → not ok; plain text with balanced braces → ok; garbage → not ok |
| **Trial model-rotation guard** — Adversary role must differ from Synthesizer role in the same run | Trial (`trial.js`) runs a prosecution with `modelId` passed through; no distinction between Synthesizer and Adversary models | Add `synthesizerModelId` and `adversaryModelId` options; reject (or substitute a fallback) if they are equal | In `stage-trial.js`/`trial.js`: if `synthesizerModelId === adversaryModelId`, set a flag `rotationGuardEngaged: true` and use a different default model (e.g. rotate to a fallback from config) for the adversary | Unit test: equal models → guard engaged + fallback used; different models → no guard; CLI-level test via `--model` pairs |
| **Oracle confidence gate ≥ 0.95 (keep)** | Oracle (`oracle.js`) already computes weighted confidence and returns VERIFIED / INSUFFICIENT_CONFIDENCE / REJECTED / ABORTED with a 0.95 gate | No delta — preserve as-is; document the gate | Keep `oracle.js` unchanged; add tests confirming 0.95 boundary behavior is unchanged | Existing oracle tests (boundary at exactly 0.95, hair above/below) remain green |
| **JSONL audit event schema** — append one JSON line per significant event to `.agentflow/tribunal/<task>_<ts>.jsonl` | No audit stream exists; results are returned in memory only | New `tribunal-audit.js`: `openAudit(taskId)`, `appendEvent(event)`, `closeAudit()`; events written line-delimited; stages hook into it | `src/core/tribunal/tribunal-audit.js`: fs.appendFileSync to the run file; event schema `{ event, stage, timestamp, ...payload }`. `runFullTribunal` accepts an `audit` callback/stream and each stage emits events (ATTACK_FOUND, MERGE_COMPLETED, ORACLE_VERDICT, etc.) | Unit test: audit file created, each line valid JSON, event schema matches doc example; integration: full tribunal run produces a `.jsonl` file with ≥5 events |
| **Colosseum TUI view** — render stage progress, attack tallies, verdict, confidence, next action; TTY only, plain/JSON when piped | `src/tui/tribunal-view.js` renders a progress board; `formatter.js` renders fight cards | Extend `tribunal-view.js` with a Colosseum mode: attack tallies per vector, round progress bar, verdict + confidence badge, next-action hint | `src/tui/tribunal-view.js`: `renderColosseum(state)` — checks `process.stdout.isTTY`; if not a TTY, delegates to plain JSON output | Unit test: non-TTY → JSON output; TTY → ASCII board containing "verdict", "confidence", "round"; snapshot test for stable text |
| **Depth knob** — `quick` (2 models, 1 round, Oracle lite) / `standard` (3 models, 2 rounds, Oracle full) / `deep` (5 models, 3 rounds, Oracle + property tests) / `inquisition` (run until convergence or user-cancel, hard timeout) | No depth concept; `runFullTribunal` always runs all 5 stages once | New `tribunal-depth.js`: `resolveDepth(name)` → `{ models, rounds, oracleMode, earlyTermination, hardTimeoutMs }`. `runFullTribunal` accepts `depth` option; limits model list and round count accordingly | `src/core/tribunal/tribunal-depth.js`: depth presets. Forge limited to `models` count; Crucible runs `rounds` attack rounds; Oracle uses `oracleMode`; `inquisition` loops until no new P0/P1 findings or `hardTimeoutMs` | Unit test: each depth maps to correct preset; `inquisition` has hard timeout; integration: `--tribunal=quick` runs fewer model calls than `--tribunal=deep` |
| **Model role matrix with cross-family rule** — models drawn from different families where possible; Adversary ≠ Synthesizer | No role matrix; single `modelId` used everywhere | Add `modelRoleMatrix` config: `{ synthesizer, adversary, reviewer, prosecutor, oracle }`; cross-family check logs a warning if two roles share a family | `src/core/tribunal/model-roles.js`: `resolveRoles(matrix, availableModels)` → role→model assignment; validates cross-family | Unit test: matrix picks distinct families; warns (not fails) on same-family; cross-family rule documented |
| **Context packet evolution per stage** — packet grows/shrinks per stage; truncation strategy: drop P2, diff-not-file, drop worst solution before merge | Context budget exists elsewhere (PLUGIN_PROMPT_TOKEN_BUDGET = 1000) but no tribunal-specific packet evolution | Add `tribunal-context.js`: `buildPacket(stage, ...)` with truncation rules; applied when passing context into each stage's model call | `src/core/tribunal/tribunal-context.js`: `truncateForStage(packet, stage)` — drop P2 findings first, replace full files with diffs, drop lowest-survival solution last | Unit test: P2 dropped before P1; file → diff; worst solution dropped last; packet size bounded |
| **Failure modes** — INSUFFICIENT_CONFIDENCE writes a draft artifact + remaining-issues report under `.agentflow/tribunal/draft.*`, exits non-zero, honors `--json`; `--force` stays off by default | Oracle returns INSUFFICIENT_CONFIDENCE but no draft artifact is written; CLI behavior on this verdict undefined | New `tribunal-draft.js`: `writeDraft(tribunalId, oracleResult, remainingIssues)` → `.agentflow/tribunal/draft.<tribunal_id>.json`. CLI (`tribunal.js`) writes draft + prints remaining issues + exits non-zero on INSUFFICIENT_CONFIDENCE unless `--force` | `src/core/tribunal/tribunal-draft.js`; `src/commands/tribunal.js` handles the verdict: draft written, `console.error` remaining issues, `process.exitCode = 1` unless `flags.force` | Unit test: draft file created with schema; CLI: INSUFFICIENT_CONFIDENCE → exit 1 + draft exists; `--force` → exit 0 |

## Depth knob mapping (documented and tested)

| Depth | Models | Rounds | Oracle mode | Early termination |
|-------|--------|--------|-------------|-------------------|
| `quick` | 2 | 1 | Oracle lite (weighted only) | — |
| `standard` | 3 | 2 | Oracle full | — |
| `deep` | 5 | 3 | Oracle full + property tests | — |
| `inquisition` | run until convergence | until no new P0/P1 | Oracle full | hard timeout (default 300s), no infinite loop |

## Event schema (JSONL audit)

Example line (documented in docs/TRIBUNAL.md):

```json
{"event":"ATTACK_FOUND","stage":"crucible","attacker":"persona:security","target":"solution_b","severity":"P0","type":"sql_injection","proof":"<minimal failing input>","ts":"<ISO>"}
```

Standard events: `FORGE_START`, `FORGE_PERSONA_ASSIGNED`, `CRUCIBLE_ATTACK_FOUND`, `CRUCIBLE_ROUND_COMPLETE`, `MERGE_COMPLETED`, `MERGE_INVALID`, `TRIAL_PROSECUTION`, `TRIAL_CONVICTED_RETRY`, `ORACLE_VERDICT`, `TRIBUNAL_COMPLETE`, `TRIBUNAL_ABORTED`.

Each line: `{ event, stage, ts, ...payload }`. `ts` is ISO-8601 UTC.

## Files to create / modify

Create:
- `src/core/tribunal/personas.js` — persona registry + assignment
- `src/core/tribunal/tribunal-depth.js` — depth presets + resolution
- `src/core/tribunal/tribunal-audit.js` — JSONL append stream
- `src/core/tribunal/tribunal-draft.js` — draft artifact on insufficient confidence
- `src/core/tribunal/tribunal-context.js` — per-stage packet truncation
- `src/core/tribunal/merge-sanity.js` — anti-Frankenstein parse/lint gate
- `src/core/tribunal/model-roles.js` — role matrix + cross-family check
- `test/tribunal/personas.test.js`, `tribunal-depth.test.js`, `tribunal-audit.test.js`, `tribunal-draft.test.js`, `tribunal-context.test.js`, `merge-sanity.test.js`, `model-roles.test.js`

Modify:
- `src/core/tribunal/stage.js` — Forge persona wiring
- `src/core/tribunal/crucible.js` — executable-proof enforcement
- `src/core/tribunal/merge.js` — anti-Frankenstein gate call
- `src/core/tribunal/stage-trial.js` + `trial.js` — rotation guard
- `src/core/tribunal/stage-oracle.js` — depth option threading + audit event emission
- `src/tui/tribunal-view.js` — Colosseum view
- `src/commands/tribunal.js` — `--tribunal=depth` flag, `--force`, draft handling, exit codes
- `docs/TRIBUNAL.md` — v2 behavior, depth knob, audit schema, failure modes, ASCII screenshots

## Non-goals (explicitly out of scope for v2)

- Spawning sub-agents (arena-skill's 100-agent model) — AgentFlow is a CLI, not a coding assistant with an Agent tool
- Python dependency — all tribunal code stays Node.js standard library
- Real model rotation across cloud providers — models come from config/gateway; rotation guard is about role distinctness, not provider orchestration
