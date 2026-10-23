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
import readline from "node:readline/promises";
import { defineCommand } from "../cli/registry.js";
import { complete as gatewayComplete, listModels as gatewayListModels } from "../core/gateway.js";
import { SessionStore, ENTRY_KIND } from "../core/sessions.js";
import { BlackboardStore } from "../core/blackboard.js";
import { redactDeep } from "../core/redact.js";
import { runFullTribunal } from "../core/tribunal/stage-oracle.js";
import { renderFightCard, renderHistoryRow } from "../core/tribunal/formatter.js";
import { createTribunalState, applyStageEvent, renderTribunalProgress } from "../tui/tribunal-view.js";
import { bold, dim, heading } from "../cli/ui.js";
import {
  CANDIDATE_STATUS,
  MODE_PRESETS,
  TOURNAMENT_MODES,
  TOURNAMENT_STATUS,
  createTournamentState,
} from "../core/tournament/tournament-state.js";
import { ArenaStore, defaultArenaDir } from "../core/tournament/store.js";
import { generateCandidates } from "../core/tournament/candidates.js";
import {
  BASE_MATCH_CALLS,
  DEFAULT_MAX_CALLS,
  estimateTournamentCalls,
} from "../core/tournament/match.js";
import { clampConcurrency, runTournament, summarizeRun } from "../core/tournament/run.js";

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
  const completeFn =
    deps.complete ?? ((cfg, modelId, text, opts) => gatewayComplete(cfg, modelId, text, opts));
  const listModels = deps.listModels ?? ((cfg) => gatewayListModels(cfg));

  const models = await resolveModels({ flags, config, listModels });
  out.status(dim(`convening the tribunal: ${models.map((m) => m ?? "(default)").join(", ")} · domain ${domain}`));

  const live = newLiveBoard(out, { models, domain });
  const { proposals, result } = await executeTribunal({
    prompt,
    models,
    domain,
    completeFn,
    config,
    options: { maxRetries: parseCount(flags.retries, undefined), onStage: live.onStage },
  });
  live.finish(result);

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

// ---------------------------------------------------------------------------
// Arena
//
// Arena is the opt-in competitive tier: N candidates get strategy cards, fight
// single-elimination matches (attack / defend / revise / judge), and only the
// champion goes through the five-stage tribunal. Everything below is the CLI
// surface for that -- the bracket itself lives in src/core/tournament/*.
//
// Two rules shape this code:
//
//   * Nothing is spent before confirmation. The estimate is printed first, a
//     non-TTY run refuses without --yes, and a declined prompt makes zero model
//     calls. A tournament is the most expensive thing AgentFlow can do; it must
//     never be the easiest thing to trigger.
//   * Failure is resumable, not retried from zero. State and proposals are
//     persisted before generation, every match is persisted as it finishes, and
//     --resume picks up from there.
// ---------------------------------------------------------------------------

/**
 * Arena state lives beside sessions unless the caller overrides it. `--state-dir`
 * is the one place a user already points at their state; honouring it here
 * keeps a sandbox from writing to the real home directory.
 */
function arenaStore(flags) {
  if (flags["arena-dir"]) return new ArenaStore({ dir: String(flags["arena-dir"]) });
  if (flags["state-dir"]) {
    return new ArenaStore({ dir: path.join(String(flags["state-dir"]), "arena") });
  }
  return new ArenaStore({ dir: defaultArenaDir() });
}

function integerFlag(raw, fallback) {
  if (raw === undefined || raw === null || raw === true) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

function arenaBudget(flags) {
  const budget = integerFlag(flags.budget, DEFAULT_MAX_CALLS);
  if (!Number.isInteger(budget) || budget < BASE_MATCH_CALLS || budget > 100) {
    throw usage(`--budget must be an integer between ${BASE_MATCH_CALLS} and 100 calls per match`);
  }
  return budget;
}

function arenaConcurrency(flags, fallback = 1) {
  const concurrency = integerFlag(flags.concurrency, fallback);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw usage("--concurrency must be a positive integer");
  }
  return clampConcurrency(concurrency);
}

