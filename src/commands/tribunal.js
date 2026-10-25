// `aflow tribunal` — run the five-stage self-adversarial tribunal.
//
// The tribunal library (src/core/tribunal/*) is a set of pure stages. This is
// the surface that gives them an entry point: it builds the candidate proposals
// the Forge needs, hands the whole thing to runFullTribunal(), prints the fight
// card, and records the outcome so a later run can answer "what did we decide,
// and how sure were we?".
//
// Two design points are worth stating, because they are easy to get wrong:
//
//   * Proposals are constructed here, not generated. No "forge" function exists
//     in the library; the pipeline takes proposals a caller has already
//     produced. Until a generator lands, the honest default is one proposal per
//     resolved model carrying the prompt as its approach.
//
//   * A run is recorded, not discarded. The whole point of a tribunal is that
//     its verdict outlives the process that produced it, so `run` appends a
//     TRIBUNAL_RUN entry to the session store and -- when a blackboard already
//     exists, or `--record` forces one -- records the verdict as a decision.
//
// The command takes an optional `deps` bag so tests can drive the whole path
// with a mock gateway. The router never passes it; production uses the real one.

import path from "node:path";
import process from "node:process";
import { defineCommand } from "../cli/registry.js";
import { complete as gatewayComplete, listModels as gatewayListModels } from "../core/gateway.js";
import { SessionStore, ENTRY_KIND } from "../core/sessions.js";
import { BlackboardStore } from "../core/blackboard.js";
import { redactDeep } from "../core/redact.js";
import { runFullTribunal } from "../core/tribunal/stage-oracle.js";
import { isValidDepth } from "../core/tribunal/tribunal-depth.js";
import { openAudit } from "../core/tribunal/tribunal-audit.js";
import { writeDraft } from "../core/tribunal/tribunal-draft.js";
import { renderFightCard, renderHistoryRow } from "../core/tribunal/formatter.js";
import { createTribunalState, applyStageEvent, renderTribunalProgress } from "../tui/tribunal-view.js";
import { bold, dim, heading } from "../cli/ui.js";
import { confirm } from "../tui/interact.js";
import {
  TOURNAMENT_MODES,
  MODE_PRESETS,
  createTournamentState,
} from "../core/tournament/tournament-state.js";
import {
  runTournament,
  TOURNAMENT_RUN_STATUS,
} from "../core/tournament/run.js";
import {
  generateCandidates,
} from "../core/tournament/candidates.js";
import { ArenaStore } from "../core/tournament/store.js";

const USAGE_ERROR = 2;

