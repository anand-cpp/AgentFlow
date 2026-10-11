// `aflow tribunal` command + fight-card renderer tests.
//
// The tribunal library is tested stage by stage (test/tribunal-*.test.js). This
// file covers the surface that ties it to a human: the command layer
// (subcommand dispatch, usage errors, persistence) and the renderer, whose
// whole job is to never throw on a partial run.
//
// Every provider here is a deterministic mock. The command takes a `deps` bag so
// tests can drive the full run -- Forge through Oracle -- with no network and no
// credentials; the router never passes it, so production uses the real gateway.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { tribunalCommand, fightCommand, buildProposals, resolveModels } from "../src/commands/tribunal.js";
import { renderFightCard, renderBox, renderHistoryRow } from "../src/core/tribunal/formatter.js";
import { SessionStore, ENTRY_KIND } from "../src/core/sessions.js";
import { BlackboardStore } from "../src/core/blackboard.js";
import { ORACLE_VERDICT } from "../src/core/tribunal/oracle-schema.js";
import { valueFlagNames } from "../src/cli/registry.js";
import { parseArgv } from "../src/cli/index.js";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "aflow-tribunal-cli-"));
}

async function run(args, dir, { flags = {}, config = {}, deps = {} } = {}) {
  const out = stubOut();
  const returned = await tribunalCommand.run({
    args,
    flags: { "state-dir": dir, ...flags },
    config,
    out,
    deps,
  });
  const code = typeof returned === "number" ? returned : 0;
  return { code, out, payload: out.last()?.result };
}

// ---------------------------------------------------------------------------
// mock providers -- one JSON fixture per stage, selected by system prompt
// ---------------------------------------------------------------------------

const SELF_REVIEW = {
  schemaVersion: 1,
  candidateId: "candidate",
  originalApproach: "the approach",
  strongestCounterArgument: "the counter",
  failureHypotheses: [{ statement: "maybe slow", severity: "low", category: "performance", evidence: "hypothesis", reproduction: null }],
  failureHypothesesRationale: "one plausible concern",
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
      { element_id: "e1", source_proposal_ids: ["proposal-1"], rationale: "from A", addresses_findings: [] },
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

function tribunalDeps() {
  const complete = async (config, modelId, prompt, opts) => {
    const system = opts?.system ?? "";
    if (/hostile but fair reviewer/.test(system)) return { text: JSON.stringify(SELF_REVIEW) };
    if (/adversarial examiner/.test(system)) return { text: JSON.stringify(CRUCIBLE_PASS) };
    if (/neutral senior architect/.test(system)) return { text: JSON.stringify(MERGE) };
    if (/prosecutor/.test(system)) return { text: JSON.stringify(TRIAL) };
    return { text: "{}" };
  };
  return { complete, listModels: async () => [{ id: "mock", provider: "mock" }] };
}

// ---------------------------------------------------------------------------
// renderer
// ---------------------------------------------------------------------------

test("renderBox draws a closed heavy-border box", () => {
  const box = renderBox([["hello"]], 20);
  const lines = box.split("\n");
  assert.ok(lines[0].startsWith("\u2554"));
  assert.ok(lines[0].endsWith("\u2557"));
  assert.ok(lines[lines.length - 1].startsWith("\u255a"));
  assert.ok(lines[lines.length - 1].endsWith("\u255d"));
  assert.ok(lines[1].includes("hello"));
});

test("renderFightCard names every round and survives an empty record", () => {
  const text = renderFightCard({});
  assert.match(text, /TRIBUNAL FIGHT CARD/);
  assert.match(text, /ROUND 1 . FORGE/);
  assert.match(text, /ROUND 5 . ORACLE/);
  assert.match(text, /no oracle report/);
  assert.doesNotMatch(text, /undefined/);
});

test("renderFightCard prints the oracle verdict and confidence", () => {
  const text = renderFightCard({
    tribunal_id: "trib_test",
    domain: "code",
    stages: {},
    oracle: { verdict: ORACLE_VERDICT.VERIFIED, confidence: 0.98, validation_checks: [], caveats: [] },
    battle_report: { summary: "held", total_findings: { p0: 0, p1: 0, p2: 0, p3: 0 }, unresolved_critical: 0 },
  });
  assert.match(text, /VERIFIED/);
  assert.match(text, /98\.0%/);
});

test("renderFightCard reports an aborted run without pretending it completed", () => {
  const text = renderFightCard({ oracle: { verdict: ORACLE_VERDICT.ABORTED, confidence: 0, caveats: [] } });
  assert.match(text, /ABORTED/);
});

test("renderHistoryRow summarises an entry on one line", () => {
  const row = renderHistoryRow({ ts: "2026-10-04T07:15:30.000Z", tribunal_id: "trib_1", verdict: ORACLE_VERDICT.VERIFIED, confidence: 0.97, domain: "code" });
  assert.match(row, /2026-10-04 07:15/);
  assert.match(row, /trib_1/);
  assert.match(row, /VERIFIED/);
  assert.match(row, /97\.0%/);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("buildProposals is one proposal per model, carrying the prompt", () => {
  const proposals = buildProposals({ prompt: "try me", models: ["a", "b"] });
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map((p) => p.model), ["a", "b"]);
  assert.ok(proposals.every((p) => p.approach === "try me"));
  assert.deepEqual(proposals.map((p) => p.id), ["proposal-1", "proposal-2"]);
});

test("buildProposals falls back to one unlabeled proposal", () => {
  const proposals = buildProposals({ prompt: "x", models: [] });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].model, null);
});