/**
 * Mode, size, and seed, with the same bounds the estimate assumes. `--quick` is
 * the cheap preset: quick mode at four agents rather than the full eight, so a
 * first tournament costs a first-tournament amount.
 *
 * @param {Record<string, unknown>} [flags]
 */
export function parseArenaParams(flags = {}) {
  if (flags.quick && flags.mode && String(flags.mode) !== TOURNAMENT_MODES.QUICK) {
    throw usage("choose either --quick or --mode <quick|standard|intensive>, not both");
  }
  const mode = flags.quick ? TOURNAMENT_MODES.QUICK : String(flags.mode ?? TOURNAMENT_MODES.QUICK);
  if (!Object.values(TOURNAMENT_MODES).includes(/** @type {"quick"|"standard"|"intensive"} */ (mode))) {
    throw usage(`unknown arena mode: ${mode} (expected ${Object.values(TOURNAMENT_MODES).join(", ")})`);
  }
  const preset = MODE_PRESETS[mode];
  const agents = integerFlag(flags.agents, flags.quick ? Math.min(4, preset.agents) : preset.agents);
  if (!Number.isInteger(agents) || agents < 2 || agents > 32) {
    throw usage("--agents must be an integer between 2 and 32");
  }
  const seed = integerFlag(flags.seed, 0);
  if (!Number.isInteger(seed) || seed < 0) throw usage("--seed must be a non-negative integer");
  return {
    mode,
    agents,
    seed,
    budget: arenaBudget(flags),
    concurrency: arenaConcurrency(flags, 1),
  };
}

/** One candidate per slot, cycling the model pool; cards are dealt by state. *
 * @param {{ agents?: number, models?: Array<string> }} input
 */
export function buildArenaCandidates({ agents, models = [] } = {}) {
  const pool = (Array.isArray(models) ? models : []).filter(
    (model) => typeof model === "string" && model.trim(),
  );
  if (!pool.length) throw usage("arena needs at least one model: pass --model ID");
  return Array.from({ length: agents }, (_, index) => ({
    id: `cand-${index + 1}`,
    model: pool[index % pool.length],
  }));
}

function arenaEstimate({ generation, matches, budget, retries = 1 }) {
  const attempts = Math.max(0, Number(retries) || 0) + 1;
  const generationCeiling = generation * attempts;
  const matchBase = matches * BASE_MATCH_CALLS;
  const matchCeiling = matches * budget;
  return {
    generation,
    generationCeiling,
    matches,
    matchBase,
    matchCeiling,
    base: generation + matchBase,
    ceiling: generationCeiling + matchCeiling,
  };
}

function renderArenaEstimate(estimate, budget) {
  return [
    `arena cost estimate: ${estimate.base} model call(s) minimum, ${estimate.ceiling} at the ceiling`,
    `  ${estimate.generation} proposal call(s) + ${estimate.matches} match(es) x ${BASE_MATCH_CALLS} base calls`,
    `  per-match ceiling: ${budget} calls (retries included)`,
    "  final Trial + Oracle on the champion is additional and variable",
  ].join("\n");
}

/**
 * Ask before spending. `deps.confirm` is the test seam; a real non-TTY process
 * refuses rather than assuming yes, because an unattended arena run is exactly
 * the accident this guard exists to prevent.
 */
async function confirmArena({ flags, deps, message }) {
  if (flags.yes === true) return true;
  if (typeof deps.confirm === "function") return Boolean(await deps.confirm(message));
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message}\nProceed? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function redactedPayload(value) {
  // Break shared references before redaction. summarizeRun() deliberately reuses
  // the run's arrays, and redactDeep collapses a repeated reference to
  // "[circular]" -- which would turn `unresolved` into a string.
  return redactDeep(JSON.parse(JSON.stringify(value)));
}