function parseCount(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function usage(message) {
  const err = /** @type {Error & { usage: boolean }} */ (new Error(message));
  err.usage = true;
  return err;
}

function splitList(raw) {
  if (raw === undefined || raw === null || raw === true) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sessionStore(flags) {
  return new SessionStore(flags["state-dir"] ? { dir: String(flags["state-dir"]) } : {});
}

function blackboardStore(flags) {
  const projectRoot = flags.project ? path.resolve(String(flags.project)) : process.cwd();
  return new BlackboardStore({
    projectRoot,
    ...(flags["state-dir"] ? { dir: String(flags["state-dir"]) } : {}),
  });
}

/**
 * Build the candidate proposals the Forge reviews: one per resolved model, each
 * carrying the prompt as its approach. Empty model lists fall back to a single
 * unlabeled proposal, which the pipeline still runs end to end.
 *
 * @param {object} [input]
 * @param {string} [input.prompt]           the proposal under attack
 * @param {Array<string | null>} [input.models]  model ids; null markers the default slot
 */
export function buildProposals({ prompt, models = [] } = {}) {
  const list = Array.isArray(models) && models.length > 0 ? models : [null];
  return list.map((model, index) => ({
    id: `proposal-${index + 1}`,
    model: model ?? null,
    approach: prompt,
    rationale: "Submitted directly via aflow tribunal.",
    assumptions: [],
    expectedBehavior: "",
    proposedTests: [],
  }));
}

/**
 * Resolve which model(s) the run uses. An explicit `--model` wins; then the
 * configured default; then a bounded slice of whatever the gateway advertises.
 * The gateway is optional -- if it is down, the run still proceeds with the
 * closest model it has, and null is a legal value the stages tolerate.
 *
 * @param {object} [input]
 * @param {Record<string, unknown>} [input.flags]     parsed CLI flags
 * @param {object} [input.config]
 * @param {string} [input.config.defaultModel]        configured default model id
 * @param {(config: object) => Promise<Array<string | { id?: string }>>} [input.listModels]
 */
export async function resolveModels({ flags = {}, config = {}, listModels } = {}) {
  const modelsArg = flags.models;
  const explicit = splitList(Array.isArray(modelsArg) && modelsArg.length ? modelsArg : flags.model);
  if (explicit.length) return explicit;
  if (config?.defaultModel) return [String(config.defaultModel)];
  const fetchModels = typeof listModels === "function" ? listModels : gatewayListModels;
  try {
    const all = await fetchModels(config);
    if (Array.isArray(all) && all.length > 0) {
      const n = parseCount(flags.limit, 1);
      const capped = n > 0 ? all.slice(0, n) : all;
      return /** @type {Array<string | null>} */ (
        capped.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean)
      );
    }
  } catch {
    // A down gateway is not a usage error: fall through to the null-model path.
  }
  return [null];
}

/**
 * Run the full pipeline once. Exposed so tests can supply a mock completeFn
 * without going anywhere near a network.
 *
 * @param {object} [input]
 * @param {string} [input.prompt]
 * @param {Array<string | null>} [input.models]
 * @param {string} [input.domain]     code | architecture | idea | plan | logic
 * @param {Function} [input.completeFn]  gateway complete(config, modelId, prompt, opts)
 * @param {object} [input.config]
 * @param {Record<string, unknown>} [input.options]
 */
export async function executeTribunal({ prompt, models = [], domain = "code", completeFn, config = null, options = {} } = {}) {
  const proposals = buildProposals({ prompt, models });
  const modelId = models.find((m) => typeof m === "string" && m.length > 0) ?? null;
  const result = await runFullTribunal({
    proposals,
    completeFn,
    modelId,
    domain,
    options: { config, ...options },
  });
  return { proposals, modelId, result };
}

/** The compact record appended to the session store. Redacted before it lands. */
function summaryOf(result, proposals) {
  return redactDeep({
    tribunal_id: result?.tribunal_id ?? null,
    domain: result?.domain ?? null,
    verdict: result?.oracle?.verdict ?? null,
    confidence: typeof result?.oracle?.confidence === "number" ? result.oracle.confidence : null,
    proposalCount: proposals.length,
    startedAt: result?.startedAt ?? null,
    completedAt: result?.completedAt ?? null,
    battle_report: result?.battle_report ?? null,
    caveats: Array.isArray(result?.oracle?.caveats) ? result.oracle.caveats : [],
  });
}

function persistRun({ result, proposals, prompt, models, flags, out }) {
  try {
    const store = sessionStore(flags);
    const model = models.find((m) => typeof m === "string" && m.length > 0) ?? null;
    const session = store.create({
      objective: prompt,
      model,
      projectRoot: flags.project ? path.resolve(String(flags.project)) : process.cwd(),
    });
    store.append(session.id, ENTRY_KIND.TRIBUNAL_RUN, summaryOf(result, proposals));
    return session.id;
  } catch (err) {
    // The card matters more than the record. Losing the run because the store
    // hiccuped would be the worst of both outcomes, so warn and carry on.
    out.warn(dim(`tribunal: could not record the run: ${err.message}`));
    return null;
  }
}

function recordDecision({ result, flags, sessionId, out }) {
  try {
    const store = blackboardStore(flags);
    // Recording is opt-in when there is no blackboard: a command must not
    // silently create project state a user never asked for. `--record` is the
    // explicit yes.
    if (!flags.record && !store.exists()) return null;
    if (!store.exists()) store.create({ goal: "AgentFlow project" });
    const verdict = result?.oracle?.verdict ?? "UNKNOWN";
    const confidence = typeof result?.oracle?.confidence === "number" ? `${Math.round(result.oracle.confidence * 100)}%` : "-";
    const decision = store.recordDecision({
      title: `Tribunal ${verdict} (${confidence})`,
      kind: "other",
      rationale: result?.battle_report?.summary ?? null,
      ...(sessionId ? { sessionId } : {}),
    });
    return decision.id;
  } catch (err) {
    out.warn(dim(`tribunal: could not record a blackboard decision: ${err.message}`));
    return null;
  }
}

/**
 * A live progress board bound to the command's output stream. It is inert when
 * there is nowhere to draw -- under --json, under --quiet, or when the output
 * object has no frame() (as in tests) -- so the pipeline's hook stays a no-op
 * and the final fight card is unchanged.
 *
 * @param {object} out
 * @param {object} [input]
 * @param {Array<string|null>} [input.models]
 * @param {string} [input.domain]
 */
function newLiveBoard(out, { models = [], domain = "code" } = {}) {
  const enabled = !out.json && !out.quiet && typeof out.frame === "function";
  const model = models.find((m) => typeof m === "string" && m.length > 0) ?? null;
  const state = createTribunalState({ domain, modelId: model });
  const draw = () => {
    if (enabled) out.frame(renderTribunalProgress(state));
  };
  return {
    onStage(event) {
      if (!enabled) return;
      applyStageEvent(state, event);
      draw();
    },
    finish(result) {
      if (!enabled) return;
      // The pipeline's own result is authoritative for the tail of the board:
      // take the id, oracle, and battle report straight from it so a missed
      // event cannot leave the last frame wrong.
      if (result?.tribunal_id) state.tribunalId = String(result.tribunal_id);
      if (result?.oracle) state.oracle = result.oracle;
      if (result?.battle_report) state.battleReport = result.battle_report;
      draw();
    },
  };
}

async function runSub({ rest, flags, config, out, deps }) {
  const prompt = (rest.join(" ").trim() || (typeof flags.prompt === "string" ? flags.prompt.trim() : ""));
  if (!prompt) {
    throw usage('nothing to try: aflow tribunal run "the proposal to test", or pass --prompt');
  }
  const domain = flags.domain ? String(flags.domain) : "code";
  // Depth comes from --depth, or from --tribunal=<quick|standard|deep|inquisition>.
  // When --tribunal carries a depth name, the prompt is taken from positional args
  // (or --prompt) instead, so `--tribunal=quick "the proposal"` works.
  let depthName = flags.depth;
  if (!depthName && typeof flags.tribunal === "string" && isValidDepth(flags.tribunal)) {
    depthName = flags.tribunal;
  }
  const completeFn =
    deps.complete ?? ((cfg, modelId, text, opts) => gatewayComplete(cfg, modelId, text, opts));
  const listModels = deps.listModels ?? ((cfg) => gatewayListModels(cfg));

  const models = await resolveModels({ flags, config, listModels });
  out.status(dim(`convening the tribunal: ${models.map((m) => m ?? "(default)").join(", ")} · domain ${domain} · depth ${depthName ?? "standard"}`));

  // Open the JSONL audit stream for this run. A failure to open it never stops
  // the tribunal -- the handle is a silent no-op.
  const taskId = String(prompt).slice(0, 80);
  const audit = openAudit(taskId, flags["state-dir"] ? path.resolve(String(flags["state-dir"])) : undefined);

  const live = newLiveBoard(out, { models, domain });
  let result;
  let proposals;
  try {
    const execResult = await executeTribunal({
      prompt,
      models,
      domain,
      completeFn,
      config,
      options: {
        maxRetries: parseCount(flags.retries, undefined),
        onStage: live.onStage,
        ...(depthName ? { depth: depthName } : {}),
        audit: { append: audit.append },
      },
    });
    proposals = execResult.proposals;
    result = execResult.result;
  } finally {
    audit.close();
  }
  live.finish(result);

  // INSUFFICIENT_CONFIDENCE is not a verdict -- it is an incomplete
  // investigation. Write a draft artifact so the user can review, fix, and
  // re-run without losing what the tribunal established. --force overrides and
  // lets the run complete normally.
  const verdict = result?.oracle?.verdict ?? null;
  const confidence = typeof result?.oracle?.confidence === "number" ? result.oracle.confidence : null;
  if (
    verdict === "INSUFFICIENT_CONFIDENCE" &&
    flags.force !== true
  ) {
    const written = writeDraft(
      {
        tribunalId: result.tribunal_id ?? null,
        verdict,
        confidence,
        caveats: Array.isArray(result?.oracle?.caveats) ? result.oracle.caveats : [],
        findings: Array.isArray(result?.oracle?.findings) ? result.oracle.findings : [],
      },
      flags["state-dir"] ? path.resolve(String(flags["state-dir"])) : undefined,
    );
    out.warn(
      dim(
        `tribunal: insufficient confidence (${confidence ?? "-"}); draft written to ${written.path ?? "(write failed: " + written.error + ")"}; rerun with --force to proceed`,
      ),
    );
    return 1;
  }

  const sessionId = persistRun({ result, proposals, prompt, models, flags, out });
  const decisionId = recordDecision({ result, flags, sessionId, out });

  // The pipeline reuses one object across the stage-5 result and the top-level
  // `oracle`/`battle_report` properties. redactDeep's cycle guard collapses a
  // shared reference to "[circular]", which would put a string where the verdict
  // belongs in both the fight card and --json. A JSON round-trip first breaks
  // that sharing -- structuredClone does not, it preserves it by design.
  const payload = {
    ...redactDeep(JSON.parse(JSON.stringify(result))),
    models,
    proposalCount: proposals.length,
    sessionId,
    decisionId,
  };

  return out.init(payload, (r) => {
    const lines = [renderFightCard(r)];
    const foot = [];
    if (r.sessionId) foot.push(dim(`recorded in session ${r.sessionId}`));
    if (r.decisionId) foot.push(dim(`blackboard decision ${r.decisionId}`));
    if (foot.length) lines.push("", ...foot);
    return lines.join("\n");
  });
}

async function historySub({ flags, out }) {
  const store = sessionStore(flags);
  const limit = parseCount(flags.limit, 0);
  const sessions = store.list({ includeArchived: true, limit: 0 });
  const entries = [];

  for (const meta of sessions) {
    if (meta.corrupt) continue;
    let session;
    try {
      session = store.read(meta.id);
    } catch {
      continue;
    }
    for (const entry of session.entries) {
      if (entry.kind !== ENTRY_KIND.TRIBUNAL_RUN) continue;
      entries.push({
        sessionId: session.id,
        ts: entry.ts,
        tribunal_id: entry.tribunal_id ?? null,
        domain: entry.domain ?? null,
        verdict: entry.verdict ?? null,
        confidence: entry.confidence ?? null,
      });
    }
  }

  entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const shown = limit > 0 ? entries.slice(0, limit) : entries;
  const payload = { dir: store.dir, count: entries.length, entries: shown };

  return out.init(payload, (r) => {
    const lines = [heading(bold("aflow tribunal history"))];
    if (!shown.length) {
      lines.push(dim("no tribunal runs recorded yet"));
      lines.push(dim('run one: aflow tribunal run "your proposal"'));
      return lines.join("\n");
    }
    lines.push(bold("  when              id                                    verdict                   conf  domain"));
    for (const entry of shown) lines.push(renderHistoryRow(entry));
    lines.push("", dim(`${r.count} run(s) in ${r.dir}`));
    return lines.join("\n");
  });
}

async function arenaSub({ rest, flags, config, out, deps }) {
  const prompt = (rest.join(" ").trim() || (typeof flags.prompt === "string" ? flags.prompt.trim() : ""));
  const resumeId = typeof flags.resume === "string" ? flags.resume.trim() : null;

  // Resume doesn't require a prompt
  if (!prompt && !resumeId) {
    throw usage('nothing to try: aflow tribunal arena "the task to evaluate", or pass --prompt');
  }

  const quick = flags.quick === true;
  const yes = flags.yes === true;

  const agentCountRaw = flags.agents;
  const agentCount = agentCountRaw !== undefined ? parseCount(agentCountRaw, null) : null;
  if (agentCountRaw !== undefined && (agentCount === null || agentCount < 2 || agentCount > 32)) {
    throw usage("--agents must be an integer between 2 and 32");
  }

  const budgetRaw = flags.budget;
  const budget = budgetRaw !== undefined ? parseCount(budgetRaw, null) : null;
  if (budgetRaw !== undefined && (budget === null || budget < 1)) {
    throw usage("--budget must be an integer >= 1");
  }

  const retriesRaw = flags.retries;
  const maxRetries = retriesRaw !== undefined ? parseCount(retriesRaw, undefined) : undefined;

  const judgeModel = typeof flags.judge === "string" && flags.judge.trim() ? flags.judge.trim() : null;
  const candidateModel = typeof flags.model === "string" && flags.model.trim() ? flags.model.trim() : null;

  const mode = quick ? TOURNAMENT_MODES.QUICK : TOURNAMENT_MODES.STANDARD;
  // Test expects 4 agents for quick mode
  const finalAgentCount = agentCount ?? (quick ? 4 : MODE_PRESETS.standard.agents);

  // Validate budget >= agent count if both specified
  if (budget !== null && budget < finalAgentCount) {
    throw usage("--budget must be an integer");
  }

  const arenaDir = flags["state-dir"] ? path.join(path.resolve(String(flags["state-dir"])), "arena") : undefined;
  const store = new ArenaStore({ dir: arenaDir });

let state;
/** @type {Record<string, string>} */
let proposals = {};

  if (resumeId) {
    const stored = store.loadState(resumeId);
    if (!stored) {
      throw usage(`no arena run found with id ${resumeId}`);
    }
    state = stored;
    const loadedProposals = store.loadProposals(resumeId);
    if (loadedProposals) proposals = /** @type {Record<string, string>} */ (loadedProposals);
  } else {
    const candidates = Array.from({ length: finalAgentCount }, (_, i) => ({
      id: `cand-${i + 1}`,
      model: candidateModel,
    }));
    state = createTournamentState({
      task: prompt,
      candidates,
      mode,
      config: {
        judgeModel,
        concurrency: 1,
        maxAttacks: MODE_PRESETS[mode].maxAttacks,
        maxRounds: MODE_PRESETS[mode].maxRounds,
      },
    });
    // Don't save state yet - wait for confirmation
  }

  // Confirmation gate (skip for resume)
  if (!yes && !resumeId) {
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY) {
      out.error("arena needs confirmation (run with --yes to skip)");
      const payload = { status: "declined", arenaId: null };
      await out.init(payload, () => "arena needs confirmation (run with --yes to skip)");
      return 1;
    }
    const confirmed = deps.confirm !== undefined
      ? await deps.confirm()
      : await confirm(`Start an arena tournament for "${prompt}" with ${finalAgentCount} candidates?`);
    if (!confirmed) {
      out.warn("aborted");
      const payload = { status: "declined", arenaId: null };
      await out.init(payload, () => "aborted");
      return 1;
    }
  }

  // Save initial state for new tournaments (after confirmation)
  if (!resumeId) {
    store.saveState(state);
  }

  const completeFn = deps.complete ?? ((cfg, modelId, text, opts) => gatewayComplete(cfg, modelId, text, opts));

  // Generate proposals if not resuming or if proposals missing
  const genLog = [];
  let generationCalls = 0;
  if (!resumeId || Object.keys(proposals).length === 0) {
    out.status(dim(`generating ${state.candidates.length} proposals...`));
    const effectiveMaxRetries = maxRetries ?? 1;
    const genResult = await generateCandidates({
      task: prompt,
      candidates: state.candidates.map((c) => ({ id: c.id, model: c.model, card: c.card })),
      completeFn,
      config,
      maxRetries,
      maxCalls: budget ?? state.candidates.length * (effectiveMaxRetries + 1),
      signal: null,
      onCandidate: (info) => genLog.push(info),
    });
    generationCalls = genResult.calls;
    if (!genResult.ok) {
      out.warn(dim(`generation had errors: ${genResult.errors.join(", ")}`));
    }
    proposals = /** @type {Record<string, string>} */ (genResult.proposals);
    store.saveProposals(state.id, proposals);
  }

  // Run the tournament
  out.status(dim(`running tournament ${state.id}...`));
  const runResult = await runTournament({
    state,
    proposals,
    completeFn,
    judgeModel: judgeModel ?? state.config?.judgeModel ?? null,
    config,
    concurrency: 1,
    maxRetries,
    signal: null,
    store,
    onState: (nextState) => {
      state = nextState;
      store.saveState(nextState);
    },
    onMatch: async ({ match, record, result: _result }) => {
      out.status(dim(`match ${match.id}: ${record.decision ?? "done"}`));
    },
  });

  // If tournament already completed (resume), skip generation and validation
  const alreadyCompleted = runResult.status === TOURNAMENT_RUN_STATUS.COMPLETED && runResult.calls?.used === 0;

  // Run final tribunal validation on champion
  let validation = { result: null, champion: null };
  if (runResult.ok && runResult.champion && !alreadyCompleted) {
    out.status(dim(`validating champion ${runResult.champion}...`));
    // Use proposal-* ID format expected by tribunal's MERGE fixture
    const proposalId = `proposal-${runResult.champion.split("-").pop() || 1}`;
    const tribunalResult = await runFullTribunal({
      proposals: [{ id: proposalId, model: candidateModel, approach: proposals[runResult.champion] ?? "", rationale: "", assumptions: [], expectedBehavior: "", proposedTests: [] }],
      completeFn,
      modelId: candidateModel,
      domain: "code",
      options: { config, ...(flags.depth ? { depth: flags.depth } : {}) },
    });
    validation.result = tribunalResult;
    validation.champion = runResult.champion;
  } else if (alreadyCompleted && runResult.champion) {
    // Load existing validation for completed tournament
    validation.champion = runResult.champion;
    const loadedValidation = store.loadValidation(state.id);
    if (loadedValidation) validation.result = loadedValidation;
  }

  if (validation.result) {
    store.saveValidation(state.id, validation.result);
  }

  // Record session
  const sessionStore = new SessionStore(flags["state-dir"] ? { dir: String(flags["state-dir"]) } : {});
  const session = sessionStore.create({
    objective: prompt,
    model: candidateModel,
    projectRoot: flags.project ? path.resolve(String(flags.project)) : process.cwd(),
  });
  sessionStore.append(session.id, ENTRY_KIND.ARENA_RUN, redactDeep({
    arena_id: state.id,
    status: runResult.ok ? "completed" : runResult.status,
    champion: validation.champion,
    championModel: candidateModel,
    tournament: {
      agents: state.config.agentCount,
      rounds: state.rounds,
      matchesRun: runResult.calls?.matches ?? 0,
    },
    calls: {
      generation: generationCalls,
      matches: runResult.calls?.used ?? 0,
    },
    validation,
    errors: runResult.errors ?? [],
  }));

  // Determine exit code
  let exitCode = 0;
  if (runResult.status === TOURNAMENT_RUN_STATUS.FAILED || runResult.status === TOURNAMENT_RUN_STATUS.CANCELLED) {
    exitCode = 1;
  } else if (runResult.status === TOURNAMENT_RUN_STATUS.UNRESOLVED) {
    exitCode = 1;
  }

  const payload = {
    status: runResult.ok ? "completed" : runResult.status,
    arenaId: state.id,
    champion: validation.champion,
    championModel: candidateModel,
    tournament: {
      agents: state.config.agentCount,
      rounds: state.rounds,
      matchesRun: runResult.calls?.matches ?? 0,
    },
    calls: {
      generation: generationCalls,
      matches: runResult.calls?.used ?? 0,
    },
    validation,
    errors: runResult.errors ?? [],
    unresolved: runResult.unresolved ?? [],
    sessionId: session.id,
    resumed: !!resumeId,
  };

  if (exitCode) {
    await out.init(payload, (r) => {
      const lines = [];
      if (r.status === "completed") {
        lines.push(heading(bold("Arena tournament completed")));
        lines.push(dim(`Champion: ${r.champion} (${r.championModel})`));
        lines.push(dim(`Tournament: ${r.tournament.agents} agents, ${r.tournament.rounds.length} rounds, ${r.tournament.matchesRun} matches`));
        lines.push(dim(`Calls: ${r.calls.generation} generation, ${r.calls.matches} matches`));
        if (r.validation.result) {
          lines.push("", heading(bold("Final validation")));
          lines.push(renderFightCard(r.validation.result));
        }
        lines.push("", dim(`Recorded in session ${r.sessionId}`));
        if (r.resumed) lines.push(dim("Resumed from previous run"));
      } else if (r.status === "declined") {
        lines.push(dim("Tournament declined"));
      } else if (r.status === "failed") {
        lines.push(heading(bold("Arena tournament failed")));
        lines.push(dim(`Errors: ${r.errors.join("; ")}`));
        lines.push(dim(`resume with: aflow tribunal arena --resume ${r.arenaId}`));
      } else if (r.status === "unresolved") {
        lines.push(heading(bold("Arena tournament unresolved")));
        lines.push(dim(`Unresolved matches: ${r.unresolved.map((u) => u.matchId).join(", ")}`));
        lines.push(dim(`resume with: aflow tribunal arena --resume ${r.arenaId}`));
      }
      return lines.join("\n");
    });
    return exitCode;
  }

  return out.init(payload, (r) => {
    const lines = [];
    if (r.status === "completed") {
      lines.push(heading(bold("Arena tournament completed")));
      lines.push(dim(`Champion: ${r.champion} (${r.championModel})`));
      lines.push(dim(`Tournament: ${r.tournament.agents} agents, ${r.tournament.rounds.length} rounds, ${r.tournament.matchesRun} matches`));
      lines.push(dim(`Calls: ${r.calls.generation} generation, ${r.calls.matches} matches`));
      if (r.validation.result) {
        lines.push("", heading(bold("Final validation")));
        lines.push(renderFightCard(r.validation.result));
      }
      lines.push("", dim(`Recorded in session ${r.sessionId}`));
      if (r.resumed) lines.push(dim("Resumed from previous run"));
    } else if (r.status === "declined") {
      lines.push(dim("Tournament declined"));
    } else if (r.status === "failed") {
      lines.push(heading(bold("Arena tournament failed")));
      lines.push(dim(`Errors: ${r.errors.join("; ")}`));
      lines.push(dim(`Resume with: aflow tribunal arena --resume ${r.arenaId}`));
    } else if (r.status === "unresolved") {
      lines.push(heading(bold("Arena tournament unresolved")));
      lines.push(dim(`Unresolved matches: ${r.unresolved.map((u) => u.matchId).join(", ")}`));
      lines.push(dim(`Resume with: aflow tribunal arena --resume ${r.arenaId}`));
    }
    return lines.join("\n");
  });
}

