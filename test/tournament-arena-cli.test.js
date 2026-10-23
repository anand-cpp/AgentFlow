// Arena CLI tests (src/commands/tribunal.js -> runArenaSub).
//
// These drive the whole surface with a deterministic mock provider: generation,
// attack, defense, revision, judge, and the five-stage Tribunal that validates
// the champion. No network, no credentials, no clock dependence beyond what the
// command itself generates.
//
// The three properties that matter most here are behavioural, not cosmetic:
// confirmation happens before any model call, an interrupted run resumes without
// paying twice, and an unresolved match is never turned into a winner.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tribunalCommand } from "../src/commands/tribunal.js";
import { SessionStore, ENTRY_KIND } from "../src/core/sessions.js";
import { ArenaStore } from "../src/core/tournament/store.js";
import { GENERATION_SYSTEM_PROMPT } from "../src/core/tournament/candidates.js";
import {
  ATTACK_SYSTEM_PROMPT,
  DEFENSE_SYSTEM_PROMPT,
  MATCH_SCHEMA_VERSION,
  REVISION_SYSTEM_PROMPT,
} from "../src/core/tournament/match-schema.js";
import { JUDGE_SCHEMA_VERSION, JUDGE_SYSTEM_PROMPT } from "../src/core/tournament/judge.js";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function stubOut() {
  const rendered = [];
  const out = {
    json: false,
    quiet: false,
    verbose: false,
    rendered,
    last() {
      return rendered[rendered.length - 1];
    },
    async init(result, renderText) {
      const text = typeof renderText === "function" ? renderText(result) : null;
      rendered.push({ result, text });
      return text;
    },
    info(message) {
      rendered.push({ info: message });
    },
    status(message) {
      rendered.push({ status: message });
    },
    error(message) {
      rendered.push({ error: message });
    },
    warn(message) {
      rendered.push({ warn: message });
    },
    detail(message) {
      rendered.push({ detail: message });
    },
  };
  return out;
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aflow-arena-cli-"));
}