function renderArenaReport(payload) {
  const lines = [heading(bold("aflow arena")), ""];
  const t = payload.tournament ?? {};
  lines.push(
    `${bold("arena")} ${payload.arenaId} · ${t.mode ?? "?"} · seed ${t.seed ?? 0} · ${t.agents ?? 0} agents`,
  );
  if (payload.status === "completed" && payload.champion) {
    lines.push(
      `${bold("champion")} ${payload.champion}${payload.championModel ? dim(` (${payload.championModel})`) : ""}`,
    );
  } else {
    lines.push(`${bold("status")} ${payload.status}`);
  }

  for (const round of t.rounds ?? []) {
    lines.push("", bold(`round ${round.round}`), dim(`  ${round.entrants} entrant(s)`));
    for (const match of round.matches ?? []) {
      if (match.bye) {
        lines.push(dim(`  ${match.id}  bye -> ${match.a}`));
        continue;
      }
      const winner = match.winner ? bold(match.winner) : dim("pending");
      const verdict = match.verdict ? dim(` [${match.verdict}]`) : "";
      lines.push(`  ${match.id}  ${match.a} vs ${match.b}  -> ${winner}${verdict}`);
    }
  }

  const calls = payload.calls ?? {};
  lines.push(
    "",
    dim(
      `calls this run: ${(calls.generation ?? 0) + (calls.matches ?? 0)} ` +
        `(generation ${calls.generation ?? 0}, matches ${calls.matches ?? 0}; ` +
        `per-match ceiling ${calls.budgetPerMatch ?? "?"})`,
    ),
  );
  if (calls.estimatedBase !== undefined) {
    // Actual usage above; the estimate that was confirmed below. Keeping them
    // separate stops a retry-heavy run from looking like it matched its estimate.
    lines.push(
      dim(
        `estimate at confirmation: ${calls.estimatedBase} minimum, ` +
          `${calls.estimatedCeiling} ceiling`,
      ),
    );
  }

  if (payload.validation?.result) {
    const oracle = payload.validation.result.oracle ?? {};
    const confidence =
      typeof oracle.confidence === "number" ? `${(oracle.confidence * 100).toFixed(1)}%` : "-";
    lines.push(
      "",
      `${bold("final validation")} ${payload.validation.champion} · ${oracle.verdict ?? "UNKNOWN"} (${confidence})`,
      "",
      renderFightCard(payload.validation.result),
    );
  } else if (payload.validationError) {
    lines.push("", dim(`final validation skipped: ${payload.validationError}`));
  }

  if (payload.unresolved?.length) {
    lines.push("", dim(`unresolved: ${payload.unresolved.map((entry) => entry.matchId).join(", ")}`));
  }
  if (payload.errors?.length) {
    lines.push("", dim("errors:"));
    for (const error of payload.errors) lines.push(dim(`  ${error}`));
  }
  if (payload.status !== "completed" && payload.arenaId) {
    lines.push("", dim(`resume with: aflow tribunal arena --resume ${payload.arenaId} --yes`));
  }

  const foot = [];
  if (payload.sessionId) foot.push(dim(`recorded in session ${payload.sessionId}`));
  if (payload.decisionId) foot.push(dim(`blackboard decision ${payload.decisionId}`));
  foot.push(dim(`artifacts: ${payload.arenaDir}`));
  lines.push("", ...foot);
  return lines.join("\n");
}

function persistArenaRun({ state, run, validation, flags, out }) {
  try {
    const store = sessionStore(flags);
    const champion = run?.champion ?? null;
    const championModel =
      (state.candidates ?? []).find((candidate) => candidate.id === champion)?.model ?? null;
    const session = store.create({
      objective: state.task,
      model: championModel,
      projectRoot: flags.project ? path.resolve(String(flags.project)) : process.cwd(),
    });
    store.append(
      session.id,
      ENTRY_KIND.ARENA_RUN,
      redactDeep({
        arena_id: state.id,
        status: run?.status ?? "failed",
        mode: state.config?.mode ?? null,
        seed: state.config?.seed ?? null,
        agents: state.candidates?.length ?? 0,
        champion,
        champion_model: championModel,
        matches_completed: state.progress?.matchesCompleted ?? null,
        calls: run?.calls ?? null,
        validation_verdict: validation?.result?.oracle?.verdict ?? null,
        validation_confidence:
          typeof validation?.result?.oracle?.confidence === "number"
            ? validation.result.oracle.confidence
            : null,
        unresolved: (run?.unresolved ?? []).map((entry) => entry.matchId),
        errors: run?.errors ?? [],
      }),
    );
    return session.id;
  } catch (err) {
    out.warn(dim(`arena: could not record the run: ${err.message}`));
    return null;
  }
}

