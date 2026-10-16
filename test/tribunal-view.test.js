// Live tribunal battle view (src/tui/tribunal-view.js): pure ANSI rendering of
// the five-round board. No terminal, no timers -- every function is a pure
// function of a plain state object. Colour disabled via the shared ui module.

import test from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
process.env.TERM = "xterm";
delete process.env.FORCE_COLOR;

const v = await import("../src/tui/tribunal-view.js");
const ui = await import("../src/cli/ui.js");
ui.setColor(false);

test("the round table has the five pipeline stages in order", () => {
  assert.equal(v.TOTAL_ROUNDS, 5);
  assert.deepEqual(
    v.TRIBUNAL_ROUNDS.map((r) => r.stage),
    ["FORGE", "CRUCIBLE", "MERGE", "TRIAL", "ORACLE"],
  );
  assert.deepEqual(
    v.TRIBUNAL_ROUNDS.map((r) => r.round),
    [1, 2, 3, 4, 5],
  );
});

test("createTribunalState starts every round pending with no model", () => {
  const s = v.createTribunalState({});
  assert.equal(s.rounds.length, 5);
  assert.ok(s.rounds.every((r) => r.status === "pending"));
  assert.ok(s.rounds.every((r) => r.percent === null));
  assert.equal(s.complete, false);
  assert.equal(s.oracle, null);
  assert.equal(s.domain, "code", "domain defaults to code");
});

test("createTribunalState stamps a model on every round until one reports", () => {
  const s = v.createTribunalState({ tribunalId: "trib_1", domain: "legal", modelId: "a/one" });
  assert.equal(s.tribunalId, "trib_1");
  assert.equal(s.domain, "legal");
  assert.ok(s.rounds.every((r) => r.modelId === "a/one"));
});

test("statusWord normalises every spelling onto the four states", () => {
  assert.equal(v.statusWord("RUNNING"), "running");
  assert.equal(v.statusWord("active"), "running");
  assert.equal(v.statusWord("completed"), "done");
  assert.equal(v.statusWord("ok"), "done");
  assert.equal(v.statusWord("aborted"), "error");
  assert.equal(v.statusWord("failed"), "error");
  assert.equal(v.statusWord(undefined), "pending");
  assert.equal(v.statusWord("nonsense"), "pending");
});

test("applyStageEvent marks a round running then done and computes percent", () => {
  const s = v.createTribunalState({});
  v.applyStageEvent(s, { stage: "FORGE", status: "running", modelId: "a/one", percent: 40 });
  const forge = s.rounds[0];
  assert.equal(forge.status, "running");
  assert.equal(forge.modelId, "a/one");
  assert.equal(forge.percent, 40);

  v.applyStageEvent(s, { stage: "forge", status: "done", result: {} });
  assert.equal(forge.status, "done");
  assert.equal(forge.percent, 100, "a done round without a number reads 100");
});

test("applyStageEvent ignores an unknown stage and never throws", () => {
  const s = v.createTribunalState({});
  const out = v.applyStageEvent(s, { stage: "NOPE", status: "done" });
  assert.equal(out, s, "returns the same board");
  assert.ok(s.rounds.every((r) => r.status === "pending"));
  assert.doesNotThrow(() => v.applyStageEvent(undefined, {}));
  assert.doesNotThrow(() => v.applyStageEvent(s, undefined));
});

test("applyStageEvent clamps and rounds a percent", () => {
  const s = v.createTribunalState({});
  v.applyStageEvent(s, { stage: "MERGE", status: "running", percent: 140 });
  assert.equal(s.rounds[2].percent, 100);
  v.applyStageEvent(s, { stage: "MERGE", status: "running", percent: -5 });
  assert.equal(s.rounds[2].percent, 0);
  v.applyStageEvent(s, { stage: "MERGE", status: "running", percent: 33.7 });
  assert.equal(s.rounds[2].percent, 34);
});

test("applyStageEvent records an error and clears the percent", () => {
  const s = v.createTribunalState({});
  v.applyStageEvent(s, { stage: "TRIAL", status: "running", percent: 50 });
  v.applyStageEvent(s, { stage: "TRIAL", status: "error", error: "boom" });
  const trial = s.rounds[3];
  assert.equal(trial.status, "error");
  assert.equal(trial.error, "boom");
  assert.equal(trial.percent, null, "an errored round shows no progress");
});

test("applyStageEvent extracts Crucible findings from per-proposal results", () => {
  const s = v.createTribunalState({});
  v.applyStageEvent(s, {
    stage: "CRUCIBLE",
    status: "done",
    result: {
      results: [
        { aggregatedFindings: [{ severity: "P0_CRITICAL", vector: "SEC", title: "leak" }] },
        { aggregatedFindings: [{ severity: "P2_MINOR", vector: "STYLE", title: "nits" }] },
      ],
    },
  });
  assert.equal(s.rounds[1].findings.length, 2);
  assert.equal(s.rounds[1].findings[0].title, "leak");
});