test("resolveModels prefers --model, then config, then the gateway", async () => {
  const fromFlag = await resolveModels({ flags: { model: "x,y" }, config: { defaultModel: "z" } });
  assert.deepEqual(fromFlag, ["x", "y"]);

  const fromConfig = await resolveModels({ flags: {}, config: { defaultModel: "z" } });
  assert.deepEqual(fromConfig, ["z"]);

  const fromGateway = await resolveModels({ flags: {}, config: {}, listModels: async () => [{ id: "g1" }, { id: "g2" }] });
  assert.deepEqual(fromGateway, ["g1"]);
});

test("resolveModels survives a gateway that is down", async () => {
  const models = await resolveModels({ flags: {}, config: {}, listModels: async () => { throw new Error("down"); } });
  assert.deepEqual(models, [null]);
});

// ---------------------------------------------------------------------------
// the --tribunal flag contract
// ---------------------------------------------------------------------------

test("--tribunal is a value-taking flag the router will hand to the command", () => {
  assert.ok(valueFlagNames().has("tribunal"));
  const parsed = parseArgv(["--tribunal", "review this"], valueFlagNames());
  assert.equal(parsed.commandName, null);
  assert.equal(parsed.flags.tribunal, "review this");
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test("history is empty before any run, and says so", async () => {
  const dir = scratch();
  const { code, payload, out } = await run(["history"], dir);
  assert.equal(code, 0);
  assert.equal(payload.count, 0);
  assert.match(out.last().text, /no tribunal runs recorded yet/);
});

// ---------------------------------------------------------------------------
// usage errors
// ---------------------------------------------------------------------------

test("run with no proposal is a usage error", async () => {
  const dir = scratch();
  const { code, out } = await run(["run"], dir);
  assert.equal(code, 2);
  assert.match(out.last().text, /nothing to try/);
  assert.match(out.last().text, /aflow tribunal run/);
});

test("an unknown subcommand is a usage error", async () => {
  const dir = scratch();
  const { code, out } = await run(["bogus"], dir);
  assert.equal(code, 2);
  assert.match(out.last().text, /unknown subcommand: bogus/);
});

// ---------------------------------------------------------------------------
// full run
// ---------------------------------------------------------------------------

test("a run prints a fight card, verdicts VERIFIED, and records the run", async () => {
  const dir = scratch();
  const { code, payload, out } = await run(["run", "the proposal"], dir, {
    flags: { model: "mock" },
    deps: tribunalDeps(),
  });

  assert.equal(code, 0);
  assert.equal(payload.oracle.verdict, ORACLE_VERDICT.VERIFIED);
  assert.equal(payload.models.length, 1);
  assert.equal(typeof payload.sessionId, "string");
  assert.match(out.last().text, /TRIBUNAL FIGHT CARD/);
  assert.doesNotMatch(out.last().text, /undefined/);

  // The record lives in the session store, not just the terminal.
  const store = new SessionStore({ dir });
  const session = store.read(payload.sessionId);
  const tribune = session.entries.filter((e) => e.kind === ENTRY_KIND.TRIBUNAL_RUN);
  assert.equal(tribune.length, 1);
  assert.equal(tribune[0].verdict, ORACLE_VERDICT.VERIFIED);
});

test("history lists a run after it happens", async () => {
  const dir = scratch();
  await run(["run", "the proposal"], dir, { flags: { model: "mock" }, deps: tribunalDeps() });

  const { payload, out } = await run(["history"], dir);
  assert.equal(payload.count, 1);
  assert.equal(payload.entries[0].verdict, ORACLE_VERDICT.VERIFIED);
  assert.match(out.last().text, /VERIFIED/);
});

test("a run does not create a blackboard unless asked", async () => {
  const dir = scratch();
  const project = scratch();
  const { payload } = await run(["run", "the proposal"], dir, {
    flags: { model: "mock", project },
    deps: tribunalDeps(),
  });
  assert.equal(payload.decisionId, null);
  assert.equal(new BlackboardStore({ projectRoot: project, dir }).exists(), false);
});

test("--record records the verdict on a (created) blackboard", async () => {
  const dir = scratch();
  const project = scratch();
  const { payload } = await run(["run", "the proposal"], dir, {
    flags: { model: "mock", project, record: true },
    deps: tribunalDeps(),
  });

  assert.equal(typeof payload.decisionId, "string");
  const board = new BlackboardStore({ projectRoot: project, dir });
  assert.equal(board.exists(), true);
  const decisions = board.decisions();
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].title, /VERIFIED/);
});

test("the fight alias runs like tribunal run", async () => {
  const dir = scratch();
  const out = stubOut();
  const returned = await fightCommand.run({
    args: ["the proposal"],
    flags: { "state-dir": dir, model: "mock" },
    config: {},
    out,
    deps: tribunalDeps(),
  });
  assert.notEqual(typeof returned, "number");
  assert.match(out.last().text, /TRIBUNAL FIGHT CARD/);
});

test("the prompt can come from --prompt", async () => {
  const dir = scratch();
  const { code, payload } = await run(["run"], dir, {
    flags: { model: "mock", prompt: "from a flag" },
    deps: tribunalDeps(),
  });
  assert.equal(code, 0);
  assert.equal(payload.oracle.verdict, ORACLE_VERDICT.VERIFIED);
});