function recordArenaDecision({ state, run, validation, flags, sessionId, out }) {
  if (!validation) return null;
  try {
    const store = blackboardStore(flags);
    // Same rule as `tribunal run`: never create project state a user did not ask
    // for, unless --record is the explicit yes.
    if (!flags.record && !store.exists()) return null;
    if (!store.exists()) store.create({ goal: "AgentFlow project" });
    const verdict = validation.result?.oracle?.verdict ?? "UNKNOWN";
    const confidence =
      typeof validation.result?.oracle?.confidence === "number"
        ? `${Math.round(validation.result.oracle.confidence * 100)}%`
        : "-";
    const decision = store.recordDecision({
      title: `Arena ${state.id}: ${run?.champion ?? "no champion"} -> Tribunal ${verdict} (${confidence})`,
      kind: "other",
      rationale: validation.result?.battle_report?.summary ?? null,
      ...(sessionId ? { sessionId } : {}),
    });
    return decision.id;
  } catch (err) {
    out.warn(dim(`arena: could not record a blackboard decision: ${err.message}`));
    return null;
  }
}

/**
 * Run the arena sub-command: resolve models, build candidates, run the tournament.
 *
 * @param {{ rest: string[], flags: object, config: object, out: object, deps?: { complete?: (cfg: any, modelId: string, text: string, opts?: any) => Promise<any>, listModels?: (cfg: any) => Promise<(string | { id?: string; })[]> } }} input
 */
