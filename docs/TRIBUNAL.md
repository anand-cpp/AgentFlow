# The Tribunal

A model asked to check its own work tends to agree with itself. The tribunal is
the answer to that: a proposal is treated as a defendant and run through five
adversarial stages, each able to kill it. For the user-facing walkthrough see
[the README](../README.md#the-tribunal); this document is the developer
reference — the module map, the confidence model, and the invariants the code
enforces.

## The five stages

```
Forge     self-review by a hostile-but-fair reader          review-schema.js,  self-review.js,  stage.js
Crucible  cross-examination from four attack vectors;        crucible-schema.js, crucible.js,   stage-crucible.js
          each finding must carry a falsifiable proof
Merge     surviving proposals synthesized into one hybrid    merge-schema.js,  merge.js,    stage-merge.js
Trial     the hybrid prosecuted for merge-specific vectors    trial-schema.js,  trial.js,    stage-trial.js
Oracle    a weighted confidence gate decides the outcome      oracle-schema.js, oracle.js,   stage-oracle.js
```

`runFullTribunal` in `oracle.js` runs the stages in order. When the Crucible
kills every proposal the pipeline terminates early: the remaining stages report
`SKIPPED` (cascading) and the Oracle returns `ABORTED`.

## Verdicts

The Oracle emits one of four `ORACLE_VERDICT` values:

| Verdict | Meaning | Confidence | `final_output` |
|---|---|---|---|
| `VERIFIED` | passed the gate | `>= 0.95` | required, non-empty |
| `INSUFFICIENT_CONFIDENCE` | output ships but flagged | `< 0.95`, with caveats | may be present |
| `REJECTED` | a merge the tribunal refused | `0` | `null` |
| `ABORTED` | nothing survived to judge | `0` | `null` |

Trial outcomes are a separate vocabulary: `ACQUITTED`, `CONVICTED_RETRY`,
`CONVICTED_FINAL`, `MISTRIAL`.

## The confidence model

`CONFIDENCE_WEIGHTS` (in `oracle-schema.js`) is five components summing to 1.0:

| Component | Weight | Why |
|---|---|---|
| `trial` | 0.30 | the last independent check on the merge — trusted most |
| `survival` | 0.25 | how much survived cross-examination |
| `merge` | 0.20 | quality of the synthesis (a multi-proposal hybrid scores higher than a single retained proposal) |
| `self_review` | 0.15 | the proposal's own review |
| `validation` | 0.10 | the Oracle's own checks — least, because nothing is left to discover |

`CONFIDENCE_THRESHOLD = 0.95`. Two commitments keep the number honest:

- **The verdict and the number cannot disagree.** The validator refuses a
  `VERIFIED` report below 0.95 and an `INSUFFICIENT_CONFIDENCE` report at or
  above 0.95. `REJECTED`/`ABORTED` must carry confidence `0` and a `null`
  output.
- **It is not a probability.** The gate is a weighted combination of the stages'
  own scores — consistent and reproducible for a given run, but not "96% likely
  to be right". Do not present it as one.

## Fail-closed behaviour

Every stage is fail-closed. The invariant is: **unreadable model output becomes
a named result, never a crash and never a silent pass.**

- A malformed review becomes an `INVALID_*` finding, not an exception.
- A corrupted proposal is a `MISTRIAL`, which scores `0.0` for the trial
  component.
- The schemas use a **closed vocabulary**: an unknown verdict, a component score
  outside `[0, 1]`, or an unknown field is rejected where it is made
  (`validateOracleReport` returns `{ valid, errors }`).

## Confidence downgrade policy

Independent of the Oracle gate, `confidence.js` governs whether a review report
may *raise* its own confidence after findings:

- A reproduced high-severity defect, a security/assumption/unverified-claim/
  compatibility/performance finding, or a missing required test each force a
  downgrade (`DOWNGRADE_TRIGGER`).
- **A failing executed test overrides any confidence value** — the outcome is
  `TESTS_FAILED`, not a number.
- A raised confidence with no justification is `UNJUSTIFIED_INCREASE`.
- Below `LOW_CONFIDENCE_THRESHOLD` (0.4, inclusive) with nothing reproduced and
  no explicit `REJECT`, the result is *inconclusive* — more verification, not a
  decision.

See `test/tribunal-confidence.test.js` and
`test/tribunal-confidence-boundary.test.js` for the exact boundary.

## Testing

Every stage takes an injectable `completeFn`, so the whole pipeline runs in
tests without a network or a provider. The suite covers all five stages, the
oracle gate, the merge/trial schemas, and the full pipeline
(`runFullTribunal`).

## CLI

```bash
aflow tribunal run "<proposal>" [--domain code] [--model <id>]
aflow tribunal history
aflow fight "<proposal>"        # alias for `tribunal run`
aflow --tribunal "<proposal>"   # flag sugar
```