async function run(args, dir, { flags = {}, deps = {}, out = stubOut() } = {}) {
  const returned = await tribunalCommand.run({
    args,
    flags: { "state-dir": dir, ...flags },
    config: {},
    out,
    deps,
  });
  const code = typeof returned === "number" ? returned : 0;
  return { code, out, payload: out.last()?.result };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const SELF_REVIEW = {
  schemaVersion: 1,
  candidateId: "candidate",
  originalApproach: "the approach",
  strongestCounterArgument: "the counter",
  failureHypotheses: [],
  failureHypothesesRationale: "nothing material",
  assumptions: [],
  missingEvidence: [],
  securityWeaknesses: [],
  logicRisks: [],
  edgeCases: [],
  performanceConcerns: [],
  proposedTests: [],
  confidenceBefore: 0.9,
  confidenceAfter: 0.9,
  confidenceJustification: "no material change",
  decision: "RETAIN_WITH_EVIDENCE",
  revisedApproach: null,
};

const CRUCIBLE_PASS = {
  schema_version: 1,
  attacker_perspective: "SECURITY",
  target_proposal_id: "proposal-1",
  verdict: "PASS",
  findings: [],
  summary: "the proposal held",
};

const MERGE = {
  schema_version: 1,
  decision: "SYNTHESIZED",
  hybrid_solution: {
    content: "THE HYBRID",
    elements: [
      {
        element_id: "e1",
        source_proposal_ids: ["proposal-1"],
        rationale: "from the champion",
        addresses_findings: [],
      },
    ],
  },
  findings_resolution: [],
  discarded_elements: [],
  synthesis_notes: "merged",
  insufficiency_reason: null,
};

const TRIAL = {
  schema_version: 1,
  verdict: "ACQUITTED",
  findings: [],
  prosecution_summary: "clean",
  recommended_retry_focus: null,
};

function scores(correctness, completeness, robustness, specificity, clarity) {
  return { correctness, completeness, robustness, specificity, clarity };
}

function judgeReport(matchId, { tie = false } = {}) {
  return {
    schema_version: JUDGE_SCHEMA_VERSION,
    match_id: matchId,
    scores: tie
      ? { candidate_a: scores(7, 7, 7, 7, 7), candidate_b: scores(7, 7, 7, 7, 7) }
      : { candidate_a: scores(9, 8, 8, 7, 8), candidate_b: scores(8, 8, 7, 7, 8) },
    unresolved_objections: { candidate_a: [], candidate_b: [] },
    fatal_flaw: null,
    verdict: tie ? "TIE" : "A_WINS",
    rationale: tie ? "level on every criterion" : "A is more robust.",
    judge_model: "fixture-judge",
  };
}

/**
 * One provider for every stage in the run. `failOn` makes the attack stage of
 * one match fail with a missing-credential error, which is the cheapest way to
 * produce an interrupted bracket with earlier winners intact.
 */
function arenaDeps({ failOn = null, unresolved = false, confirm = undefined, log = [] } = {}) {
  const complete = async (config, modelId, prompt, opts) => {
    const system = opts?.system ?? "";
    log.push({ system, prompt, modelId });

    if (system === GENERATION_SYSTEM_PROMPT) {
      const id = prompt.match(/You are candidate (\S+) in a competitive/)?.[1] ?? "candidate";
      return { text: `PROPOSAL for ${id}:\n1. Do the thing.\n2. Test the thing.` };
    }

    if (system === ATTACK_SYSTEM_PROMPT) {
      const matchId = prompt.match(/Match: (\S+)/)?.[1] ?? "r1m1";
      if (failOn && matchId === failOn) {
        throw new Error("401 unauthorized: missing api key");
      }
      const isA = prompt.includes("(candidate_a)");
      return {
        text: JSON.stringify({
          schema_version: MATCH_SCHEMA_VERSION,
          match_id: matchId,
          attacker: isA ? "candidate_a" : "candidate_b",
          target: isA ? "candidate_b" : "candidate_a",
          summary: "one concrete risk",
          attacks: [
            {
              criterion: "robustness",
              severity: "SERIOUS",
              claim: "no retry on timeout",
              evidence: { kind: "TEST_CASE", payload: "retry.test.js fails on timeout" },
            },
          ],
        }),
      };
    }

    if (system === DEFENSE_SYSTEM_PROMPT) {
      const matchId = prompt.match(/Match: (\S+)/)?.[1] ?? "r1m1";
      const count = (prompt.match(/^\[\d+\]/gm) ?? []).length;
      return {
        text: JSON.stringify({
          schema_version: MATCH_SCHEMA_VERSION,
          match_id: matchId,
          defender: prompt.includes("(candidate_a)") ? "candidate_a" : "candidate_b",
          responses: Array.from({ length: count }, (_, index) => ({
            attack_index: index,
            stance: "FIXED",
            explanation: "added the missing retry",
          })),
        }),
      };
    }

    if (system === REVISION_SYSTEM_PROMPT) {
      const matchId = prompt.match(/Match: (\S+)/)?.[1] ?? "r1m1";
      const isA = prompt.includes("(candidate_a)");
      return {
        text: JSON.stringify({
          schema_version: MATCH_SCHEMA_VERSION,
          match_id: matchId,
          candidate: isA ? "candidate_a" : "candidate_b",
          proposal: isA ? "REVISED PROPOSAL A" : "REVISED PROPOSAL B",
          changes: ["added the retry"],
        }),
      };
    }

    if (system === JUDGE_SYSTEM_PROMPT) {
      const matchId = prompt.match(/Match: (\S+)/)?.[1] ?? "r1m1";
      return { text: JSON.stringify(judgeReport(matchId, { tie: unresolved })) };
    }

    // Tribunal stages (the champion's final validation).
    if (/hostile but fair reviewer/.test(system)) return { text: JSON.stringify(SELF_REVIEW) };
    if (/adversarial examiner/.test(system)) return { text: JSON.stringify(CRUCIBLE_PASS) };
    if (/neutral senior architect/.test(system)) return { text: JSON.stringify(MERGE) };
    if (/prosecutor/.test(system)) return { text: JSON.stringify(TRIAL) };
    return { text: "{}" };
  };

  const deps = { complete, listModels: async () => [{ id: "mock-a" }] };
  if (confirm !== undefined) deps.confirm = async () => confirm;
  return deps;
}

const BASE_FLAGS = { model: "mock-a", judge: "judge-model" };

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test("a quick arena runs four candidates, then validates the champion through Trial and Oracle", async () => {
  const dir = scratch();
  const log = [];
  try {
    const { code, payload, out } = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true },
      deps: arenaDeps({ log }),
    });

    assert.equal(code, 0);
    assert.equal(payload.status, "completed");
    assert.match(payload.champion, /^cand-/);
    assert.equal(payload.championModel, "mock-a");
    assert.equal(payload.tournament.agents, 4);
    assert.equal(payload.tournament.rounds.length, 2);
    assert.equal(payload.tournament.matchesRun, 3);
    assert.equal(payload.calls.generation, 4);
    assert.equal(payload.calls.matches, 21);
    assert.equal(payload.validation.result.oracle.verdict, "VERIFIED");
    assert.equal(payload.validation.champion, payload.champion);
    assert.deepEqual(payload.errors, []);

    // Four proposals generated, three matches played, then one Tribunal run.
    const generation = log.filter((entry) => entry.system === GENERATION_SYSTEM_PROMPT);
    assert.equal(generation.length, 4);
    const attacks = log.filter((entry) => entry.system === ATTACK_SYSTEM_PROMPT);
    assert.equal(attacks.length, 6);

    assert.match(out.last().text, /final validation/);
    assert.match(out.last().text, /TRIBUNAL FIGHT CARD/);
    assert.match(out.last().text, /aflow arena/);
    assert.doesNotMatch(out.last().text, /undefined/);

    // Raw judge artifacts live in the match record, not in the bracket state.
    const store = new ArenaStore({ dir: path.join(dir, "arena") });
    const state = store.loadState(payload.arenaId);
    assert.equal(state.status, "completed");
    assert.equal(state.champion, payload.champion);
    assert.ok(state.candidates.every((candidate) => Object.keys(candidate.artifacts ?? {}).length === 0));
    const match = store.loadMatch(payload.arenaId, "r1m1");
    assert.ok(match.artifacts.judge.text.includes("candidate_a"));
    assert.equal(match.artifacts.judge.report.judge_model, "fixture-judge");
    assert.equal(store.loadProposals(payload.arenaId)[payload.champion].includes("PROPOSAL"), true);
    assert.equal(store.loadValidation(payload.arenaId).result.oracle.verdict, "VERIFIED");

    // The run is recorded in the session store under its own kind.
    const sessions = new SessionStore({ dir });
    const session = sessions.read(payload.sessionId);
    const recorded = session.entries.filter((entry) => entry.kind === ENTRY_KIND.ARENA_RUN);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].champion, payload.champion);
    assert.equal(recorded[0].validation_verdict, "VERIFIED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run --arena is the same command as arena", async () => {
  const dir = scratch();
  try {
    const { code, payload } = await run(["run", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, arena: true, quick: true, yes: true },
      deps: arenaDeps(),
    });
    assert.equal(code, 0);
    assert.equal(payload.status, "completed");
    assert.match(payload.arenaId, /^arena_/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// spend guard
// ---------------------------------------------------------------------------

test("declining confirmation makes zero model calls and leaves no tournament behind", async () => {
  const dir = scratch();
  const log = [];
  try {
    const { code, payload, out } = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true },
      deps: arenaDeps({ log, confirm: false }),
    });

    assert.equal(code, 1);
    assert.equal(payload.status, "declined");
    assert.equal(payload.arenaId, null);
    assert.equal(log.length, 0, "nothing may be spent before confirmation");
    assert.equal(fs.existsSync(path.join(dir, "arena")), false);
    assert.match(out.last().text, /needs confirmation/);
    assert.match(out.last().text, /--yes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-TTY arena run refuses without --yes", async (t) => {
  if (process.stdin.isTTY) {
    t.skip("stdin is a TTY in this environment; the interactive path would prompt");
    return;
  }
  const dir = scratch();
  const log = [];
  try {
    const { code, payload } = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true },
      deps: arenaDeps({ log }),
    });
    assert.equal(code, 1);
    assert.equal(payload.status, "declined");
    assert.equal(log.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an out-of-range budget is a usage error before any call", async () => {
  const dir = scratch();
  const log = [];
  try {
    const { code, out } = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true, budget: "3" },
      deps: arenaDeps({ log }),
    });
    assert.equal(code, 2);
    assert.equal(log.length, 0);
    assert.match(out.last().text, /--budget must be an integer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an impossible agent count is a usage error", async () => {
  const dir = scratch();
  try {
    const { code, out } = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, yes: true, agents: "1" },
      deps: arenaDeps(),
    });
    assert.equal(code, 2);
    assert.match(out.last().text, /--agents must be an integer between 2 and 32/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// interruption and resume
// ---------------------------------------------------------------------------

test("a failed match stops the tournament, and --resume finishes it without replaying winners", async () => {
  const dir = scratch();
  try {
    const first = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true, retries: "0" },
      deps: arenaDeps({ failOn: "r1m2" }),
    });

    assert.equal(first.code, 1);
    assert.equal(first.payload.status, "failed");
    assert.equal(first.payload.champion, null);
    assert.match(first.payload.errors.join(" "), /401 unauthorized/);
    assert.match(first.out.last().text, /resume with: aflow tribunal arena --resume/);

    const arenaDir = path.join(dir, "arena");
    const store = new ArenaStore({ dir: arenaDir });
    const interrupted = store.loadState(first.payload.arenaId);
    assert.equal(interrupted.status, "running");
    const alreadyWon = interrupted.rounds[0].matches.find((match) => match.id === "r1m1")?.winner;
    assert.ok(alreadyWon, "the match that finished before the failure stays decided");

    const resumed = await run(["arena"], dir, {
      flags: { judge: "judge-model", yes: true, retries: "0", resume: first.payload.arenaId },
      deps: arenaDeps(),
    });

    assert.equal(resumed.code, 0);
    assert.equal(resumed.payload.status, "completed");
    assert.equal(resumed.payload.resumed, true);
    assert.equal(resumed.payload.tournament.matchesRun, 2, "only the two undecided matches run");
    assert.equal(resumed.payload.calls.generation, 0);
    assert.equal(resumed.payload.calls.matches, 14);

    const finished = store.loadState(first.payload.arenaId);
    assert.equal(finished.status, "completed");
    assert.equal(finished.rounds[0].matches.find((match) => match.id === "r1m1")?.winner, alreadyWon);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolved match is reported unresolved, and resume re-asks only the judge", async () => {
  const dir = scratch();
  const resumeLog = [];
  try {
    const first = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true },
      deps: arenaDeps({ unresolved: true }),
    });

    assert.equal(first.code, 1);
    assert.equal(first.payload.status, "unresolved");
    assert.equal(first.payload.champion, null);
    assert.deepEqual(first.payload.unresolved.map((entry) => entry.matchId), ["r1m1"]);

    const resumed = await run(["arena"], dir, {
      flags: { judge: "judge-model", yes: true, resume: first.payload.arenaId },
      deps: arenaDeps({ log: resumeLog }),
    });

    assert.equal(resumed.code, 0);
    assert.equal(resumed.payload.status, "completed");
    assert.equal(resumed.payload.tournament.matchesRun, 3);

    // The unresolved match replays its debate artifacts and only re-asks the
    // judge; the remaining bracket is played normally.
    const r1m1 = resumeLog.filter((entry) => /Match: r1m1/.test(entry.prompt));
    assert.equal(r1m1.length, 1);
    assert.equal(r1m1[0].system, JUDGE_SYSTEM_PROMPT);
    assert.equal(resumed.payload.calls.matches, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming a completed and validated tournament makes no model calls", async () => {
  const dir = scratch();
  try {
    const first = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true },
      deps: arenaDeps(),
    });
    assert.equal(first.code, 0);

    const log = [];
    const again = await run(["arena"], dir, {
      flags: { judge: "judge-model", resume: first.payload.arenaId },
      deps: arenaDeps({ log }),
    });

    assert.equal(again.code, 0);
    assert.equal(again.payload.status, "completed");
    assert.equal(again.payload.champion, first.payload.champion);
    assert.equal(again.payload.calls.matches, 0);
    assert.equal(log.length, 0);
    assert.equal(again.payload.validation.result.oracle.verdict, "VERIFIED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming an unknown arena id is a usage error, not a new tournament", async () => {
  const dir = scratch();
  const log = [];
  try {
    const { code, out } = await run(["arena"], dir, {
      flags: { ...BASE_FLAGS, yes: true, resume: "arena_missing" },
      deps: arenaDeps({ log }),
    });
    assert.equal(code, 2);
    assert.equal(log.length, 0);
    assert.match(out.last().text, /no arena run found with id arena_missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume reuses the recorded judge instead of the first candidate model", async () => {
  const dir = scratch();
  const resumeLog = [];
  try {
    const first = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true, retries: "0" },
      deps: arenaDeps({ failOn: "r1m2" }),
    });
    assert.equal(first.code, 1);

    const store = new ArenaStore({ dir: path.join(dir, "arena") });
    assert.equal(
      store.loadState(first.payload.arenaId).config.judgeModel,
      "judge-model",
      "the judge is recorded with the tournament",
    );

    // No --judge on the resume: the recorded judge must win over models[0].
    const resumed = await run(["arena"], dir, {
      flags: { yes: true, retries: "0", resume: first.payload.arenaId },
      deps: arenaDeps({ log: resumeLog }),
    });
    assert.equal(resumed.code, 0);

    const judgeCalls = resumeLog.filter((entry) => entry.system === JUDGE_SYSTEM_PROMPT);
    assert.ok(judgeCalls.length > 0);
    assert.ok(
      judgeCalls.every((entry) => entry.modelId === "judge-model"),
      "every resumed match is judged by the recorded model",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the report counts generation retries as actual calls", async () => {
  const dir = scratch();
  try {
    const deps = arenaDeps();
    const original = deps.complete;
    let returnedEmpty = false;
    deps.complete = async (...args) => {
      const opts = args[3] ?? {};
      if (opts.system === GENERATION_SYSTEM_PROMPT && !returnedEmpty) {
        returnedEmpty = true;
        return { text: "   " };
      }
      return original(...args);
    };

    const { code, payload } = await run(["arena", "Fix the retry bug"], dir, {
      flags: { ...BASE_FLAGS, quick: true, yes: true },
      deps,
    });

    assert.equal(code, 0);
    assert.equal(returnedEmpty, true);
    assert.equal(
      payload.calls.generation,
      5,
      "four proposals plus one retry, not the four-call estimate",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