async function runArenaSub({ rest, flags, config, out, deps = {} }) {
  const store = arenaStore(flags);
  const completeFn =
    deps.complete ?? ((cfg, modelId, text, opts) => gatewayComplete(cfg, modelId, text, opts));
  const listModels = deps.listModels ?? ((cfg) => gatewayListModels(cfg));
  const domain = flags.domain ? String(flags.domain) : "code";
  const maxRetries = parseCount(flags.retries, undefined);
  const budget = arenaBudget(flags);

  const resumeRaw = flags.resume;
  if (resumeRaw === true || (typeof resumeRaw === "string" && !resumeRaw.trim())) {
    throw usage("--resume needs an arena id (aflow tribunal arena --resume arena_123)");
  }
  const resumeId = resumeRaw == null ? null : String(resumeRaw);
  const taskArg = rest.join(" ").trim() || (typeof flags.prompt === "string" ? flags.prompt.trim() : "");

  let state = null;
  let proposals = {};
  let params = null;
  let models = [];
  let candidates = null;
  // Actual generation calls made by this invocation, retries included. The
  // estimate is reported separately; conflating the two hides retry spend.
  let generationCalls = 0;

  if (resumeId) {
    state = store.loadState(resumeId);
    if (!state) throw usage(`no arena run found with id ${resumeId} in ${store.dir}`);
    proposals = store.loadProposals(state.id) ?? {};
    models = [...new Set((state.candidates ?? []).map((candidate) => candidate.model).filter(Boolean))];
    if (taskArg && taskArg !== state.task) {
      out.warn(dim(`arena: ignoring new task text on resume; continuing "${state.task}"`));
    }
    if (flags.agents !== undefined || flags.mode !== undefined || flags.seed !== undefined) {
      out.warn(dim("arena: --agents/--mode/--seed only apply to a new tournament and were ignored"));
    }
    out.status(dim(`resuming arena ${state.id} (${state.config?.mode ?? "?"}, ${state.candidates?.length ?? 0} agents)`));
  } else {
    if (!taskArg) throw usage('nothing to test: aflow tribunal arena "the task", or pass --prompt');
    params = parseArenaParams(flags);
    models = await resolveModels({ flags, config, listModels });
    candidates = buildArenaCandidates({ agents: params.agents, models });
  }

  const judgeFlag = flags.judge;
  const explicitJudge = typeof judgeFlag === "string" && judgeFlag.trim() ? judgeFlag.trim() : null;
  const recordedJudge =
    typeof state?.config?.judgeModel === "string" && state.config.judgeModel.trim()
      ? state.config.judgeModel
      : null;
  if (state && explicitJudge && recordedJudge && explicitJudge !== recordedJudge) {
    out.warn(
      dim(
        `arena: this tournament was judged by ${recordedJudge}; recorded verdicts keep that judge, ` +
          `remaining or re-judged matches will use ${explicitJudge}`,
      ),
    );
  }
  // On resume the recorded judge wins over the first candidate model: a silent
  // switch would make early and late matches incomparable.
  const judgeModel = explicitJudge ?? recordedJudge ?? models[0] ?? null;
  if (!judgeModel) throw usage("arena needs a judge model: pass --judge ID");
  // Records written before the judge was persisted adopt the model chosen now,
  // so a later resume cannot silently pick a different one.
  if (state && !recordedJudge) {
    state.config.judgeModel = judgeModel;
    store.saveState(state);
  }
  if (models.includes(judgeModel)) {
    out.warn(
      dim(
        `arena: ${judgeModel} also competes in this tournament (self-judging); ` +
          "pass --judge to use an independent model",
      ),
    );
  }

  // What still needs doing? For a new run that is everything; for a resume it is
  // the missing proposals plus whatever the bracket and validation have left.
  const alive =
    state === null
      ? []
      : (state.candidates ?? []).filter(
          (candidate) =>
            candidate.status === CANDIDATE_STATUS.ALIVE ||
            candidate.status === CANDIDATE_STATUS.CHAMPION,
        );
  const missing = state === null ? [] : alive.filter((candidate) => !proposals[candidate.id]);
  const matchesLeft = state === null ? candidates.length - 1 : estimateTournamentCalls(state).matches;
  const validationLeft =
    state !== null &&
    state.status === TOURNAMENT_STATUS.COMPLETED &&
    state.champion &&
    !store.loadValidation(state.id)
      ? 1
      : 0;
  const generationNeeded = state === null ? candidates.length : missing.length;
  const estimate = arenaEstimate({
    generation: generationNeeded,
    matches: matchesLeft,
    budget,
    retries: maxRetries ?? 1,
  });
  const needsWork = estimate.base > 0 || validationLeft > 0;

  if (needsWork) {
    const confirmed = await confirmArena({
      flags,
      deps,
      message: renderArenaEstimate(estimate, budget),
    });
    if (!confirmed) {
      const payload = {
        arenaId: state?.id ?? null,
        arenaDir: store.dir,
        status: "declined",
        champion: null,
        championModel: null,
        tournament: state ? summarizeRun({ status: "declined", state }) : null,
        calls: {
          generation: 0,
          matches: 0,
          budgetPerMatch: budget,
          estimatedBase: estimate.base,
          estimatedCeiling: estimate.ceiling,
        },
        validation: null,
        validationError: null,
        sessionId: null,
        decisionId: null,
        errors: [],
        unresolved: [],
      };
      const declined = redactedPayload(payload);
      // redactDeep masks any key matching session_id; the identifiers are not
      // secrets, so put them back after redaction.
      declined.sessionId = null;
      declined.decisionId = null;
      await out.init(declined, (result) =>
        [
          heading(bold("aflow arena")),
          "",
          "arena not started: this run makes model calls and needs confirmation.",
          dim("re-run with --yes to proceed."),
          "",
          dim(`estimate: ${result.calls.estimatedBase} call(s) minimum, ${result.calls.estimatedCeiling} at the ceiling`),
        ].join("\n"),
      );
      return 1;
    }
  }

  if (state === null) {
    state = createTournamentState({
      task: taskArg,
      candidates,
      mode: /** @type {"quick"|"standard"|"intensive"} */ (params.mode),
      seed: params.seed,
      now: Date.now(),
      config: { concurrency: params.concurrency, paidAllowed: true, judgeModel },
    });
    store.saveState(state);
    out.status(
      dim(
        `arena ${state.id}: ${params.mode}, ${params.agents} agents, seed ${params.seed}`,
      ),
    );
  }

  const concurrency = arenaConcurrency(flags, state.config?.concurrency ?? 1);
  const missingNow = (state.candidates ?? []).filter(
    (candidate) =>
      (candidate.status === CANDIDATE_STATUS.ALIVE ||
        candidate.status === CANDIDATE_STATUS.CHAMPION) &&
      !proposals[candidate.id],
  );
  if (missingNow.length > 0) {
    out.status(dim(`arena ${state.id}: generating ${missingNow.length} missing proposal(s)`));
    const generated = await generateCandidates({
      task: state.task,
      candidates: missingNow.map((candidate) => ({
        id: candidate.id,
        model: candidate.model,
        card: candidate.card,
      })),
      completeFn,
      config,
      maxRetries,
      maxCalls: missingNow.length * ((maxRetries ?? 1) + 1),
      onCandidate: ({ candidateId }) => out.detail(dim(`arena: proposal ready for ${candidateId}`)),
    });
    Object.assign(proposals, generated.proposals);
    generationCalls = generated.calls;
    store.saveProposals(state.id, proposals);
    if (!generated.ok) {
      const run = {
        ok: false,
        status: "failed",
        state,
        champion: null,
        matches: [],
        unresolved: [],
        errors: generated.errors,
        calls: { used: generated.calls, matches: 0 },
      };
      const sessionId = persistArenaRun({ state, run, validation: null, flags, out });
      const payload = redactedPayload({
        arenaId: state.id,
        arenaDir: store.dir,
        resumed: Boolean(resumeId),
        task: state.task,
        status: "failed",
        champion: null,
        championModel: null,
        tournament: summarizeRun(run),
        calls: {
          generation: generated.calls,
          matches: 0,
          budgetPerMatch: budget,
          estimatedBase: estimate.base,
          estimatedCeiling: estimate.ceiling,
        },
        validation: null,
        validationError: null,
        sessionId,
        decisionId: null,
        errors: generated.errors,
        unresolved: [],
      });
      // Identifiers are not secrets, but redactDeep masks any key named
      // session_id; re-attach them after redaction so the record is followable.
      payload.sessionId = sessionId;
      payload.decisionId = null;
      await out.init(payload, renderArenaReport);
      return 1;
    }
  }

  if (Object.keys(proposals).length === 0) {
    throw usage("arena has no proposals to compete; pass --resume with a run that has proposals");
  }

  const run = await runTournament({
    state,
    proposals: /** @type {Record<string, string>} */ (proposals),
    completeFn,
    judgeModel,
    config,
    concurrency,
    maxCallsPerMatch: budget,
    ...(maxRetries === undefined ? {} : { maxRetries }),
    now: () => Date.now(),
    store,
    onMatch: ({ match, record }) => {
      const winner = record?.decision?.winnerId ?? record?.matchResult?.winnerId ?? null;
      const outcome = winner ? ` -> ${winner}` : ` (${record?.status ?? "unknown"})`;
      out.status(dim(`arena ${match.id}: ${record?.status ?? "unknown"}${outcome} · ${record?.calls?.used ?? 0} call(s)`));
    },
  });

  const finalState = run.state ?? state;
  let validation = store.loadValidation(finalState.id);
  let validationFresh = false;
  let validationError = null;

  if (run.ok && run.champion) {
    const championModel =
      (finalState.candidates ?? []).find((candidate) => candidate.id === run.champion)?.model ?? null;
    if (!validation) {
      const proposal = proposals[run.champion];
      if (!proposal) {
        validationError = `champion ${run.champion} has no stored proposal; run final validation manually`;
      } else {
        try {
          const live = newLiveBoard(out, { models: [championModel], domain });
          const executed = await executeTribunal({
            prompt: proposal,
            models: [championModel],
            domain,
            completeFn,
            config,
            options: { maxRetries, onStage: live.onStage },
          });
          live.finish(executed.result);
          validation = {
            champion: run.champion,
            model: championModel,
            at: new Date().toISOString(),
            result: redactDeep(JSON.parse(JSON.stringify(executed.result))),
          };
          store.saveValidation(finalState.id, validation);
          validationFresh = true;
        } catch (err) {
          // The bracket stands even if the final gate fails. Losing the whole
          // report because Trial threw would hide the work that did succeed.
          validationError = err.message;
        }
      }
    } else {
      out.status(dim(`arena ${finalState.id}: reusing recorded Trial/Oracle validation`));
    }
  }

  const sessionId = persistArenaRun({
    state: finalState,
    run,
    validation,
    flags,
    out,
  });
  const decisionId = validationFresh
    ? recordArenaDecision({ state: finalState, run, validation, flags, sessionId, out })
    : null;

  const championModel =
    (finalState.candidates ?? []).find((candidate) => candidate.id === run.champion)?.model ?? null;
  const payload = redactedPayload({
    arenaId: finalState.id,
    arenaDir: store.dir,
    resumed: Boolean(resumeId),
    task: finalState.task,
    status: run.status,
    champion: run.champion ?? null,
    championModel,
    tournament: summarizeRun(run),
    calls: {
      generation: generationCalls,
      matches: run.calls?.used ?? 0,
      budgetPerMatch: budget,
      estimatedBase: estimate.base,
      estimatedCeiling: estimate.ceiling,
    },
    validation,
    validationError,
    sessionId,
    decisionId,
    errors: run.errors ?? [],
    unresolved: run.unresolved ?? [],
  });
  payload.sessionId = sessionId;
  payload.decisionId = decisionId;

  await out.init(payload, renderArenaReport);
  return payload.status === "completed" ? 0 : 1;
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
  "agents",
  "mode",
  "seed",
  "budget",
  "resume",
  "judge",
  "concurrency",
  "arena-dir",
];

