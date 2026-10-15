<div align="center">

```
▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █▀▀ █░░ █▀█ █░█
█▀█ █▄█ ██▄ █░▀█ ░█░ █▀░ █▄▄ █▄█ ▀▄▀
```

**A terminal-first CLI that routes work across many models — and tells you which of them actually answer.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](THIRD_PARTY_NOTICES.md)

</div>

---

### The tribunal puts a proposal on trial before you commit to it.

Five stages. Five models. One verdict, with a confidence score you can argue with.

```
$ aflow tribunal run "Should we use microservices for a team of 3?"

╔══════════════════════════════════════════════════════════════════╗
║  TRIBUNAL FIGHT CARD                                             ║
║                                                                  ║
║  id       ea1b9d40-2c7f-4c1e-9c2b-7a5f0d3e8b41                   ║
║  domain   architecture                                           ║
║  started  2026-10-15 17:25                                       ║
║  finished 2026-10-15 17:26                                       ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 1 · FORGE  self-adversarial review                        ║
║  proposal-1           -                reviewed  conf 0.62 → 0.91║
║                                                                  ║
║  1 candidate(s) · 1 reviewed · 0 unreadable · 0 revised          ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 2 · CRUCIBLE  cross-examination                           ║
║  proposal-1  survival 0.90  2 finding(s)                         ║
║    P2 · scope  Hybrid omits the rollback path                    ║
║    P3 · evidence  No benchmark cited for the claim               ║
║                                                                  ║
║  2 finding(s) across 1 report(s) · avg survival 0.90             ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 3 · MERGE  hybrid synthesis                               ║
║  status   COMPLETED                                              ║
║  gate     Two proposals — synthesizing a hybrid                  ║
║  decision SYNTHESIZED                                            ║
║  elements 3                                                      ║
║    e1 from proposal-1, proposal-2                                ║
║    e2 from proposal-1                                            ║
║    e3 from proposal-2                                            ║
║  findings                                                        ║
║    f1 ADDRESSED                                                  ║
║    f2 DISPUTED                                                   ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 4 · TRIAL  prosecution                                    ║
║  status   COMPLETED                                              ║
║  verdict  ACQUITTED                                              ║
║  no findings raised by the prosecutor                            ║
╠══════════════════════════════════════════════════════════════════╣
║  ROUND 5 · ORACLE  the gate                                      ║
║   VERIFIED   confidence 96.5%                                    ║
║  Five stage scores weighed; every validation check passed.       ║
║  findings P0 0 · P1 0 · P2 2 · P3 1 · unresolved critical 0      ║
║                                                                  ║
║  weights self 0.15 · survival 0.25 · merge 0.20 · trial 0.30 · v…║
║  scores  self 0.93 · survival 0.90 · merge 1.00 · trial 1.00 · v…║
║                                                                  ║
║  validation checks                                               ║
║    ✓ schema     report conforms to the oracle schema             ║
║    ✓ threshold  confidence 0.965 ≥ gate 0.95                     ║
║                                                                  ║
║  caveats                                                         ║
║    ! Confidence is a weighted blend, not a calibrated probabilit…║
╚══════════════════════════════════════════════════════════════════╝
```

One command. A verdict, the findings behind it, and the exact weights that
produced the score — so you can see *why* the tribunal trusts the answer, not
just that it does.