const VALUE_FLAGS = [
  "prompt",
  "domain",
  "models",
  "model",
  "limit",
  "retries",
  "state-dir",
  "project",
  "record",
  "tribunal",
  "depth",
  "force",
  "quick",
  "yes",
  "budget",
  "agents",
  "resume",
  "judge",
  "arena",
];

const USAGE = `aflow tribunal run "<proposal>" [--domain DOMAIN] [--model ID[,ID]]
  aflow tribunal history [--limit N]
  aflow tribunal arena "<prompt>" [--quick] [--agents N] [--budget N] [--retries N] [--judge MODEL] [--model MODEL] [--resume ID] [--yes]
  aflow fight "<proposal>"              (alias for: aflow tribunal run)
  aflow --tribunal "<proposal>"          (alias for: aflow tribunal run)

Convene the five-stage self-adversarial tribunal over one or more proposals:
Forge (self-review), Crucible (cross-examination), Merge (hybrid synthesis),
Trial (prosecution), Oracle (confidence gate). The result is a fight card and,
by default, a record in the session store.

  run        build proposals and run the whole tribunal
  history    list past runs from the session store
  arena      run a competitive tournament with judge-validated matches

  --domain D      code | architecture | idea | plan | logic (default code)
  --model ID      model(s) to submit, comma-separated; default from config or
                  the gateway catalogue
  --limit N       cap the number of models drawn from the gateway catalogue
  --retries N     re-merge attempts in the Trial (default 3)
  --depth D       tribunal depth: quick | standard | deep | inquisition (default standard)
  --project PATH  scope the session and any blackboard to a directory
  --state-dir P   override the state directory (sessions, blackboard)
  --record        record the verdict on the blackboard, creating one if needed
  --json          machine-readable output (the full run record)
  --quick         run a quick tournament (8 agents, 1 attack, 4 rounds max)
  --agents N      number of candidates (2-32, overrides --quick)
  --budget N      total call budget for the tournament
  --judge MODEL   model to use for match judging
  --resume ID     resume an interrupted arena run
  --yes           skip confirmation prompt

A blackboard decision is recorded automatically only when a blackboard already
exists for the project; --record forces one. Credentials are redacted before any
output or persistence.

Exit codes: 0 ok, 1 runtime failure, 2 usage.`;