const USAGE = `aflow tribunal run "<proposal>" [--domain DOMAIN] [--model ID[,ID]]
  aflow tribunal arena "<task>" [--quick | --mode MODE] [--agents N] [--yes]
  aflow tribunal arena --resume <arena-id> [--yes]
  aflow tribunal history [--limit N]
  aflow fight "<proposal>"              (alias for: aflow tribunal run)
  aflow --tribunal "<proposal>"          (alias for: aflow tribunal run)

Convene the five-stage self-adversarial tribunal over one or more proposals:
Forge (self-review), Crucible (cross-examination), Merge (hybrid synthesis),
Trial (prosecution), Oracle (confidence gate). The result is a fight card and,
by default, a record in the session store.

  run        build proposals and run the whole tribunal
  arena      run a competitive tournament, then validate the champion through
             the full Tribunal (run --arena is the same thing)
  history    list past runs from the session store

  --domain D      code | architecture | idea | plan | logic (default code)
  --model ID      model(s) to submit, comma-separated; default from config or
                  the gateway catalogue
  --limit N       cap the number of models drawn from the gateway catalogue
  --retries N     re-merge attempts in the Trial (default 3); in Arena, the
                  retry budget for generation and match stages
  --project PATH  scope the session and any blackboard to a directory
  --state-dir P   override the state directory (sessions, blackboard, arena)
  --record        record the verdict on the blackboard, creating one if needed
  --json          machine-readable output (the full run record)

Arena flags:
  --quick         quick mode at four agents (the cheapest useful tournament)
  --mode MODE     quick (8) | standard (16) | intensive (32) agents
  --agents N      override the agent count (2-32)
  --seed N        seed for pairing and strategy cards (default 0)
  --budget N      hard per-match call ceiling, retries included (default 12)
  --judge ID      independent judge model; defaults to the first candidate model
  --concurrency N matches run at once (clamped to 1-4, default 1)
  --arena-dir P   override where tournament state and artifacts are stored
  --resume ID     continue an interrupted or unresolved tournament
  --yes           confirm the estimated model spend without prompting

Arena spends money before it produces a fight card: one generation call per
candidate, then seven calls per match (two attacks, two defenses, two revisions,
one judge), plus the final Trial/Oracle. The estimate is printed first and a
non-interactive run refuses unless --yes is passed. Every match is persisted, so
an interrupted run resumes with --resume <id> instead of starting over.

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
          if (flags.arena) return await runArenaSub({ rest, flags, config, out, deps });
          return await runSub({ rest, flags, config, out, deps });
        case "arena":
          return await runArenaSub({ rest, flags, config, out, deps });
        case "history":
        case "list":
          return await historySub({ flags, out });
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
