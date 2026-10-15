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

---

## The problem

A gateway hands you a catalogue of models. What it does not tell you is which of
them will answer *right now*.

Free-tier and aggregator endpoints are the worst offenders: the catalogue is
large, the credentials are shared or expired, and a dead model often fails as a
`200` with an empty body rather than an error you can catch. The request
"succeeds." The response is empty. Your tool reports success.

**Advertised** and **working** are different facts, and most tooling collapses
them into one. AgentFlow measures the gap — in `aflow doctor` (probes specific
models), in `aflow route` (walks a fallback order and records why each step
failed), and in the router itself, which orders candidates by observed health
rather than by the order a provider happened to list them.

---

## Quick start

No build step. No `npm install`. Zero runtime dependencies — it runs on the Node
standard library alone. Clone it and go:

```sh
git clone https://github.com/anand-cpp/AgentFlow.git
cd AgentFlow
node bin/aflow.js setup --check
```

```
$ node bin/aflow.js setup --check

keys file: C:\Users\anand\AppData\Local\agentflow\keys.env
  · ollama                 fetch failed

No hosted providers are configured yet — run `aflow setup`.
```

`setup` writes keys to a single `keys.env` under your state directory — never to
the repo, never to your shell history. Run the wizard once, add any of the free
providers, and you are routing.

```sh
node bin/aflow.js setup      # wizard: pick a provider, paste a key, it is tested before it is saved
node bin/aflow.js chat       # start a session
```

```
$ node bin/aflow.js chat

aflow chat · coder · no model · session ses_20261015T172503281Z_93qr3p (new)
workspace C:\Users\anand\9router (git)
type /help for commands, /quit to exit. Ctrl+C cancels a response.

>
```

---

## What you get

```
╔═══════════════════════════════╗   ╔═══════════════════════════════╗
║ THE TRIBUNAL                  ║   ║ NEVER LOSES WORK              ║
║                               ║   ║                               ║
║ Five adversarial stages       ║   ║ A dead model fails over       ║
║ review a proposal across      ║   ║ mid-conversation. Context     ║
║ models, then a confidence     ║   ║ is preserved and the switch   ║
║ gate decides if it ships.     ║   ║ is recorded. No retyping.     ║
╚═══════════════════════════════╝   ╚═══════════════════════════════╝
╔═══════════════════════════════╗   ╔═══════════════════════════════╗
║ TWELVE FREE PROVIDERS         ║   ║ ZERO DEPENDENCIES             ║
║                               ║   ║                               ║
║ Groq · Cerebras · Mistral     ║   ║ Pure Node builtins. 1177+     ║
║ Gemini · OpenRouter ·         ║   ║ tests. Lint and typecheck     ║
║ Cloudflare · HuggingFace ·    ║   ║ block every change.           ║
║ Together · Fireworks ·        ║   ║                               ║
║ DeepInfra · SambaNova ·       ║   ╚═══════════════════════════════╝
║ Ollama (local).               ║                                    
╚═══════════════════════════════╝                                    
```

---

## The tribunal

Every proposal runs the same five stages, in order. Each stage narrows the field
and leaves behind a record the next one reads.

```
        proposal
           │
           ▼
      ╔════════╗
      ║ FORGE  ║   self-adversarial review
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║CRUCIBLE║   cross-examination
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║ MERGE  ║   hybrid synthesis
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║ TRIAL  ║   prosecution
      ╚════╤═══╝
           │
           ▼
      ╔════════╗
      ║ ORACLE ║   confidence gate
      ╚════╤═══╝
           │
           ▼
   VERIFIED · INSUFFICIENT_CONFIDENCE · REJECTED · ABORTED
```

Forge reviews a proposal against itself. Crucible cross-examines it from
adversarial vectors and scores its survival. Merge synthesizes the survivors
into a hybrid. Trial prosecutes the hybrid and can send it back for another
merge. Oracle weighs all five scores — self 0.15, survival 0.25, merge 0.20,
trial 0.30, validation 0.10 — and returns a verdict against a 0.95 gate.

A run that cannot finish is not a pass. A skipped stage yields **ABORTED**, not
a quiet success. The tribunal fails closed.