test("applyStageEvent extracts Trial findings from either report path", () => {
  const a = v.createTribunalState({});
  v.applyStageEvent(a, { stage: "TRIAL", status: "done", result: { trialResult: { report: { findings: [{ title: "x" }] } } } });
  assert.equal(a.rounds[3].findings.length, 1);

  const b = v.createTribunalState({});
  v.applyStageEvent(b, { stage: "TRIAL", status: "done", result: { finalTrial: { report: { findings: [{ title: "y" }, { title: "z" }] } } } });
  assert.equal(b.rounds[3].findings.length, 2);
});

test("applyStageEvent lifts the oracle verdict and battle report from the ORACLE result", () => {
  const s = v.createTribunalState({});
  v.applyStageEvent(s, {
    stage: "ORACLE",
    status: "done",
    result: { oracleResult: { verdict: "VERIFIED", confidence: 0.98, battle_report: { title: "The fight" } } },
  });
  assert.equal(s.oracle.verdict, "VERIFIED");
  assert.equal(s.battleReport.title, "The fight");
});

test("applyStageEvent marks the board complete only when every round is terminal", () => {
  const s = v.createTribunalState({});
  for (const stage of ["FORGE", "CRUCIBLE", "MERGE", "TRIAL"]) {
    v.applyStageEvent(s, { stage, status: "done", result: {} });
  }
  assert.equal(s.complete, false, "ORACLE still pending");
  v.applyStageEvent(s, { stage: "ORACLE", status: "done", result: { oracleResult: {} } });
  assert.equal(s.complete, true);
});

test("applyStageEvent treats a mixed done/error tail as complete", () => {
  const s = v.createTribunalState({});
  for (const stage of ["FORGE", "CRUCIBLE", "MERGE", "TRIAL"]) {
    v.applyStageEvent(s, { stage, status: "done", result: {} });
  }
  v.applyStageEvent(s, { stage: "ORACLE", status: "error", error: "gate closed" });
  assert.equal(s.complete, true, "an error is terminal too");
});

test("renderRoundHeader names the round and carries the blurb", () => {
  const out = v.renderRoundHeader("CRUCIBLE", 2, 5);
  assert.match(out, /ROUND 2/);
  assert.match(out, /CRUCIBLE/);
  assert.match(out, /2\/5/);
  assert.match(out, /cross-examination/);
  assert.ok(!out.includes("\u001b"), "colour disabled → no escapes");
});

test("renderRoundHeader tolerates an unknown stage and a missing total", () => {
  const out = v.renderRoundHeader("MYSTERY", 9);
  assert.match(out, /MYSTERY/);
  assert.match(out, /9\/5/, "falls back to the canonical total");
  assert.doesNotThrow(() => v.renderRoundHeader(undefined, undefined));
});

test("renderModelProgress shows the label, status word and a bar", () => {
  const out = v.renderModelProgress("a/one", "running", 40, { labelWidth: 12 });
  assert.match(out, /a\/one/);
  assert.match(out, /running/);
  assert.match(out, /40%/, "percent is right-aligned into 3 cells");
  assert.match(out, /◆/, "running bar fills with diamonds");
});

test("renderModelProgress right-aligns the percent so 40 reads as 40%", () => {
  const out = v.renderModelProgress("m", "running", 40);
  assert.match(out, / 40%/);
  assert.doesNotMatch(out, /40 %/);
  assert.match(v.renderModelProgress("m", "running", 5), /\s{2}5%/);
  assert.match(v.renderModelProgress("m", "running", 100), /100%/);
});

test("renderModelProgress distinguishes pending, running-unknown, done and error", () => {
  assert.match(v.renderModelProgress("m", "pending", null), /\s-\s*$/);
  assert.match(v.renderModelProgress("m", "running", null), /…/);
  const done = v.renderModelProgress("m", "done", null);
  assert.match(done, /100%/, "done defaults to full");
  assert.match(done, /done/, "status word is spelled out");
  const err = v.renderModelProgress("m", "error", null);
  assert.match(err, /error/);
  assert.match(err, /░/, "error bar is shaded");
});

test("renderModelProgress brackets the label to the requested width", () => {
  const out = v.renderModelProgress("a-very-long-model-identifier-here", "running", 10, { labelWidth: 10 });
  assert.match(out, /…/, "over-long labels truncate");
});

test("renderFindings renders one painted line per finding", () => {
  const out = v.renderFindings([
    { severity: "P0_CRITICAL", vector: "SEC", title: "credential leak" },
    { severity: "P2_MINOR", vector: "STYLE", title: "naming" },
  ]);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /P0_CRITICAL/);
  assert.match(lines[0], /credential leak/);
  assert.match(lines[1], /P2_MINOR/);
  assert.ok(!out.includes("\u001b"));
});

test("renderFindings says so when there are none", () => {
  assert.match(v.renderFindings([]), /no findings/);
  assert.match(v.renderFindings(null), /no findings/);
});

test("renderFindings falls back for an unknown severity", () => {
  const out = v.renderFindings([{ severity: "P9", vector: "-", title: "mystery" }]);
  assert.match(out, /P9/);
  assert.match(out, /mystery/);
});