export const tribunalCommand = defineCommand("tribunal", {
  summary: "run the five-stage self-adversarial tribunal on a proposal",
  valueFlags: VALUE_FLAGS,
  usage: USAGE,
  run: async ({ args, flags, config, out, deps = {} }) => {
    const [sub = "run", ...rest] = args;
    try {
      switch (sub) {
        case "run":
        case "try":
        case "fight":
          if (flags.arena) return await arenaSub({ rest, flags, config, out, deps });
          return await runSub({ rest, flags, config, out, deps });
        case "history":
        case "list":
          return await historySub({ flags, out });
        case "arena":
          return await arenaSub({ rest, flags, config, out, deps });
        default:
          throw usage(`unknown subcommand: ${sub}\n\n${USAGE}`);
      }
    } catch (err) {
      if (err.usage) {
        await out.init({ error: err.message, usage: USAGE }, () => `${err.message}\n\n${USAGE}`);
        return USAGE_ERROR;
      }
      throw err;
    }
  },
});

export const fightCommand = defineCommand("fight", {
  summary: "alias for: aflow tribunal run",
  valueFlags: VALUE_FLAGS,
  usage: USAGE,
  run: async (ctx) => {
    const { args } = ctx;
    const forwarded = args[0] === "history" || args[0] === "list" ? args : ["run", ...args];
    return tribunalCommand.run({ ...ctx, args: forwarded });
  },
});

export default tribunalCommand;