test("renderOracleVerdict shows the verdict, confidence and the gate", () => {
  const clears = v.renderOracleVerdict({ verdict: "VERIFIED", confidence: 0.97 });
  assert.match(clears, /VERIFIED/);
  assert.match(clears, /0\.97/);
  assert.match(clears, /✓/);
  assert.match(clears, /clears/);

  const below = v.renderOracleVerdict({ verdict: "INSUFFICIENT_CONFIDENCE", confidence: 0.5 });
  assert.match(below, /✗/);
  assert.match(below, /below/);
  assert.match(below, /0\.50/);
});

test("renderOracleVerdict handles a missing confidence and a null report", () => {
  const noConf = v.renderOracleVerdict({ verdict: "ABORTED" });
  assert.match(noConf, /ABORTED/);
  assert.doesNotMatch(noConf, /clears|below/, "no gate line without a number");
  assert.match(v.renderOracleVerdict(null), /no oracle report/);
});

test("renderBattleReport narrates the title, rounds and tallies", () => {
  const out = v.renderBattleReport({
    title: "The great fight",
    summary: "two fighters entered",
    rounds: [
      { round_number: 1, stage: "FORGE", events: ["opened", "exchanged", "paused", "extra"] },
      { round_number: 2, stage: "CRUCIBLE", events: ["cross-examined"] },
    ],
    total_findings: { p0: 1, p1: 2, p2: 3, p3: 4 },
    unresolved_critical: 0,
    winner: "proposal B",
  });
  assert.match(out, /The great fight/);
  assert.match(out, /two fighters entered/);
  assert.match(out, /round 1/);
  assert.match(out, /FORGE/);
  assert.match(out, /P0 1/);
  assert.match(out, /unresolved critical 0/);
  assert.match(out, /winner/);
  assert.match(out, /proposal B/);
  assert.ok(!out.includes("\u001b"));
});

test("renderBattleReport caps events per round and never throws on a partial report", () => {
  const out = v.renderBattleReport({ rounds: [{ round_number: 1, stage: "FORGE", events: ["a", "b", "c", "d", "e"] }] });
  const eventLines = out.split("\n").filter((l) => /^\s{6}\S/.test(l));
  assert.equal(eventLines.length, 3, "at most three events narrated per round");
  assert.match(v.renderBattleReport(null), /no battle report/);
  assert.match(v.renderBattleReport({}), /no battle report/);
});

test("renderTribunalProgress draws a title and one row per round", () => {
  const s = v.createTribunalState({ tribunalId: "trib_7", domain: "code" });
  const out = v.renderTribunalProgress(s, { width: 100 });
  assert.match(out, /TRIBUNAL/);
  assert.match(out, /trib_7/);
  assert.match(out, /FORGE/);
  assert.match(out, /ORACLE/);
  const rows = out.split("\n").filter((l) => /^\s{2}\S\s+\d\s+[A-Z]+\s/.test(l));
  assert.equal(rows.length, 5, "one status row per round");
  assert.ok(!out.includes("\u001b"));
});

test("renderTribunalProgress compacts the title on a narrow board", () => {
  const s = v.createTribunalState({ tribunalId: "trib_7", domain: "code" });
  const wide = v.renderTribunalProgress(s, { width: 100 });
  const narrow = v.renderTribunalProgress(s, { width: 30 });
  assert.match(wide, /domain/);
  assert.doesNotMatch(narrow.split("\n")[0], /domain/, "title drops the domain when cramped");
});

test("renderTribunalProgress shows the verdict and report once complete", () => {
  const s = v.createTribunalState({ tribunalId: "trib_7" });
  for (const stage of ["FORGE", "CRUCIBLE", "MERGE", "TRIAL"]) {
    v.applyStageEvent(s, { stage, status: "done", result: {} });
  }
  v.applyStageEvent(s, {
    stage: "ORACLE",
    status: "done",
    result: { oracleResult: { verdict: "VERIFIED", confidence: 0.99, battle_report: { title: "Done deal", winner: "A" } } },
  });
  const out = v.renderTribunalProgress(s, { width: 100 });
  assert.match(out, /VERIFIED/);
  assert.match(out, /Done deal/);
});

test("renderTribunalProgress surfaces findings from completed stages", () => {
  const s = v.createTribunalState({});
  v.applyStageEvent(s, {
    stage: "CRUCIBLE",
    status: "done",
    result: { results: [{ aggregatedFindings: [{ severity: "P0_CRITICAL", vector: "SEC", title: "leak" }] }] },
  });
  const out = v.renderTribunalProgress(s, { width: 100 });
  assert.match(out, /findings \(1\)/);
  assert.match(out, /leak/);
});

test("renderTribunalProgress never throws on malformed input", () => {
  assert.doesNotThrow(() => v.renderTribunalProgress());
  assert.doesNotThrow(() => v.renderTribunalProgress(null));
  assert.doesNotThrow(() => v.renderTribunalProgress({ rounds: "no" }));
  const noRounds = v.renderTribunalProgress({ rounds: [] });
  assert.match(noRounds, /no rounds recorded/);
});
